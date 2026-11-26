'use strict';

const { createWorkspaceIndex, hash, indexScope } = require('./workspace-index');
const { collectProjects, cancelled } = require('./workbench-model');

const command = 'rocketbrain.java.rebuildWorkspaceIndex';
const settings = ['enabled', 'serverPath', 'javaHome', 'debugBundlePath', 'projectJdks', 'gradleHome', 'gradleJavaHome',
  'mavenHome', 'extractInterface.replaceUsages', 'staticImport.favorites', 'annotationProcessing.gradleEnabled',
  'annotationProcessing.lombokJar', 'nullChecks'];

function indexConfiguration(vscode, folders) {
  const addresses = [undefined, ...folders.map(folder => folder.uri)];
  const configured = addresses.map(address => {
    const config = vscode.workspace.getConfiguration('rocketbrain.java', address);
    return settings.map(name => config.get(name));
  });
  return hash({ configured, gradleUserHome: process.env.GRADLE_USER_HOME || '' });
}

function registerWorkspaceIndex(vscode, { extension, serial, current, assertIdle, request, stop, start }) {
  const getContext = () => {
    if (!vscode.workspace.isTrusted || vscode.env.remoteName) throw Error('Trust the local Java workspace before rebuilding its index.');
    assertIdle();
    const folders = vscode.workspace.workspaceFolders || [];
    return { scope: indexScope(folders, extension.storageUri), settings: indexConfiguration(vscode, folders),
      documents: () => vscode.workspace.textDocuments, workspaceFile: vscode.workspace.workspaceFile };
  };
  const service = createWorkspaceIndex({ context: getContext, current, memento: extension.workspaceState, stop, start,
    async observe(cancellation, deadline) {
      const model = await collectProjects({ folders: vscode.workspace.workspaceFolders, cancellation,
        request: async (command, args) => {
          const limit = Math.min(30000, deadline - Date.now());
          if (cancelled(cancellation)) throw Error('Java workspace index rebuild cancelled.');
          if (limit <= 0) throw Error('Java workspace index import timed out.');
          const token = new vscode.CancellationTokenSource();
          const cancel = cancellation?.onCancellationRequested?.(() => token.cancel());
          let timer;
          try {
            return await Promise.race([
              request(command, args, token.token),
              new Promise((_, reject) => {
                timer = setTimeout(() => { token.cancel(); reject(Error('Java workspace index project metadata timed out.')); }, limit);
              })
            ]);
          } finally { clearTimeout(timer); cancel?.dispose(); token.dispose(); }
        } });
      return model.projects;
    } });
  const review = cancellation => serial(() => service.review(cancellation));
  const apply = (id, options) => serial(() => service.apply(id, options));
  const subscription = vscode.commands.registerCommand(command, async () => {
    try {
      const progress = (title, operation) => vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification, title, cancellable: true
      }, (_, cancellation) => operation(cancellation));
      const plan = await progress('Review Java Workspace Index', review);
      const label = 'Rebuild Index';
      const answer = await vscode.window.showWarningMessage('Rebuild the Java workspace index?', { modal: true,
        detail: [
          `A fresh JDT LS index will import ${plan.projects.length} reviewed projects and ${plan.inputFiles} saved inputs.`,
          ...plan.projects.slice(0, 8).map(project => `${project.tool} · ${project.root}${project.jdk ? ' · ' + project.jdk : ''}`),
          ...(plan.projects.length > 8 ? [`and ${plan.projects.length - 8} other reviewed projects`] : []),
          'Normal project import can run Maven or Gradle configuration. The current index is preserved.'
        ].join('\n') }, label);
      if (answer !== label) return;
      await progress('Rebuild Java Workspace Index', cancellation => apply(plan.id, { approved: true, cancellation }));
      void vscode.window.showInformationMessage('Rocketbrain rebuilt the Java workspace index. The previous index is retained.');
    } catch (error) { void vscode.window.showErrorMessage(error.message); }
  });
  return { review, apply, dispose() { service.clear(); subscription.dispose(); } };
}

module.exports = { registerWorkspaceIndex, indexConfiguration };
