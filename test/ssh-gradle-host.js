'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { jdbcReadback } = require('./java-source-analysis-host');
const { startSshProcessFixture } = require('./helpers/ssh-process-fixture');
const { stageGradle } = require('./helpers/ssh-gradle-fixture');

async function runSshGradleChecks(api, vscode, checks) {
  const { ROCKETBRAIN_SSH_PROCESS_TEST_JDK: javaHome, ROCKETBRAIN_SSH_PROCESS_TEST_PYTHON: python,
    ROCKETBRAIN_SSH_PROCESS_TEST_ASYNCSSH: pythonPackage, ROCKETBRAIN_SSH_GRADLE_TEST_HOME: gradleHome,
    ROCKETBRAIN_SSH_GRADLE_TEST_MIRROR: mirror, ROCKETBRAIN_SPRING_PROJECT_CONFIG: spring } = process.env;
  assert.ok(javaHome && python && pythonPackage && gradleHome && spring, 'Provide the owned SSH Gradle and Spring fixtures.');
  assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.sshWorkspace.gradleBuild'));
  const workspace = api.sshWorkspace, builds = workspace.gradleBuild, baseline = await jdbcReadback();
  let cleanup;
  try {
    const fixture = await startSshProcessFixture({ python, pythonPackage, ownWorkerTemp: true }, action => { cleanup = action; });
    const { virtualBuild, module, repository, database } = await stageGradle(fixture, spring, mirror);
    const root = await workspace.attach(fixture.profile);
    const uri = vscode.Uri.joinPath(root, ...virtualBuild.slice(1).split('/'));
    const document = await vscode.workspace.openTextDocument(uri);
    assert.match(document.getText(), /testImplementation/u);
    const review = await builds.inspect(uri, { task: 'build', javaHome, gradleHome, repository });
    assert.deepEqual([review.file, review.sourceFiles, review.repositoryFiles], [virtualBuild, 3, 5]);
    assert.match(review.settingsSha256, /^[a-f0-9]{64}$/u);
    await assert.rejects(builds.start(uri, { token: review.token, task: 'build' }), /Approve the reviewed/u);
    const approval = { token: review.token, task: 'build', allowSshGradle: true };
    const result = await builds.start(uri, approval);
    assert.equal(result.state, 'succeeded');
    assert.deepEqual(result.tests, { reports: 1, tests: 1, failures: 0, errors: 0, skipped: 0 });
    assert.ok(result.taskGraph.includes(':jar') && result.taskGraph.includes(':test'));
    assert.equal(result.taskGraph.at(-1), ':build');
    assert.equal(result.artifact.name, 'reviewed-gradle-1.0.jar');
    await assert.rejects(builds.start(uri, approval), /current SSH process review/u);
    assert.ok(!(await fs.readdir(module)).includes('build'));
    assert.deepEqual(await fs.readdir(fixture.workerTemp), []);
    assert.deepEqual(await jdbcReadback(), baseline);
    checks.sshGradle = { database, nativeBuildDescriptor: true, taskGraph: result.taskGraph, tests: result.tests.tests,
      artifact: result.artifact, oneShot: true, scratchClean: true, jdbcUnchanged: true };
  } finally {
    workspace.close();
    await cleanup?.();
  }
}

module.exports = { runSshGradleChecks };
