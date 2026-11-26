'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { maxSourceBytes } = require('./java-mapping');

const reviewScheme = 'rocketbrain-container-java-review';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const snapshot = document => ({ file: document.uri.fsPath, text: document.getText(), version: document.version });

function sameRoot(first, second) {
  try { return !path.relative(fs.realpathSync(first), fs.realpathSync(second)); } catch { return false; }
}

function diskDigest(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > maxSourceBytes || path.relative(file, fs.realpathSync(file))) {
    throw Error('Use a physical Java source editor up to 256 KiB.');
  }
  const bytes = fs.readFileSync(file);
  if (bytes.length > maxSourceBytes) throw Error('Use a Java source editor up to 256 KiB.');
  return digest(bytes);
}

function registerContainerJava(vscode, service, localJava, register, progress, output) {
  const collection = vscode.languages.createDiagnosticCollection('rocketbrain-container-java');
  const previews = new Map();
  const subscriptions = [collection, vscode.workspace.registerTextDocumentContentProvider(reviewScheme, {
    provideTextDocumentContent(uri) { return previews.get(uri.toString()); }
  })];
  let active, disposed = false, starting = false;

  function childOf(root, document) {
    if (document?.languageId !== 'java' || document.uri.scheme !== 'file') return false;
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    return folder?.uri.scheme === 'file' && sameRoot(root, folder.uri.fsPath);
  }

  function clear() {
    const previous = active;
    active = undefined;
    collection.clear();
    if (!previous) return;
    for (const timer of previous.timers.values()) clearTimeout(timer);
    for (const provider of previous.providers) provider.dispose();
    previous.localLease?.dispose();
  }

  function queue(document) {
    const current = active;
    if (!current || !childOf(current.root, document)) return;
    const key = document.uri.toString();
    clearTimeout(current.timers.get(key));
    if (current.timers.size >= 32 && !current.timers.has(key)) return;
    current.timers.set(key, setTimeout(() => {
      current.timers.delete(key);
      if (current === active && !document.isClosed) {
        void service.javaSynchronize(current.root, snapshot(document)).catch(() => {});
      }
    }, 200));
  }

  function codeRange(range) {
    return new vscode.Range(range.start.line, range.start.character, range.end.line, range.end.character);
  }

  function ready(root, localLease) {
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(root));
    const selector = { scheme: 'file', language: 'java', pattern: new vscode.RelativePattern(folder, '**/*.java') };
    const current = { root, physicalRoot: fs.realpathSync(root), localLease, providers: [], timers: new Map() };
    active = current;
    const location = (document, position, cancellation, request, format) => {
      if (current !== active || !childOf(root, document)) return undefined;
      const initial = snapshot(document);
      const point = { line: position.line, character: position.character };
      return request(root, initial, point, cancellation).then(value => {
        if (current === active && !document.isClosed && initial.version === document.version && !cancellation?.isCancellationRequested) {
          return format(value);
        }
      }).catch(() => undefined);
    };
    current.providers.push(vscode.languages.registerHoverProvider(selector, {
      provideHover(document, position, cancellation) {
        return location(document, position, cancellation, service.javaHover, value =>
          value ? new vscode.Hover(new vscode.MarkdownString().appendText(value)) : undefined);
      }
    }), vscode.languages.registerDefinitionProvider(selector, {
      provideDefinition(document, position, cancellation) {
        return location(document, position, cancellation, service.javaDefinition, items =>
          items.map(item => new vscode.Location(vscode.Uri.file(item.file), codeRange(item.range))));
      }
    }));
    for (const document of vscode.workspace.textDocuments) queue(document);
  }

  subscriptions.push(vscode.workspace.onDidOpenTextDocument(queue));
  subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => queue(event.document)));
  subscriptions.push(vscode.workspace.onDidCloseTextDocument(document => {
    if (!active || !childOf(active.root, document)) return;
    const key = document.uri.toString();
    clearTimeout(active.timers.get(key));
    active.timers.delete(key);
    collection.delete(document.uri);
    void service.javaClose(active.root, document.uri.fsPath).catch(() => {});
  }));

  async function start(root, approval) {
    if (approval?.allowContainerProjectImport !== true) throw Error('Review the mounted workspace and container Java runtime first.');
    if (active || starting || disposed) throw Error('Stop the current container Java session first.');
    starting = true;
    let localLease;
    try {
      localLease = await localJava?.suspendForContainer?.();
      const result = await service.startJava(root, approval);
      if (disposed) throw Error('The container Java editor route is closed.');
      ready(root, localLease);
      return result;
    } catch (error) {
      localLease?.dispose();
      await service.stopJava(root).catch(() => {});
      throw error;
    } finally {
      starting = false;
    }
  }

  register('javaStart', async root => {
    const current = await progress('Checking the managed Dev Container', () => service.status(root));
    if (current.state !== 'running') throw Error('Start the managed Dev Container before opening its Java engine.');
    const containerRoot = await vscode.window.showInputBox({ title: 'Mounted Java Workspace in Container',
      prompt: 'Enter the absolute path of this bind-mounted workspace inside the container', value: '/workspaces/' + path.basename(root) });
    if (!containerRoot) return;
    const javaHome = await vscode.window.showInputBox({ title: 'Container JDK Directory', value: '/opt/java/openjdk' });
    if (!javaHome) return;
    const serverPath = await vscode.window.showInputBox({ title: 'Container Eclipse JDT LS Directory', value: '/opt/jdtls' });
    if (!serverPath) return;
    const review = await progress('Verifying the mounted Java runtime',
      () => service.inspectJava(root, { containerRoot, javaHome, serverPath }));
    const consent = await vscode.window.showWarningMessage('Use the Java engine in this container?', {
      modal: true, detail: 'Container ' + review.containerId.slice(0, 12) + ' maps ' + review.containerRoot + ' to this workspace. ' +
        'It will read Java editor contents and may import Maven project configuration. The local Java language service will pause.'
    }, 'Start Container Java');
    if (!consent) return;
    const result = await progress('Starting Eclipse JDT LS inside the verified container',
      () => start(root, { token: review.token, allowContainerProjectImport: true }));
    output.appendLine('Container Java started in ' + result.containerRoot + ' with JDK ' + result.jdk);
    output.show(true);
    return result;
  });

  register('javaStop', async root => {
    await progress('Stopping the container Java engine', () => service.stopJava(root));
    if (active && sameRoot(active.root, root)) clear();
  });

  register('javaFormat', async root => {
    const editor = vscode.window.activeTextEditor;
    const doc = editor?.document, current = active;
    if (!current || !sameRoot(current.root, root) || !childOf(root, doc)) {
      throw Error('Open a Java editor in the active managed container workspace.');
    }
    const initial = snapshot(doc);
    const beforeDisk = diskDigest(initial.file);
    const options = { insertSpaces: editor.options.insertSpaces !== false, tabSize: Number(editor.options.tabSize) || 4 };
    const preview = await progress('Preparing a container Java format preview', () => service.javaFormat(root, initial, options));
    if (preview.after === initial.text) return;
    const id = randomUUID(), name = path.basename(initial.file);
    const before = vscode.Uri.from({ scheme: reviewScheme, path: '/' + id + '/before/' + name });
    const after = before.with({ path: '/' + id + '/after/' + name });
    previews.set(before.toString(), initial.text);
    previews.set(after.toString(), preview.after);
    try {
      await vscode.commands.executeCommand('vscode.diff', before, after, 'Container Java Format Review');
      const approved = await vscode.window.showWarningMessage('Apply the reviewed Java formatting?', { modal: true, detail: name }, 'Apply Formatting');
      if (!approved) return;
      await service.javaStatus(root);
      if (current !== active || doc.isClosed || doc.version !== initial.version || doc.getText() !== initial.text ||
          diskDigest(initial.file) !== beforeDisk) {
        throw Error('The Java source or container route changed. Review the format edit again.');
      }
      const edit = new vscode.WorkspaceEdit();
      edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(initial.text.length)), preview.after);
      if (!await vscode.workspace.applyEdit(edit)) throw Error('VS Code did not apply the reviewed Java formatting.');
      return true;
    } finally {
      previews.delete(before.toString());
      previews.delete(after.toString());
    }
  });

  return {
    start,
    publish(root, file, diagnostics, version) {
      if (!active || !sameRoot(root, active.root)) return;
      const uri = vscode.Uri.file(file);
      const doc = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === uri.toString());
      if (!doc || doc.version !== version) return;
      collection.set(uri, diagnostics.flatMap(item => {
        const range = codeRange(item.range);
        if (!doc.validateRange(range).isEqual(range)) return [];
        return [new vscode.Diagnostic(range, item.message, item.severity - 1)];
      }));
    },
    closed(root) {
      if (active && !path.relative(root, active.physicalRoot)) clear();
    },
    dispose() {
      disposed = true;
      clear();
      previews.clear();
      for (const subscription of subscriptions) subscription.dispose();
    }
  };
}

module.exports = { registerContainerJava };
