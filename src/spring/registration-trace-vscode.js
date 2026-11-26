'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { readRegistrationTrace } = require('./registration-trace');
const { openJavaFrame } = require('../java/jvm-diagnostics-vscode');
const { workspaceRoots, workspacePath } = require('../java/workbench-model');

function local(uri) {
  if (uri?.scheme !== 'file' || uri.authority || uri.query || uri.fragment) throw Error('Choose a local folder or trace file.');
  return uri.fsPath;
}

function registerSpringRegistrationTrace(context, vscode) {
  let disposed = false;
  const subscriptions = [];
  const trusted = () => {
    if (disposed || !vscode.workspace.isTrusted) throw Error('Trust the local workspace before inspecting Spring registrations.');
  };

  async function copyHelper(uri) {
    trusted();
    let folder = workspacePath(local(uri), workspaceRoots(vscode.workspace.workspaceFolders || []));
    for (const name of ['rocketbrain', 'spring']) {
      folder = path.join(folder, name);
      await fs.mkdir(folder).catch(error => { if (error.code !== 'EEXIST') throw error; });
      const stat = await fs.lstat(folder);
      if (!stat.isDirectory() || stat.isSymbolicLink() || path.relative(folder, await fs.realpath(folder))) {
        throw Error('Choose a physical Java source folder inside the workspace.');
      }
    }
    trusted();
    const destination = path.join(folder, 'RegistrationTrace.java');
    await fs.copyFile(context.asAbsolutePath('dist/spring-registration/RegistrationTrace.java'),
      destination, constants.COPYFILE_EXCL).catch(error => {
      if (error.code === 'EEXIST') throw Error('RegistrationTrace.java already exists in this source root.');
      throw error;
    });
    return vscode.Uri.file(destination);
  }

  async function inspect(uri) {
    trusted();
    const report = await readRegistrationTrace(local(uri));
    trusted();
    return report;
  }

  const command = (id, action) => subscriptions.push(vscode.commands.registerCommand(id, async () => {
    try {
      trusted();
      return await action();
    } catch (error) {
      if (!disposed) await vscode.window.showErrorMessage('Rocketbrain Spring: ' + error.message);
    }
  }));

  command('rocketbrain.spring.copyRegistrationTraceHelper', async () => {
    const [directory] = await vscode.window.showOpenDialog({
      title: 'Choose a Java Source Root', canSelectFiles: false, canSelectFolders: true, canSelectMany: false
    }) || [];
    if (!directory) return;
    const copied = await copyHelper(directory);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(copied), { preview: true });
    return copied;
  });

  command('rocketbrain.spring.inspectRegistrationTrace', async () => {
    const [trace] = await vscode.window.showOpenDialog({
      title: 'Open a Spring Registration Trace', filters: { 'Spring Registration Trace': ['jsonl'] }, canSelectMany: false
    }) || [];
    if (!trace) return;
    const report = await inspect(trace);
    const entries = report.scopes.flatMap(scope => [{
      label: scope.label + ' · ' + scope.outcome, kind: vscode.QuickPickItemKind.Separator
    }, ...report.mutations.filter(event => event.scope === scope.id).map(event => ({
      label: event.operation + ' ' + event.name + (event.alias ? ' → ' + event.alias : ''),
      description: event.origin?.type, detail: event.origin?.line > 0 ? event.origin.file + ':' + event.origin.line : undefined,
      origin: event.origin
    }))]);
    if (!report.mutations.length) {
      await vscode.window.showInformationMessage('The selected trace does not contain any recorded registry mutations.');
      return report;
    }
    const selected = await vscode.window.showQuickPick(entries, {
      title: report.truncated || report.pendingLine || report.scopes.some(scope => scope.outcome === 'open') ?
        'Spring Registration Trace (Incomplete)' : 'Spring Registration Trace', matchOnDescription: true
    });
    trusted();
    if (selected?.origin?.file && selected.origin.line > 0) await openJavaFrame(vscode, selected.origin);
    return report;
  });

  const api = { copyHelper, inspect, dispose() {
    if (disposed) return;
    disposed = true;
    for (const subscription of subscriptions) subscription.dispose();
  } };
  context.subscriptions.push(api);
  return api;
}

module.exports = { registerSpringRegistrationTrace };
