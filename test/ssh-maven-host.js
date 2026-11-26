'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { jdbcReadback } = require('./java-source-analysis-host');
const { startSshProcessFixture } = require('./helpers/ssh-process-fixture');
const { stageMaven } = require('./helpers/ssh-maven-fixture');

async function runSshMavenChecks(api, vscode, checks) {
  const { ROCKETBRAIN_SSH_PROCESS_TEST_JDK: javaHome, ROCKETBRAIN_SSH_PROCESS_TEST_PYTHON: python,
    ROCKETBRAIN_SSH_PROCESS_TEST_ASYNCSSH: pythonPackage, ROCKETBRAIN_SSH_MAVEN_TEST_HOME: mavenHome,
    ROCKETBRAIN_SSH_MAVEN_TEST_CACHE: cache, ROCKETBRAIN_SPRING_PROJECT_CONFIG: spring } = process.env;
  assert.ok(javaHome && python && pythonPackage && mavenHome && spring, 'Provide the owned SSH Maven and Spring fixtures.');
  assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.sshWorkspace.mavenBuild'));
  const workspace = api.sshWorkspace, service = workspace.mavenBuild, preimage = await jdbcReadback();
  let cleanup;
  try {
    const fixture = await startSshProcessFixture({ python, pythonPackage, ownWorkerTemp: true }, action => { cleanup = action; });
    const { virtualPom, repository, module, database } = await stageMaven(fixture, { javaHome, mavenHome }, spring, cache);
    const root = await workspace.attach(fixture.profile);
    const uri = vscode.Uri.joinPath(root, ...virtualPom.slice(1).split('/'));
    const document = await vscode.workspace.openTextDocument(uri);
    assert.match(document.getText(), /reviewed-remote/u);
    const review = await service.inspect(uri, { task: 'package', javaHome, mavenHome, repository });
    assert.deepEqual([review.file, review.task, review.sourceFiles], [virtualPom, 'package', 3]);
    assert.match(review.projectSha256, /^[a-f0-9]{64}$/u);
    await assert.rejects(service.start(uri, { token: review.token, task: 'package' }), /Approve the reviewed/u);
    const approval = { token: review.token, task: 'package', allowSshMaven: true };
    const result = await service.start(uri, approval);
    assert.equal(result.state, 'succeeded');
    assert.deepEqual(result.tests, { reports: 1, tests: 1, failures: 0, errors: 0, skipped: 0 });
    assert.equal(result.artifact.name, 'reviewed-remote-1.0.jar');
    assert.match(result.artifact.sha256, /^[a-f0-9]{64}$/u);
    await assert.rejects(service.start(uri, approval), /current SSH process review/u);
    assert.ok(!(await fs.readdir(module)).includes('target'));
    assert.deepEqual(await fs.readdir(fixture.workerTemp), []);
    assert.deepEqual(await jdbcReadback(), preimage);
    checks.sshMaven = { database, nativeRemotePom: true, nativeCommand: true, tests: result.tests.tests,
      artifact: result.artifact, oneShot: true, sourceUntouched: true, workspaceClean: true, jdbcUnchanged: true };
  } finally {
    workspace.close();
    await cleanup?.();
  }
}

module.exports = { runSshMavenChecks };
