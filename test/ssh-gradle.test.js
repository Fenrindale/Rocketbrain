'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { connectWorkspace } = require('../src/remote/ssh-workspace');
const { gradleConfig, validGradleResult } = require('../src/remote/ssh-gradle');
const { gradleProgram, gradleRequest } = require('../src/remote/ssh-gradle-runtime');
const { pythonCommand } = require('../src/remote/ssh-files-worker');
const { startSshProcessFixture } = require('./helpers/ssh-process-fixture');
const { startLinuxOpenSshFixture } = require('./helpers/linux-openssh-fixture');
const { stageGradle, settings, build, virtualBuild } = require('./helpers/ssh-gradle-fixture');
const { testSource } = require('./helpers/ssh-maven-fixture');

const { ROCKETBRAIN_SSH_PROCESS_TEST_JDK: javaHome, ROCKETBRAIN_SSH_PROCESS_TEST_PYTHON: python,
  ROCKETBRAIN_SSH_PROCESS_TEST_ASYNCSSH: pythonPackage, ROCKETBRAIN_SSH_GRADLE_TEST_HOME: gradleHome,
  ROCKETBRAIN_SSH_GRADLE_TEST_MIRROR: mirror, ROCKETBRAIN_OPENSSH_TEST_SSHD: daemon,
  ROCKETBRAIN_SPRING_PROJECT_CONFIG: spring, ROCKETBRAIN_SSH_GRADLE_TEST_RECEIPT: receipt } = process.env;

test('SSH Gradle validates a conventional build descriptor, fixed tasks and bounded task graph', () => {
  const opts = { file: virtualBuild, task: 'test', javaHome: '/opt/jdk', gradleHome: '/opt/gradle', repository: '/opt/mirror' };
  const config = gradleConfig('/srv/owned', opts);
  assert.equal(config.project, '/gradle with space');
  for (const file of ['/build.gradle.kts', '/test/../build.gradle', '/other/gradle.gradle', '/.git/build.gradle']) {
    assert.throws(() => gradleConfig('/srv/owned', { ...opts, file }), /build.gradle/u);
  }
  assert.throws(() => gradleConfig('/srv/owned', { ...opts, task: 'test --scan' }), /standard/u);
  const [worker, body, ending] = gradleRequest(config).split('\n');
  assert.equal(JSON.parse(body).file, virtualBuild);
  assert.equal(ending, '');
  assert.ok(worker.length < 12289 && pythonCommand('py -3', gradleProgram).length < 1024);
  const outcome = { state: 'succeeded', task: 'test', exitCode: 0,
    tests: { reports: 1, tests: 1, failures: 0, errors: 0, skipped: 0 }, taskGraph: [':compileJava', ':test'] };
  assert.equal(validGradleResult(outcome, config), true);
  assert.equal(validGradleResult({ ...outcome, taskGraph: [':test', ':test'] }, config), false);
  assert.equal(validGradleResult({ ...outcome, taskGraph: [':buildSrc:run', ':test'] }, config), false);
});

async function until(check, timeout, description) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await delay(125);
  }
  throw Error('Timed out waiting for ' + description);
}

