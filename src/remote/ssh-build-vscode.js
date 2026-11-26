'use strict';

const { posix } = require('node:path');

function registerSshBuild(vscode, command, requireConnection, policy) {
  const { kind, label, file, tasks, homeTitle, reportLabel, settingsFile, mirrorLabel, approvalKey, detail } = policy;
  const toolHome = kind + 'Home';
  const output = vscode.window.createOutputChannel('Rocketbrain SSH ' + label);
  let active;

  function saved(uri) {
    const directory = posix.dirname(uri.path).replace(/\/$/u, '');
    const settings = settingsFile ? directory + '/' + settingsFile : undefined;
    if (vscode.workspace.textDocuments.some(document => document.isDirty && document.uri.scheme === uri.scheme &&
        document.uri.authority === uri.authority &&
        (document.uri.path === uri.path || document.uri.path === settings || document.uri.path.startsWith(directory + '/src/')))) {
      throw Error('Save or discard the remote ' + label + ' project edits before continuing.');
    }
  }

  async function inspect(uri, requested) {
    const client = requireConnection(uri);
    saved(uri);
    const original = await client.read(uri.path);
    const review = await client.inspectProcess(kind, { ...requested, file: uri.path });
    if (requireConnection(uri) !== client || review.descriptorSha256 !== original.sha256) {
      throw Error('The remote ' + label + ' descriptor changed. Review the saved project again.');
    }
    saved(uri);
    return review;
  }

  async function start(uri, approval, signal) {
    const client = requireConnection(uri);
    if (approval?.[approvalKey] !== true) throw Error('Approve the reviewed remote ' + label + ' task first.');
    if (active) throw Error('Wait for the current SSH ' + label + ' build to finish.');
    saved(uri);
    const controller = new AbortController(), cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    active = controller;
    try {
      const result = await client.openProcess(kind, { token: approval.token, file: uri.path, task: approval.task,
        allowRemoteProcess: true, signal: controller.signal });
      if (requireConnection(uri) !== client) throw Error('The reviewed SSH workspace changed.');
      return result;
    } finally {
      signal?.removeEventListener('abort', cancel);
      if (active === controller) active = undefined;
    }
  }

  const registered = command(kind + 'Build', async entry => {
    const uri = entry?.resourceUri || (entry?.scheme ? entry : vscode.window.activeTextEditor?.document.uri);
    requireConnection(uri);
    if (posix.basename(uri.path) !== file) throw Error('Select the saved remote ' + file + ' of the ' + label + ' project.');
    const task = await vscode.window.showQuickPick(tasks, { title: 'Select a ' + label + ' Lifecycle Task' });
    if (!task) return;
    const paths = {};
    for (const [key, title] of [['javaHome', 'Independent Remote JDK 25 Directory'],
      [toolHome, homeTitle], ['repository', mirrorLabel]]) {
      const value = await vscode.window.showInputBox({ title });
      if (!value) return;
      paths[key] = value;
    }
    const review = await vscode.window.withProgress({ title: 'Review Remote ' + label + ' Inputs',
      location: vscode.ProgressLocation.Notification }, () => inspect(uri, { ...paths, task }));
    output.clear();
    output.appendLine(label + ' ' + task + ' · ' + review.user + '@' + review.host + ':' + review.port);
    output.appendLine(review.root + review.file);
    output.appendLine('Project SHA-256 ' + review.projectSha256);
    output.appendLine('Descriptor SHA-256 ' + review.descriptorSha256);
    if (settingsFile) output.appendLine(settingsFile + ' SHA-256 ' + review.settingsSha256);
    for (const [inputLabel, inputPath, hash] of [[label, review[toolHome], review.toolSha256],
      ['JDK', review.javaHome, review.jdkSha256], [mirrorLabel, review.repository, review.repositorySha256]]) {
      output.appendLine(inputLabel + ' · ' + inputPath);
      output.appendLine('SHA-256 ' + hash);
    }
    output.show(true);
    const chosen = await vscode.window.showWarningMessage('Run the reviewed remote ' + label + ' task?', {
      modal: true,
      detail: review.file + '\n' + label + ' ' + task + ' · ' + review.sourceFiles + ' source/resource files and ' +
        review.repositoryFiles + ' cached files. ' + detail
    }, 'Run Reviewed Task');
    if (chosen !== 'Run Reviewed Task') return;
    const result = await vscode.window.withProgress({ title: 'Running Reviewed SSH ' + label + ' Task', cancellable: true,
      location: vscode.ProgressLocation.Notification }, async (_progress, token) => {
      const controller = new AbortController(), subscription = token.onCancellationRequested(() => controller.abort());
      if (token.isCancellationRequested) controller.abort();
      try { return await start(uri, { token: review.token, task, [approvalKey]: true }, controller.signal); }
      catch (error) { if (controller.signal.aborted) return { state: 'cancelled' }; throw error; }
      finally { subscription.dispose(); }
    });
    output.appendLine(result.state === 'cancelled' ? label + ' task cancelled.' : label + ' task ' + result.state + ' · exit ' + result.exitCode);
    if (result.tests) {
      const { tests, failures, errors, skipped, reports } = result.tests;
      output.appendLine(reports ? `${tests} tests, ${failures} failures, ${errors} errors, ${skipped} skipped` : reportLabel);
    }
    if (result.taskGraph?.length) output.appendLine('Gradle task graph · ' + result.taskGraph.join(' → '));
    if (result.artifact) output.appendLine(result.artifact.name + ' · SHA-256 ' + result.artifact.sha256);
    return result;
  });

  return { inspect, start, retire() { active?.abort(); }, dispose() { active?.abort(); registered.dispose(); output.dispose(); } };
}

const maven = {
  kind: 'maven', label: 'Maven', file: 'pom.xml', tasks: ['test', 'package'], approvalKey: 'allowSshMaven',
  homeTitle: 'Independent Remote Apache Maven 3.9 Directory', mirrorLabel: 'Prepared Remote Offline Maven Repository',
  reportLabel: 'No Surefire test reports.',
  detail: 'Maven runs the selected project’s code under the SSH account, in a temporary copy.'
};
const gradle = {
  kind: 'gradle', label: 'Gradle', file: 'build.gradle', settingsFile: 'settings.gradle', tasks: ['test', 'build'],
  approvalKey: 'allowSshGradle', homeTitle: 'Independent Remote Gradle 9.9.2+ Directory',
  mirrorLabel: 'Prepared Remote Maven-Format Offline Mirror', reportLabel: 'No Gradle test reports.',
  detail: 'Gradle uses the reviewed offline mirror in a temporary copy and runs project code under the SSH account.'
};

module.exports = { registerSshBuild, maven, gradle };
