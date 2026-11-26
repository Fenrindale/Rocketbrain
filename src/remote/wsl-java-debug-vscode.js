'use strict';

const { createManagedJavaAttach } = require('../devcontainer/java-attach');
const { createWslJavaDebug } = require('./wsl-java-debug');
const { sameWslPath, wslUnc } = require('./wsl-paths');

function registerWslJavaDebug(vscode, workbench, getJava) {
  const forwards = new Map();
  const output = vscode.window.createOutputChannel('Rocketbrain WSL Java');

  function trusted() {
    if (!vscode.workspace.isTrusted || vscode.env.remoteName) throw Error('Open a trusted local Windows workspace to debug WSL Java.');
  }

  function folderFor(file) {
    trusted();
    if (file?.scheme !== 'file' || !wslUnc(file.fsPath)) throw Error('Open a saved Java source in a WSL Linux project.');
    const folder = vscode.workspace.getWorkspaceFolder(file);
    if (!folder || !wslUnc(folder.uri.fsPath)) throw Error('Open the WSL Linux project as a workspace folder.');
    return folder;
  }

  const sameFile = (uri, file) => uri.scheme === 'file' && sameWslPath(wslUnc(uri.fsPath), wslUnc(file));
  const service = createWslJavaDebug({ trusted, onOutput: text => output.append(text),
    mapping: (distribution, root) => workbench.mapping(distribution, vscode.Uri.file(root)),
    saved(file) {
      if (vscode.workspace.textDocuments.some(doc => doc.isDirty && sameFile(doc.uri, file))) {
        throw Error('Save the selected Java source before reviewing a WSL launch.');
      }
    }
  });
  const adapter = createManagedJavaAttach({
    kind: 'wsl', debug: vscode.debug, launchTimeout: 45000,
    async ready() {
      trusted();
      const java = getJava();
      const state = await java.start();
      if (state?.state !== 'running' || !state.debugBundlePath) throw Error('Start the independent local Java engine and debug adapter.');
      const cancellation = new vscode.CancellationTokenSource();
      const wait = setTimeout(() => cancellation.cancel(), 25000);
      try { await java.requestWorkspaceCommand('java.project.getAll', [], cancellation.token); }
      finally { clearTimeout(wait); cancellation.dispose(); }
    },
    async openForward(root, confirmation) {
      const forward = await service.open(root, confirmation);
      forwards.set(forward.id, forward);
      return forward;
    },
    closeForward(_root, id) {
      const forward = forwards.get(id);
      forwards.delete(id);
      return forward?.close();
    },
    observe(forward, stop) {
      const close = forward.onClose(stop);
      const edit = vscode.workspace.onDidChangeTextDocument(({ document, contentChanges }) => {
        if (contentChanges.length && sameFile(document.uri, forward.sourceFile)) stop();
      });
      let checking = false;
      const poll = setInterval(async () => {
        if (checking) return;
        checking = true;
        try { await forward.checkSource(); }
        catch { stop(); }
        finally { checking = false; }
      }, 1500);
      poll.unref();
      return { dispose() { clearInterval(poll); close.dispose(); edit.dispose(); } };
    }
  });

  function review(sourceUri, jarUri) {
    const folder = folderFor(sourceUri);
    if (jarUri?.scheme !== 'file') throw Error('Choose the existing runnable JAR inside the WSL project.');
    const { distribution } = wslUnc(folder.uri.fsPath);
    return service.review({ distribution, projectRoot: folder.uri.fsPath,
      sourceFile: sourceUri.fsPath, jarFile: jarUri.fsPath });
  }

  function start(sourceUri, confirmation) {
    const folder = folderFor(sourceUri);
    return adapter.start(folder.uri.fsPath, folder, { ...confirmation, sourceFile: sourceUri.fsPath });
  }

  async function run() {
    const source = vscode.window.activeTextEditor?.document.uri;
    const folder = folderFor(source);
    const [jar] = await vscode.window.showOpenDialog({ title: 'Choose a Runnable WSL Java JAR', defaultUri: folder.uri,
      filters: { 'Java archive': ['jar'] }, canSelectFiles: true, canSelectMany: false }) || [];
    if (!jar) return;
    const choice = await review(source, jar);
    const approved = await vscode.window.showWarningMessage('Run the reviewed Java JAR in WSL?', { modal: true,
      detail: `${choice.distribution}\n${choice.linux}/${choice.jar}\n${choice.java}\nSHA-256 ${choice.jarSha256}` }, 'Debug WSL Java');
    if (approved !== 'Debug WSL Java') return;
    output.show(true);
    await start(source, { token: choice.token, allowWslJavaDebug: true });
  }

  const subscriptions = [vscode.commands.registerCommand('rocketbrain.wsl.debugJava',
    () => run().catch(error => void vscode.window.showErrorMessage(error.message)))];
  return { review, start, stop: adapter.stop, dispose() {
    service.clear();
    adapter.dispose();
    for (const subscription of subscriptions) subscription.dispose();
    output.dispose();
  } };
}

module.exports = { registerWslJavaDebug };
