'use strict';

const { workspacePath, workspaceRoots } = require('../java/workbench-model');
const { createWslWorkbench, wslBuildTasks } = require('./wsl-workspace');

const commands = {
  distributions: 'rocketbrain.wsl.distributions',
  build: 'rocketbrain.wsl.reviewBuild',
  cancel: 'rocketbrain.wsl.cancelBuild'
};

function registerWslWorkbench(vscode) {
  const service = createWslWorkbench({ isTrusted: () => vscode.workspace.isTrusted && !vscode.env.remoteName });
  const output = vscode.window.createOutputChannel('Rocketbrain WSL Builds');
  const subscriptions = [];

  function project(uri) {
    const location = typeof uri === 'string' ? uri : uri?.toString();
    return workspacePath(location, workspaceRoots(vscode.workspace.workspaceFolders || []));
  }

  async function selectProject() {
    const folders = (vscode.workspace.workspaceFolders || []).filter(folder => folder.uri.scheme === 'file');
    if (!folders.length) throw Error('Open a local Windows workspace to use WSL.');
    if (folders.length === 1) return folders[0].uri;
    const folder = await vscode.window.showQuickPick(folders.map(({ name, uri }) => ({ label: name, description: uri.fsPath, uri })),
      { placeHolder: 'Select a Windows workspace folder' });
    return folder?.uri;
  }

  async function review(options) {
    return service.review({ ...options, workspaceRoot: project(options.projectUri) });
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
    const distribution = await selectDistribution();
    if (!distribution) return;
    const folder = await selectProject();
    if (!folder) return;
    const mapping = await service.mapping(distribution, project(folder));
    void vscode.window.showInformationMessage(`${mapping.distribution} maps this workspace to ${mapping.linux}`);
  }

  async function runBuild() {
    const projectUri = await selectProject();
    if (!projectUri) return;
    const distribution = await selectDistribution();
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

  for (const [id, handler] of [[commands.distributions, displayDistributions], [commands.build, runBuild], [commands.cancel, stopBuild]]) {
    subscriptions.push(vscode.commands.registerCommand(id, () => handler().catch(error => void vscode.window.showErrorMessage(error.message))));
  }

  return { distributions: service.distributions, mapping: async (distribution, uri) => service.mapping(distribution, project(uri)),
    review, apply: service.apply, cancel: service.cancel,
    dispose() { service.dispose(); for (const subscription of subscriptions) subscription.dispose(); output.dispose(); } };
}

module.exports = { registerWslWorkbench };
