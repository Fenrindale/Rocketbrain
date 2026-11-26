'use strict';

const path = require('node:path');
const { canonicalText, inventory, sourceKey } = require('./kotlin-rename');
const { inspectKotlinNullability } = require('./kotlin-nullability');
const { cancelled, fail, inside } = require('./workbench-model');

const commandId = 'rocketbrain.kotlinEditor.inspectJavaNullability';

function registerKotlinNullability(vscode, { begin, output }) {
  const collection = vscode.languages.createDiagnosticCollection('rocketbrain-jspecify');
  let revision = 0, review;
  const range = value => new vscode.Range(value.start.line, value.start.character, value.end.line, value.end.character);

  function clear() {
    review = undefined;
    collection.clear();
  }

  function changed(uri) {
    if (review && uri.scheme === 'file' && inside(review.root, uri.fsPath)) clear();
  }

  async function inspect({ document, position, cancellation } = {}) {
    if (!document || document.isClosed || document.isDirty || document.languageId !== 'kotlin' ||
        document.uri.scheme !== 'file' || !position) throw fail('Open a saved Kotlin source and select a Java method call.');
    clear();
    const ticket = ++revision, version = document.version;
    const session = await begin(document, cancellation);
    const root = session.root, files = inventory(root, { resources: true });
    const source = files.get(sourceKey(document.uri.toString()));
    if (!source || !/^src[\\/]main[\\/](?:java|kotlin)[\\/]/u.test(path.relative(root, source.file)) ||
        canonicalText(document.getText()) !== canonicalText(source.text)) {
      throw fail('Choose a saved Kotlin source in the project’s main JVM sources.');
    }
    function check() {
      session.check();
      if (revision !== ticket || document.isClosed || document.isDirty || document.version !== version || cancelled(cancellation)) {
        throw fail('The current Kotlin source changed. Inspect the Java contract again.');
      }
      const live = inventory(root, { resources: true });
      if (live.size !== files.size || [...files].some(([key, value]) => live.get(key)?.sha !== value.sha)) {
        throw fail('The selected Gradle project changed. Inspect the Java contract again.');
      }
      for (const open of vscode.workspace.textDocuments) {
        if (open.isClosed || open.uri.scheme !== 'file' || open.uri.authority || !inside(root, open.uri.fsPath)) continue;
        const snapshot = files.get(sourceKey(open.uri.toString()));
        if (snapshot && (open.isDirty || canonicalText(open.getText()) !== canonicalText(snapshot.text))) {
          throw fail('Save the Java and Kotlin project sources before inspecting their contracts.');
        }
      }
    }
    check();
    const observed = await inspectKotlinNullability({ session, sources: files, source, position,
      cancellation, check });
    check();
    const java = new vscode.Location(vscode.Uri.file(observed.target.file), range(observed.target.range));
    const diagnostics = observed.diagnostics.map(issue => {
      const entry = new vscode.Diagnostic(range(issue.range), issue.message, vscode.DiagnosticSeverity.Error);
      entry.source = 'Rocketbrain JSpecify';
      entry.code = issue.code;
      entry.relatedInformation = [new vscode.DiagnosticRelatedInformation(java,
        observed.target.owner + '#' + observed.target.signature)];
      return entry;
    });
    collection.set(document.uri, diagnostics);
    const { validate, ...display } = observed;
    const result = { ...display, sourceUri: document.uri.toString() };
    review = { root, result, validate, check, target: { file: observed.target.file, range: structuredClone(observed.target.range) } };
    return result;
  }

  async function openJava(result) {
    const previous = review;
    if (!previous || previous.result !== result) throw fail('Inspect the current Java contract before opening its declaration.');
    await previous.validate();
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(previous.target.file));
    previous.check();
    if (review !== previous || document.isClosed || document.isDirty) {
      throw fail('The reviewed Java declaration changed. Inspect the Java contract again.');
    }
    return vscode.window.showTextDocument(document, { selection: range(previous.target.range), preview: true });
  }

  const command = vscode.commands.registerCommand(commandId, async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    try {
      const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
        title: 'Inspect Java Nullability in Kotlin', cancellable: true }, (_progress, cancellation) =>
        inspect({ document: editor.document, position: editor.selection.active, cancellation }));
      const detail = result.diagnostics.length
        ? result.diagnostics.length + ' Kotlin compiler diagnostics linked to this Java method.'
        : 'The Kotlin compiler found no JSpecify mismatch for this call.';
      if (await vscode.window.showInformationMessage(detail, 'Open Java Declaration') === 'Open Java Declaration') {
        return await openJava(result);
      }
      return result;
    } catch (error) {
      output.appendLine(error.message);
      void vscode.window.showErrorMessage('Rocketbrain Kotlin: ' + error.message);
    }
  });
  const watcher = vscode.workspace.createFileSystemWatcher('**/{*.java,*.kt,*.gradle,*.gradle.kts,gradle.properties,libs.versions.toml}');
  const subscriptions = [collection, command, watcher,
    watcher.onDidChange(changed), watcher.onDidCreate(changed), watcher.onDidDelete(changed),
    vscode.workspace.onDidChangeTextDocument(event => changed(event.document.uri))];
  return { inspect, openJava, clear, dispose() { clear(); for (const item of subscriptions) item.dispose(); } };
}

module.exports = { registerKotlinNullability, commandId };
