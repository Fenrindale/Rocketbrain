'use strict';

const { createTomcatManager, managerOrigin, managerContext } = require('./jakarta-manager');
const { fail } = require('./workbench-model');
const artifactActions = new Set(['deploy', 'update', 'track-deploy', 'track-update']);

function registerJakartaManager(vscode, { trusted, withProgress, chooseProject, listWarArtifacts, resolveArtifact, output, storageUri }) {
  const manager = createTomcatManager({ storagePath: storageUri?.scheme === 'file' ? storageUri.fsPath : undefined });
  const observe = options => { trusted(options?.cancellation); return manager.observe(options); };
  async function review(options = {}) {
    trusted(options.cancellation);
    if (options.allowManagerAccess !== true) throw fail('Explicitly approve access to the selected Tomcat Manager endpoint.');
    const artifact = artifactActions.has(options.action) &&
      await resolveArtifact(options.projectUri, options.warUri, options.cancellation);
    trusted(options.cancellation);
    return manager.review({ ...options, artifact });
  }
  async function execute(options = {}) {
    trusted(options.cancellation);
    const receipt = await manager.execute(options);
    output.appendLine(`Tomcat Manager ${receipt.action} ${receipt.context} · ${receipt.state}`);
    return receipt;
  }

  function validate(parser) {
    return value => {
      try { parser(value); return undefined; }
      catch (error) { return error.message; }
    };
  }

  async function command() {
    const choice = await vscode.window.showQuickPick([
      { label: 'List Remote Applications', action: 'list' },
      { label: 'Deploy a Maven WAR', action: 'deploy' },
      { label: 'Update a Deployed Context', action: 'update' },
      { label: 'Undeploy a Context', action: 'undeploy' },
      { label: 'Start Tracking a WAR Deployment', action: 'track-deploy', approve: 'Deploy Tracked WAR' },
      { label: 'Publish a Tracked WAR Revision', action: 'track-update', approve: 'Publish Revision' },
      { label: 'Restore the Previous Tracked WAR', action: 'restore', approve: 'Restore Previous WAR' }
    ], { title: 'Tomcat Manager' });
    if (!choice) return;
    const origin = await vscode.window.showInputBox({ title: 'Approved Tomcat HTTPS Origin',
      prompt: 'Enter the origin of the server running /manager/text, including its HTTPS port if needed.',
      validateInput: validate(managerOrigin) });
    if (!origin) return;
    const connection = await vscode.window.showQuickPick([
      { label: 'Use Default Trusted Certificate Authorities', custom: false },
      { label: 'Choose Certificate Authority PEM', custom: true }
    ], { title: 'Verify the Tomcat Server Certificate' });
    if (!connection) return;
    let caFile;
    if (connection.custom) {
      const picked = await vscode.window.showOpenDialog({ title: 'Select the Tomcat CA PEM',
        filters: { Certificates: ['pem', 'crt'] }, canSelectMany: false, openLabel: 'Use CA' });
      if (!picked?.length) return;
      caFile = picked[0].fsPath;
    }
    const username = await vscode.window.showInputBox({ title: 'Tomcat Manager Username' });
    if (!username) return;
    const password = await vscode.window.showInputBox({ title: 'Tomcat Manager Password',
      prompt: 'Use a Manager text account for this attempt.', password: true, ignoreFocusOut: true });
    if (!password) return;
    const settings = { origin, caFile, username, password, allowManagerAccess: true };
    const { action } = choice;
    if (action === 'list') {
      const found = await withProgress('List Tomcat Applications', cancellation => observe({ ...settings, cancellation }));
      await vscode.window.showQuickPick(found.applications.map(({ context, state, sessions, version }) => (
        { label: context, description: version || state, detail: state + ' · ' + sessions + ' active sessions' })),
        { title: 'Remote Tomcat Applications' });
      return found;
    }

    let target = {};
    if (artifactActions.has(action)) {
      const project = await chooseProject();
      if (!project) return;
      const files = listWarArtifacts(project);
      if (!files.length) throw fail('Build the selected Maven WAR first.');
      const picked = await vscode.window.showQuickPick(files.map(artifact => ({
        label: artifact.name, description: Math.ceil(artifact.size / 1024) + ' KiB', artifact
      })), { title: 'Select WAR to Upload to Tomcat' });
      if (!picked) return;
      target = { projectUri: project.uri, warUri: picked.artifact.uri };
    }
    const context = await vscode.window.showInputBox({ title: 'Tomcat Application Context',
      placeHolder: '/example', validateInput: validate(managerContext) });
    if (!context) return;
    const plan = await withProgress('Review Tomcat Manager Change', cancellation =>
      review({ ...settings, ...target, action, context, cancellation }));
    const details = [plan.origin, 'TLS certificate SHA-256 ' + plan.certificateSha256];
    if (plan.artifact) details.push(plan.artifact, 'Upload SHA-256 ' + plan.uploadedSha256);
    if (plan.application) details.push(plan.application.state + ' · ' + plan.application.sessions + ' active sessions at review');
    if (action === 'update') details.push('Tomcat removes the current deployment before installing the WAR. A failed update can leave the app unavailable.');
    if (action === 'undeploy') details.push('Tomcat removes the application and its deployment files from this server.');
    if (plan.nextRevision) {
      details.push('New Tomcat revision ' + plan.nextRevision);
      if (plan.currentVersion) details.push('Current tracked version ' + plan.currentVersion, 'Current retained WAR SHA-256 ' + plan.currentSha256);
      if (plan.restoreFromVersion) details.push('Restore from ' + plan.restoreFromVersion);
      details.push('New sessions use the latest parallel deployment. Existing sessions may continue on their original versions.',
        plan.historyScope === 'profile' ? 'Restore history and archived WAR files are saved in this local VS Code profile.'
          : 'Restore history and archived WAR files belong to this extension session.',
        'Tomcat Manager reports versions and running state.');
    }
    const approve = choice.approve || 'Apply Change';
    const verb = choice.approve ? choice.approve + ' for' : action[0].toUpperCase() + action.slice(1);
    const proceed = await vscode.window.showWarningMessage(
      `${verb} ${plan.context} on the selected Tomcat?`, { modal: true, detail: details.join('\n') }, approve);
    if (proceed !== approve) return;
    const receipt = await withProgress('Apply Tomcat Manager Change', cancellation =>
      execute({ reviewId: plan.id, username, password, allowExecute: true, cancellation }));
    if (receipt.state === 'confirmed') void vscode.window.showInformationMessage(receipt.version
      ? `Tomcat confirmed ${receipt.context} version ${receipt.version}.`
      : `Tomcat confirmed ${receipt.action} for ${receipt.context}.`);
    else void vscode.window.showWarningMessage(
      'Tomcat did not confirm the application change. Refresh the application list and check the server before attempting another change.');
    return receipt;
  }

  return { command, observe, review, execute, dispose: manager.dispose };
}

module.exports = { registerJakartaManager };
