'use strict';

const { workspacePath, workspaceRoots } = require('../java/workbench-model');
const { createWslWorkbench, wslBuildTasks } = require('./wsl-workspace');
const { sameWslPath, wslUnc } = require('./wsl-paths');

const commands = {
  distributions: 'rocketbrain.wsl.distributions',
  open: 'rocketbrain.wsl.openProject',
  build: 'rocketbrain.wsl.reviewBuild',
  cancel: 'rocketbrain.wsl.cancelBuild'
};

function registerWslWorkbench(vscode, { createService = createWslWorkbench } = {}) {
  const service = createService({ isTrusted: () => vscode.workspace.isTrusted && !vscode.env.remoteName });
  const output = vscode.window.createOutputChannel('Rocketbrain WSL Builds');
  const subscriptions = [];

  function project(value) {
    const uri = typeof value === 'string' ? vscode.Uri.parse(value) : value;
    const folders = vscode.workspace.workspaceFolders || [];
    const unc = uri?.scheme === 'file' && wslUnc(uri.fsPath);
    if (unc) {
      if (uri.query || uri.fragment || !folders.some(({ uri: folder }) => folder.scheme === 'file' &&
        sameWslPath(wslUnc(folder.fsPath), unc))) {
        throw Error('Select the exact WSL project root already opened in this window.');
      }
      return { root: uri.fsPath, distribution: unc.distribution };
    }
    const localFolders = folders.filter(({ uri: folder }) => folder.scheme === 'file' && !folder.authority);
    return { root: workspacePath(uri?.toString(), workspaceRoots(localFolders)) };
  }

  async function selectProject() {
    const folders = (vscode.workspace.workspaceFolders || []).filter(folder => folder.uri.scheme === 'file');
    if (!folders.length) throw Error('Open a local Windows or WSL project folder.');
    if (folders.length === 1) return folders[0].uri;
    const folder = await vscode.window.showQuickPick(folders.map(({ name, uri }) => ({ label: name, description: uri.fsPath, uri })),
      { placeHolder: 'Select an open Windows or WSL project folder' });
    return folder?.uri;
  }

  async function review({ projectUri, distribution, system, goal } = {}) {
    const selected = project(projectUri);
    return service.review({ distribution: distribution ?? selected.distribution, workspaceRoot: selected.root, system, goal });
  }

  async function openProject({ distribution, linuxPath } = {}) {
    const mapping = await service.openProject(distribution, linuxPath);
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(mapping.windows), { forceNewWindow: true });
    return mapping;
  }

  async function selectDistribution() {
    const names = await service.distributions();
    if (names.length === 0) {
      void vscode.window.showInformationMessage('WSL reports no installed distributions.');
      return;
    }
    return vscode.window.showQuickPick(names, { placeHolder: 'Select an installed WSL distribution' });
  }

  async function displayDistributions() {
    const folder = await selectProject();
    if (!folder) return;
    const selected = project(folder);
    const distribution = selected.distribution || await selectDistribution();
    if (!distribution) return;
    const mapping = await service.mapping(distribution, selected.root);
    void vscode.window.showInformationMessage(`${mapping.distribution} maps this workspace to ${mapping.linux}`);
  }

  async function openWslProject() {
    const distribution = await selectDistribution();
    if (!distribution) return;
    const linuxPath = await vscode.window.showInputBox({ title: 'Open WSL Project Folder',
      prompt: `Enter the exact absolute Linux path in ${distribution}`, placeHolder: '/srv/projects/example' });
    if (linuxPath === undefined) return;
    await openProject({ distribution, linuxPath });
  }

  async function runBuild() {
    const projectUri = await selectProject();
    if (!projectUri) return;
    const distribution = project(projectUri).distribution || await selectDistribution();
    if (!distribution) return;
    const tool = await vscode.window.showQuickPick([{ label: 'Maven', system: 'maven' }, { label: 'Gradle', system: 'gradle' }],
      { placeHolder: 'Select a build tool installed in WSL' });
    if (!tool) return;
    const goal = await vscode.window.showQuickPick(wslBuildTasks[tool.system], { placeHolder: 'Select a WSL build task' });
    if (!goal) return;
    const build = await review({ projectUri, distribution, system: tool.system, goal });
    const approved = await vscode.window.showWarningMessage('Run this project build inside WSL?', {
      modal: true, detail: `${build.distribution}\n${build.linux}\n${build.command.join(' ')}\nThe build uses workspace files saved on disk.`
    }, 'Run WSL Build');
    if (approved !== 'Run WSL Build') return;
    output.appendLine(`${build.distribution} · ${build.linux} · ${build.command.join(' ')}`);
    output.show(true);
    const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
      title: `${tool.label} ${goal} in ${distribution}`, cancellable: true }, async (_progress, cancellation) => {
      const controller = new AbortController();
      if (cancellation.isCancellationRequested) controller.abort();
      const subscription = cancellation.onCancellationRequested(() => controller.abort());
      try { return await service.apply(build.token, { approved: true, signal: controller.signal }); }
      finally { subscription.dispose(); }
    });
    output.appendLine(result.output);
    if (result.truncated) output.appendLine('Output reached the display limit.');
    output.appendLine(result.cancelled ? 'Cancelled.' : `Exited with code ${result.code}.`);
    if (!result.cancelled && result.code !== 0) void vscode.window.showErrorMessage('The WSL build failed. See Rocketbrain WSL Builds for details.');
  }

  async function stopBuild() {
    if (!(await service.cancel())) void vscode.window.showInformationMessage('No managed WSL build is running.');
  }

  for (const [id, handler] of [[commands.distributions, displayDistributions], [commands.open, openWslProject],
    [commands.build, runBuild], [commands.cancel, stopBuild]]) {
    subscriptions.push(vscode.commands.registerCommand(id, () => handler().catch(error => void vscode.window.showErrorMessage(error.message))));
  }

  return { distributions: service.distributions, mapping: async (distribution, uri) => service.mapping(distribution, project(uri).root),
    openProject, review, apply: service.apply, cancel: service.cancel,
    dispose() { service.dispose(); for (const subscription of subscriptions) subscription.dispose(); output.dispose(); } };
}

module.exports = { registerWslWorkbench };
