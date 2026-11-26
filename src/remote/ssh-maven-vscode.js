'use strict';

const { posix } = require('node:path');

function registerSshMaven(vscode, command, requireConnection) {
  const output = vscode.window.createOutputChannel('Rocketbrain SSH Maven');
  let active;

  function saved(uri) {
    const directory = posix.dirname(uri.path).replace(/\/$/u, '');
    if (vscode.workspace.textDocuments.some(document => document.isDirty && document.uri.scheme === uri.scheme &&
        document.uri.authority === uri.authority &&
        (document.uri.path === uri.path || document.uri.path.startsWith(directory + '/src/')))) {
      throw Error('Save or discard the remote Maven project edits before continuing.');
    }
  }

  async function inspect(uri, requested) {
    const client = requireConnection(uri);
    saved(uri);
    const original = await client.read(uri.path);
    const review = await client.inspectProcess('maven', { ...requested, file: uri.path });
    if (requireConnection(uri) !== client || review.descriptorSha256 !== original.sha256) {
      throw Error('The remote Maven descriptor changed. Review the saved project again.');
    }
    saved(uri);
    return review;
  }

  async function start(uri, approval, signal) {
    const client = requireConnection(uri);
    if (approval?.allowSshMaven !== true) throw Error('Approve the reviewed remote Maven task first.');
    if (active) throw Error('Wait for the current SSH Maven build to finish.');
    saved(uri);
    const controller = new AbortController(), cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    active = controller;
    try {
      const result = await client.openProcess('maven', { token: approval.token, file: uri.path, task: approval.task,
        allowRemoteProcess: true, signal: controller.signal });
      if (requireConnection(uri) !== client) throw Error('The reviewed SSH workspace changed.');
      return result;
    } finally {
      signal?.removeEventListener('abort', cancel);
      if (active === controller) active = undefined;
    }
  }

  const registered = command('mavenBuild', async entry => {
    const uri = entry?.resourceUri || (entry?.scheme ? entry : vscode.window.activeTextEditor?.document.uri);
    requireConnection(uri);
    if (posix.basename(uri.path) !== 'pom.xml') throw Error('Select the saved remote pom.xml of the Maven project.');
    const task = await vscode.window.showQuickPick(['test', 'package'], { title: 'Select a Maven Lifecycle Task' });
    if (!task) return;
    const paths = {};
    for (const [key, title] of [['javaHome', 'Independent Remote JDK 25 Directory'],
      ['mavenHome', 'Independent Remote Apache Maven 3.9 Directory'],
      ['repository', 'Prepared Remote Offline Maven Repository']]) {
      const value = await vscode.window.showInputBox({ title });
      if (!value) return;
      paths[key] = value;
    }
    const review = await vscode.window.withProgress({ title: 'Review Remote Maven Inputs',
      location: vscode.ProgressLocation.Notification }, () => inspect(uri, { ...paths, task }));
    output.clear();
    output.appendLine('Maven ' + task + ' · ' + review.user + '@' + review.host + ':' + review.port);
    output.appendLine(review.root + review.file);
    output.appendLine('Project SHA-256 ' + review.projectSha256);
    output.appendLine('Descriptor SHA-256 ' + review.descriptorSha256);
    for (const [label, file, hash] of [['Maven', review.mavenHome, review.toolSha256],
      ['JDK', review.javaHome, review.jdkSha256], ['Offline repository', review.repository, review.repositorySha256]]) {
      output.appendLine(label + ' · ' + file);
      output.appendLine('SHA-256 ' + hash);
    }
    output.show(true);
    const chosen = await vscode.window.showWarningMessage('Run the reviewed remote Maven task?', {
      modal: true,
      detail: review.file + '\nMaven ' + task + ' · ' + review.sourceFiles + ' source/resource files and ' +
        review.repositoryFiles + ' cached files. Maven runs the selected project’s code under the SSH account, in a temporary copy.'
    }, 'Run Reviewed Task');
    if (chosen !== 'Run Reviewed Task') return;
    const result = await vscode.window.withProgress({ title: 'Running Reviewed SSH Maven Task', cancellable: true,
      location: vscode.ProgressLocation.Notification }, async (_progress, token) => {
      const controller = new AbortController(), subscription = token.onCancellationRequested(() => controller.abort());
      if (token.isCancellationRequested) controller.abort();
      try { return await start(uri, { token: review.token, task, allowSshMaven: true }, controller.signal); }
      catch (error) { if (controller.signal.aborted) return { state: 'cancelled' }; throw error; }
      finally { subscription.dispose(); }
    });
    output.appendLine(result.state === 'cancelled' ? 'Maven task cancelled.' : 'Maven task ' + result.state + ' · exit ' + result.exitCode);
    if (result.tests) {
      const { tests, failures, errors, skipped, reports } = result.tests;
      output.appendLine(reports ? `${tests} tests, ${failures} failures, ${errors} errors, ${skipped} skipped` : 'No Surefire test reports.');
    }
    if (result.artifact) output.appendLine(result.artifact.name + ' · SHA-256 ' + result.artifact.sha256);
    return result;
  });

  return { inspect, start, retire() { active?.abort(); }, dispose() { active?.abort(); registered.dispose(); output.dispose(); } };
}

module.exports = { registerSshMaven };
