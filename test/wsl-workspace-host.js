'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

async function awaitCancellationMarker(file) {
  const until = Date.now() + 90000;
  while (Date.now() < until) {
    if (await fs.access(file).then(() => true, () => false)) return;
    await delay(200);
  }
  throw Error('Gradle did not reach the cancellation fixture.');
}

async function runWslChecks(api, vscode, checks) {
  const distribution = process.env.ROCKETBRAIN_WSL_TEST_DISTRIBUTION;
  assert.match(distribution, /^RocketbrainFixture-[a-f0-9]{12}$/u);
  const workspace = await fs.realpath(process.env.ROCKETBRAIN_WSL_TEST_WORKSPACE);
  assert.ok(vscode.workspace.isTrusted);
  const folders = (vscode.workspace.workspaceFolders || []).filter(item => item.uri.scheme === 'file');
  let folder;
  for (const candidate of folders) {
    const canonical = await fs.realpath(candidate.uri.fsPath);
    if (canonical.toLowerCase() === workspace.toLowerCase()) folder = candidate;
  }
  assert.ok(folder, 'The owned Windows WSL fixture must be opened in VS Code. Open local folders: '
    + (folders.map(item => path.basename(item.uri.fsPath)).join(', ') || '(none)'));
  const { wsl } = api;
  const commands = await vscode.commands.getCommands(true);
  for (const id of ['rocketbrain.wsl.distributions', 'rocketbrain.wsl.reviewBuild', 'rocketbrain.wsl.cancelBuild']) assert.ok(commands.includes(id));
  assert.ok((await wsl.distributions()).includes(distribution));
  const mapping = await wsl.mapping(distribution, folder.uri);
  assert.equal(mapping.windows.toLowerCase(), workspace.toLowerCase());
  assert.match(mapping.linux, /^\/mnt\/[a-z]\/.*\/Spring workspace$/u);
  await assert.rejects(wsl.mapping(distribution, vscode.Uri.file(path.dirname(workspace))), /inside an open local workspace/u);
  const options = { distribution, projectUri: folder.uri };
  const pom = path.join(workspace, 'pom.xml');
  const original = await fs.readFile(pom);
  const stale = await wsl.review({ ...options, system: 'maven', goal: 'package' });
  try {
    await fs.appendFile(pom, '\n<!-- Changed after test approval. -->\n');
    await assert.rejects(wsl.apply(stale.token, { approved: true }), /changed after review/u);
  } finally { await fs.writeFile(pom, original); }

  async function build(system, goal, expectedFile, expectedOutput) {
    const review = await wsl.review({ ...options, system, goal });
    const result = await wsl.apply(review.token, { approved: true });
    assert.equal(result.code, 0, result.output.slice(-4500));
    assert.equal(result.cancelled, false);
    assert.match(result.output, expectedOutput);
    assert.ok((await fs.stat(path.join(workspace, expectedFile))).size > 0);
  }

  await build('maven', 'package', 'target/spring-workbench-1.0.0.jar', /BUILD SUCCESS/u);
  await build('gradle', 'classes', 'build/classes/java/main/fixture/WslSpringConfiguration.class', /BUILD SUCCESSFUL/u);
  const running = await wsl.review({ ...options, system: 'gradle', goal: 'build' });
  const buildExecution = wsl.apply(running.token, { approved: true });
  try {
    await Promise.race([awaitCancellationMarker(path.join(workspace, 'cancel-started')), buildExecution.then(result => {
      throw Error('Build exited before cancellation: ' + result.output.slice(-4500));
    })]);
    assert.equal(await wsl.cancel(), true);
    const result = await buildExecution;
    assert.equal(result.cancelled, true);
    assert.notEqual(result.code, 0);
    await assert.rejects(fs.access(path.join(workspace, 'cancel-finished')), { code: 'ENOENT' });
  } finally {
    await wsl.cancel().catch(() => false);
    await buildExecution.catch(() => {});
  }
  assert.deepEqual(await wsl.mapping(distribution, folder.uri), mapping);
  checks.wsl = { commandCount: 3, mavenGoal: 'package', gradleGoal: 'classes', compiledSpringConfiguration: true,
    workspaceRoundTrip: true, rejectedOutsideWorkspace: true, rejectedChangedDescriptor: true,
    cancelledManagedBuild: true, distroStillAvailable: true };
}

async function run() {
  const vscode = require('vscode');
  const extension = vscode.extensions.getExtension('rocketbrain-local.rocketbrain');
  assert.ok(extension);
  const api = await extension.activate();
  const checks = {};
  await runWslChecks(api, vscode, checks);
  await fs.writeFile(process.env.ROCKETBRAIN_TEST_OUTPUT, JSON.stringify({ vscode: vscode.version, checks }, null, 2) + '\n');
}

module.exports = { runWslChecks, run };
