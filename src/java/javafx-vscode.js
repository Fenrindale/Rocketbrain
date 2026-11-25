'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { readFxml, resolveFxmlFile } = require('./javafx-fxml');
const { workspacePath, workspaceRoots } = require('./workbench-model');
const { buildSpec, nativeTaskRunner } = require('./workbench-tasks');

function registerJavaFx(vscode, { java }) {
  const selector = { scheme: 'file', pattern: '**/*.fxml' };
  const diagnostics = vscode.languages.createDiagnosticCollection('rocketbrain-fxml');
  const tasks = nativeTaskRunner(vscode);
  const disposables = [diagnostics];

  function root(document) {
    if (!vscode.workspace.isTrusted || document.uri.scheme !== 'file') return null;
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    return folder ? workspaceRoots([folder])[0] : null;
  }

  function status(document) {
    if (!document.fileName.endsWith('.fxml') || !root(document)) return;
    try {
      diagnostics.set(document.uri, readFxml(document.getText()).diagnostics.map(record =>
        new vscode.Diagnostic(span(document, record), record.message, vscode.DiagnosticSeverity.Warning)));
    } catch (error) {
      const line = Math.max(0, Math.min(document.lineCount - 1, (Number(/^(\d+):/.exec(error.message)?.[1]) || 1) - 1));
      diagnostics.set(document.uri, [new vscode.Diagnostic(document.lineAt(line).range, error.message)]);
    }
  }

  function span(document, item) {
    return new vscode.Range(document.positionAt(item.start), document.positionAt(item.end));
  }

  async function definitions(document, position, token) {
    const workspaceRoot = root(document);
    if (!workspaceRoot || token?.isCancellationRequested) return [];
    const version = document.version;
    const offset = document.offsetAt(position);
    let data;
    try { data = readFxml(document.getText()); } catch { return []; }
    const reference = data.references.find(item => item.start <= offset && offset < item.end);
    if (!reference) return [];
    const filename = resolveFxmlFile({ filename: document.fileName, workspaceRoot, reference, controller: data.controller });
    if (!filename) return [];
    const uri = vscode.Uri.file(filename);
    if (reference.kind === 'include' || reference.kind === 'resource') {
      return [new vscode.Location(uri, new vscode.Position(0, 0))];
    }
    await java.start();
    if (token?.isCancellationRequested || document.version !== version || !root(document)) return [];
    await vscode.workspace.openTextDocument(uri);
    const symbols = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', uri);
    if (token?.isCancellationRequested || document.version !== version || !root(document)) return [];
    const typeName = data.controller.value.split('.').at(-1);
    const type = (symbols || []).find(symbol => symbol.kind === vscode.SymbolKind.Class && symbol.name === typeName);
    if (!type) return [];
    const candidates = reference.kind === 'controller' ? [type] : (type.children || []).filter(symbol =>
      reference.kind === 'handler' ? symbol.kind === vscode.SymbolKind.Method && symbol.name.split('(')[0] === reference.value :
        symbol.kind === vscode.SymbolKind.Field && symbol.name === reference.value);
    return candidates.filter(symbol => symbol.selectionRange).map(symbol => new vscode.Location(uri, symbol.selectionRange));
  }

  async function build(projectUri, operation, { cancellation, allowProjectExecution } = {}) {
    if (allowProjectExecution !== true || !vscode.workspace.isTrusted || projectUri?.scheme !== 'file') {
      throw Error('Run JavaFX through an explicit action in a trusted local Maven project.');
    }
    const goals = { run: ['compile', 'javafx:run'], image: ['package', 'javafx:jlink'] };
    if (!Object.hasOwn(goals, operation)) throw Error('Choose a JavaFX run or runtime image task.');
    const roots = workspaceRoots(vscode.workspace.workspaceFolders || []);
    const folder = workspacePath(projectUri.toString(), roots);
    const pom = workspacePath(path.join(folder, 'pom.xml'), [folder], { directory: false });
    if (fs.statSync(pom).size > 1024 * 1024 || !/\bjavafx-maven-plugin\b/.test(fs.readFileSync(pom, 'utf8'))) {
      throw Error('Select a Maven module that configures the JavaFX Maven plugin.');
    }
    const config = vscode.workspace.getConfiguration('rocketbrain.java', projectUri);
    const spec = buildSpec({ root: folder, tool: 'maven', uri: projectUri.toString(), name: path.basename(folder) },
      { javaHome: config.get('javaHome'), mavenHome: config.get('mavenHome') }, goals[operation]);
    return tasks.execute(spec, { cancellation });
  }

  disposables.push(vscode.languages.registerDefinitionProvider(selector, { provideDefinition: definitions }));
  disposables.push(vscode.languages.registerDocumentSymbolProvider(selector, {
    provideDocumentSymbols(document) {
      if (!root(document)) return [];
      function symbol(node) {
        const selection = new vscode.Range(document.positionAt(node.start + 1), document.positionAt(node.start + node.name.length + 1));
        const item = new vscode.DocumentSymbol(node.name, node.id || '', vscode.SymbolKind.Object, span(document, node), selection);
        item.children = node.children.map(symbol);
        return item;
      }
      try { return readFxml(document.getText()).elements.map(symbol); } catch { return []; }
    }
  }));
  disposables.push(vscode.workspace.onDidOpenTextDocument(status));
  disposables.push(vscode.workspace.onDidSaveTextDocument(status));
  disposables.push(vscode.workspace.onDidCloseTextDocument(document => diagnostics.delete(document.uri)));
  vscode.workspace.textDocuments.forEach(status);

  disposables.push(vscode.commands.registerCommand('rocketbrain.javafx.build', async () => {
    try {
      const active = vscode.window.activeTextEditor?.document.uri;
      const folder = (active && vscode.workspace.getWorkspaceFolder(active)) || vscode.workspace.workspaceFolders?.[0];
      const selection = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true,
        canSelectMany: false, defaultUri: folder?.uri, title: 'Select JavaFX Maven Module' });
      if (!selection?.length) return;
      const mode = await vscode.window.showQuickPick([{ label: 'Run JavaFX application', value: 'run' },
        { label: 'Build JavaFX runtime image', value: 'image' }], { title: 'JavaFX Maven Task' });
      if (!mode) return;
      const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
        title: mode.label, cancellable: true }, (_, cancellation) => build(selection[0], mode.value, {
        cancellation, allowProjectExecution: true
      }));
      if (!result.cancelled && result.code !== 0) await vscode.window.showErrorMessage('JavaFX Maven task failed. See the Rocketbrain task terminal.');
    } catch (error) {
      await vscode.window.showErrorMessage(error.message);
    }
  }));

  return { definitions, build, async dispose() { await tasks.dispose(); disposables.forEach(item => item.dispose()); } };
}

module.exports = { registerJavaFx };