test('real pinned SSH runs the reviewed Gradle task graph against an isolated offline mirror', {
  timeout: 690000, skip: !(javaHome && gradleHome && (daemon || (python && pythonPackage)))
}, async context => {
  const cleanup = [];
  const cancellation = new AbortController();
  let connection;
  try {
    const fixture = daemon ? await startLinuxOpenSshFixture(daemon, action => cleanup.push(action)) :
      await startSshProcessFixture({ python, pythonPackage, ownWorkerTemp: true }, action => cleanup.push(action));
    const project = await stageGradle(fixture, spring, mirror);
    await assert.rejects(connectWorkspace({ ...fixture.profile, knownHostsPath: fixture.wrongPin }), /Verify the SSH host key/u);
    connection = await connectWorkspace(fixture.profile);
    const selected = { file: virtualBuild, javaHome, gradleHome, repository: project.repository };
    const inspect = (task = 'test') => connection.inspectProcess('gradle', { ...selected, task });
    const run = (review, signal) => connection.openProcess('gradle', { file: virtualBuild, task: review.task, token: review.token,
      allowRemoteProcess: true, signal });
    const descriptor = await connection.read(virtualBuild);
    const reviewed = await inspect();
    assert.equal(reviewed.descriptorSha256, descriptor.sha256);
    assert.equal(reviewed.repositoryFiles, 5);
    assert.equal(reviewed.sourceFiles, spring ? 3 : 2);
    await assert.rejects(connection.openProcess('gradle', { token: reviewed.token }), /approve/u);
    const first = await run(reviewed);
    assert.equal(first.state, 'succeeded', 'Gradle test must run against the pinned staged project and repository');
    assert.deepEqual(first.tests, { reports: 1, tests: 1, failures: 0, errors: 0, skipped: 0 });
    assert.ok(first.taskGraph.includes(':compileTestJava'));
    assert.equal(first.taskGraph.at(-1), ':test');
    await assert.rejects(run(reviewed), /current SSH process review/u);

    const packaged = await run(await inspect('build'));
    assert.equal(packaged.state, 'succeeded');
    assert.ok(packaged.taskGraph.includes(':jar') && packaged.taskGraph.includes(':test'));
    assert.equal(packaged.taskGraph.at(-1), ':build');
    assert.equal(packaged.artifact.name, 'reviewed-gradle-1.0.jar');
    assert.match(packaged.artifact.sha256, /^[0-9a-f]{64}$/u);

    const stale = await inspect();
    await fs.appendFile(project.settingsFile, '// added after review\n');
    await assert.rejects(run(stale), /changed after review/u);
    await fs.writeFile(project.settingsFile, settings + "include 'extra'\n");
    await assert.rejects(inspect(), /standard Groovy Java project/u);
    await fs.writeFile(project.settingsFile, settings);
    await fs.writeFile(project.buildFile, build + "tasks.register('send') {}\n");
    await assert.rejects(inspect(), /standard Groovy Java project/u);
    await fs.writeFile(project.buildFile, build);

    const marker = [
      'java.nio.file.Files.writeString(java.nio.file.Path.of(System.getProperty("user.dir"), "remote-cancel-ready"), String.valueOf(ProcessHandle.current().pid()));',
      'Thread.sleep(60000);', 'assertEquals(2,'
    ].join('\n    ');
    await fs.writeFile(project.testFile, testSource.replace('assertEquals(2,', marker));
    const pending = assert.rejects(run(await inspect(), cancellation.signal), /Gradle build was cancelled/u);
    let workerPid;
    try {
      await until(async () => {
        for (const item of await fs.readdir(fixture.workerTemp)) {
          if (!item.startsWith('rb-ssh-gradle-')) continue;
          const value = await fs.readFile(path.join(fixture.workerTemp, item, 'project', 'remote-cancel-ready'), 'utf8')
            .catch(error => error.code === 'ENOENT' ? undefined : Promise.reject(error));
          if (/^[1-9]\d{0,9}$/u.test(value || '') && Number(value) <= 0x7fffffff) {
            workerPid = Number(value);
            process.kill(workerPid, 0);
            return true;
          }
        }
        return false;
      }, 120000, 'the active remote Gradle JUnit test');
    } finally { cancellation.abort(); }
    await pending;
    await until(() => {
      try { process.kill(workerPid, 0); return false; }
      catch (error) { if (error.code === 'ESRCH') return true; throw error; }
    }, 25000, 'the exact Gradle test JVM to exit');
    await until(async () => !(await fs.readdir(fixture.workerTemp)).length, 25000, 'Gradle snapshot and worker cleanup');
    await fs.writeFile(project.testFile, testSource);
    assert.ok(!(await fs.readdir(project.module)).includes('build'));
    assert.equal((await connection.read(virtualBuild)).sha256, descriptor.sha256);
    const result = { sourceCommit: process.env.GITHUB_SHA || null, platform: process.platform,
      stockOpenSshDaemon: Boolean(fixture.stockOpenSshDaemon), database: project.database || null, gradleVersion: reviewed.gradleVersion,
      tests: first.tests.tests, graph: packaged.taskGraph, artifact: packaged.artifact, pinnedSsh: true, oneShot: true,
      changedSettingsRejected: true, compositeAndCustomTasksRejected: true, cancelledActiveJUnitAndCleaned: true,
      workspaceUnchanged: true };
    if (receipt) await fs.writeFile(receipt, JSON.stringify(result, null, 2) + '\n');
    context.diagnostic(JSON.stringify(result));
  } finally {
    cancellation.abort();
    await connection?.close();
    for (const action of cleanup.reverse()) await action();
  }
});
