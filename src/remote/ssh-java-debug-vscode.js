'use strict';

const path = require('node:path');
const { createManagedJavaAttach } = require('../devcontainer/java-attach');
const { createSshJavaDebug } = require('./ssh-java-debug');

function registerSshJavaDebug(vscode, command, current, getLocalJava) {
  const forwards = new Map();
  function trusted() {
    if (!vscode.workspace.isTrusted) throw Error('Trust this workspace before attaching to an SSH Java process.');
  }
  function saved(file) {
    if (vscode.workspace.textDocuments.some(document => document.uri.scheme === 'file' &&
      !path.relative(file, document.uri.fsPath) && document.isDirty)) throw Error('Save the selected Java source before reviewing an SSH attach.');
  }
  function localFolder(file) {
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file));
    if (folder?.uri.scheme !== 'file') throw Error('Choose a corresponding saved local Java source in an open workspace.');
    return folder;
  }
  const service = createSshJavaDebug({ current, trusted, saved });
  const adapter = createManagedJavaAttach({
    kind: 'ssh',
    debug: vscode.debug,
    async ready() {
      trusted();
      const state = await getLocalJava()?.start();
      if (state?.state !== 'running' || !state.debugBundlePath) {
        throw Error('Start the independent local Java engine and its debugger before attaching by SSH.');
      }
    },
    async openForward(root, confirmation) {
      const forward = await service.open(current(), root, { ...confirmation, allowSshJavaDebug: true });
      forwards.set(forward.id, forward);
      return forward;
    },
    closeForward(_root, id) {
      const forward = forwards.get(id);
      forwards.delete(id);
      return forward?.close();
    },
    observe(forward, stop) {
      const sameFile = uri => uri.scheme === 'file' && !path.relative(forward.sourceFile, uri.fsPath);
      const close = forward.onClose(stop);
      const edit = vscode.workspace.onDidChangeTextDocument(({ document, contentChanges }) => {
        if (contentChanges.length && sameFile(document.uri)) stop();
      });
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(path.dirname(forward.sourceFile), '*.java'));
      const diskChange = uri => { if (sameFile(uri)) stop(); };
      const observations = [close, edit, watcher, watcher.onDidChange(diskChange), watcher.onDidCreate(diskChange), watcher.onDidDelete(diskChange)];
      return { dispose() { for (const observation of observations) observation.dispose(); } };
    }
  });

  function inspect(request) {
    trusted();
    if (typeof request?.file !== 'string' || !path.isAbsolute(request.file)) throw Error('Choose a saved local Java source in this workspace.');
    return service.review(current(), localFolder(request.file).uri.fsPath, request);
  }
  function start(file, confirmation) {
    trusted();
    const folder = localFolder(file);
    return adapter.start(folder.uri.fsPath, folder, { ...confirmation, sourceFile: file });
  }

  async function readInteger(title, max, initial) {
    const valid = text => /^[1-9][0-9]*$/u.test(text) && Number(text) <= max;
    const value = await vscode.window.showInputBox({ title, value: initial,
      validateInput: text => valid(text) ? undefined : 'Enter an integer from 1 to ' + max + '.' });
    return valid(value) ? Number(value) : undefined;
  }
  const registrations = [command('javaDebug', async () => {
    trusted();
    if (!current()) throw Error('Open the verified SSH workspace again.');
    const [uri] = await vscode.window.showOpenDialog({ title: 'Choose the Corresponding Saved Local Java Source',
      filters: { Java: ['java'] }, canSelectFiles: true, canSelectMany: false }) || [];
    if (uri?.scheme !== 'file') return;
    const pid = await readInteger('Remote JVM Process ID', 0xffffffff);
    if (pid === undefined) return;
    const port = await readInteger('Remote IPv4 Loopback JDWP Port', 65535, '5005');
    if (port === undefined) return;
    const javaHome = await vscode.window.showInputBox({ title: 'Remote Independent JDK 25 Directory' });
    if (!javaHome) return;
    const review = await inspect({ file: uri.fsPath, pid, port, javaHome });
    const approved = await vscode.window.showWarningMessage('Attach the debugger to the reviewed SSH JVM?', {
      modal: true,
      detail: review.user + '@' + review.host + ':' + review.port + '\nJVM ' + review.pid + ' / 127.0.0.1:' + review.debugPort +
        '\n' + review.root + review.remoteFile + '\n' + review.sourceFile
    }, 'Attach Reviewed JVM');
    if (approved) return start(uri.fsPath, { token: review.token, allowSshJavaDebug: true });
  }), command('javaDebugStop', () => { service.clear(); return adapter.stop(); })];

  return {
    inspect, start,
    retire() { service.clear(); return adapter.stop(); },
    dispose() {
      service.clear();
      adapter.dispose();
      for (const registration of registrations) registration.dispose();
    }
  };
}

module.exports = { registerSshJavaDebug };
