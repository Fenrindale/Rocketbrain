'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { createAsyncInspection } = require('./async-trace');
const { openJavaFrame } = require('./jvm-diagnostics-vscode');
const { workspacePath, workspaceRoots } = require('./workbench-model');

function local(uri) {
  if (uri?.scheme !== 'file' || uri.authority || uri.query || uri.fragment) throw Error('Choose a local file or folder.');
  return uri.fsPath;
}

function registerJavaAsyncTrace(context, vscode, debuggerController) {
  let disposed = false;
  function trusted() {
    if (disposed || !vscode.workspace.isTrusted) throw Error('Trust this Java workspace before using async task traces.');
  }
  const inspector = createAsyncInspection({
    activeSession: () => vscode.debug.activeDebugSession,
    getState: id => debuggerController.getState(id),
    ensureTrusted: trusted
  });

  async function copySource(uri, name) {
    trusted();
    const roots = workspaceRoots(vscode.workspace.workspaceFolders || []);
    let folder = workspacePath(local(uri), roots);
    for (const name of ['rocketbrain', 'async']) {
      folder = path.join(folder, name);
      try { await fs.mkdir(folder); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      const stat = await fs.lstat(folder);
      if (!stat.isDirectory() || stat.isSymbolicLink() || path.relative(await fs.realpath(folder), folder)) {
        throw Error('Place the trace helper in a physical Java source directory.');
      }
    }
    if (name === 'ReactorTaskTrace.java') {
      const core = path.join(folder, 'TaskTrace.java');
      const installed = await fs.lstat(core).catch(error => { if (error.code !== 'ENOENT') throw error; });
      if (!installed?.isFile() || installed.isSymbolicLink()) {
        throw Error('Copy the current Java Async Trace Helper to this source root first.');
      }
      const current = await fs.readFile(context.asAbsolutePath('dist/java-async/TaskTrace.java'));
      if (installed.size !== current.length || !current.equals(await fs.readFile(core))) {
        throw Error('Update TaskTrace.java to the current Java Async Trace Helper before adding its Reactor companion.');
      }
    }
    const destination = path.join(folder, name);
    const packaged = context.asAbsolutePath('dist/java-async/' + name);
    try { await fs.copyFile(packaged, destination, constants.COPYFILE_EXCL); }
    catch (error) {
      if (error.code === 'EEXIST') throw Error(name + ' already exists in this source folder.');
      throw error;
    }
    return vscode.Uri.file(destination);
  }

  const copyHelper = uri => copySource(uri, 'TaskTrace.java');
  const copyReactorHelper = uri => copySource(uri, 'ReactorTaskTrace.java');
  function inspect(uri, session) { return inspector.inspect(local(uri), session); }
  function source(frame) { trusted(); return openJavaFrame(vscode, frame); }

  const labels = frame => frame.type + '.' + frame.method;
  const threadName = thread => {
    const id = '#' + thread.id;
    const name = thread.name ? thread.name + (thread.virtual === undefined ? '' : ' ' + id) : 'Thread ' + id;
    return name + (thread.virtual === undefined ? '' : ' (' + (thread.virtual ? 'virtual' : 'platform') + ')');
  };
  const subscriptions = [];
  function command(name, action) {
    subscriptions.push(vscode.commands.registerCommand(name, async () => {
      try { trusted(); return await action(); }
      catch (error) { void vscode.window.showErrorMessage('Rocketbrain Java: ' + error.message); }
    }));
  }

  async function chooseHelper(copy) {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    const [directory] = await vscode.window.showOpenDialog({ title: 'Choose the Java Source Root',
      canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
      defaultUri: root?.scheme === 'file' ? vscode.Uri.joinPath(root, 'src', 'main', 'java') : undefined
    }) || [];
    if (!directory) return undefined;
    const uri = await copy(directory);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: true });
    return uri;
  }
  command('rocketbrain.java.copyAsyncTraceHelper', () => chooseHelper(copyHelper));
  command('rocketbrain.java.copyReactorAsyncTraceHelper', () => chooseHelper(copyReactorHelper));

  command('rocketbrain.java.showAsyncTaskStack', async () => {
    const session = vscode.debug.activeDebugSession;
    if (session?.type !== 'rocketbrain-java' || debuggerController.getState(session.id)?.state !== 'stopped') {
      throw Error('Pause a Rocketbrain Java task before inspecting its async stack.');
    }
    const [file] = await vscode.window.showOpenDialog({ title: 'Open the Java Async Task Trace',
      canSelectMany: false, filters: { 'Java Async Task Trace': ['jsonl'] }
    }) || [];
    if (!file) return undefined;
    const report = await inspect(file, session);
    const items = report.chain.flatMap(task => [{
      label: task.label + ' (#' + task.id + ')' + ({
        'virtual-thread': ' · virtual thread launch', 'reactor-scheduler': ' · Reactor scheduler'
      }[task.handoff] || ''),
      kind: vscode.QuickPickItemKind.Separator
    }, ...task.submissionFrames.map(frame => ({
      label: labels(frame),
      description: frame.file && frame.line > 0 ? frame.file + ':' + frame.line : undefined,
      detail: 'Submitted by ' + threadName(task.submittedBy) + (task.worker ? ' · worker ' + threadName(task.worker) : ''),
      frame
    }))]);
    const choice = await vscode.window.showQuickPick(items, {
      title: report.truncated ? 'Java Async Submission Stack (Trace Limit Reached)' : 'Java Async Submission Stack',
      matchOnDescription: true
    });
    if (choice?.frame && !await source(choice.frame)) {
      void vscode.window.showInformationMessage('The submitted frame has no unique Java source in this workspace.');
    }
    return report;
  });

  return { copyHelper, copyReactorHelper, inspect, openFrame: source, dispose() {
    if (disposed) return;
    disposed = true;
    for (const subscription of subscriptions) subscription.dispose();
  } };
}

module.exports = { registerJavaAsyncTrace };
