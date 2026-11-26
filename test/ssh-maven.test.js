'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { test } = require('node:test');
const { mavenConfig, validMavenResult } = require('../src/remote/ssh-maven');
const { mavenProgram, mavenRequest } = require('../src/remote/ssh-maven-runtime');
const { connectWorkspace } = require('../src/remote/ssh-workspace');
const { pythonCommand } = require('../src/remote/ssh-files-worker');
const { startSshProcessFixture } = require('./helpers/ssh-process-fixture');
const { startLinuxOpenSshFixture } = require('./helpers/linux-openssh-fixture');
const { stageMaven, ordinaryPom, testSource, sourceText, virtualPom } = require('./helpers/ssh-maven-fixture');

const { ROCKETBRAIN_SSH_PROCESS_TEST_PYTHON: python, ROCKETBRAIN_SSH_PROCESS_TEST_ASYNCSSH: pythonPackage,
  ROCKETBRAIN_SSH_PROCESS_TEST_JDK: javaHome, ROCKETBRAIN_SSH_MAVEN_TEST_HOME: mavenHome,
  ROCKETBRAIN_SSH_MAVEN_TEST_CACHE: cache, ROCKETBRAIN_OPENSSH_TEST_SSHD: daemon,
  ROCKETBRAIN_SPRING_PROJECT_CONFIG: spring, ROCKETBRAIN_SSH_MAVEN_TEST_RECEIPT: receipt } = process.env;

test('reviewed SSH Maven selects exact saved POMs and fixed lifecycle tasks', () => {
  const input = { file: virtualPom, task: 'test', javaHome: 'C:/tools/jdk', mavenHome: 'C:/tools/maven', repository: 'C:/repo' };
  const checked = mavenConfig('C:/workspace', input);
  assert.equal(checked.project, '/service with space');
  for (const file of ['/other.gradle', '/../pom.xml', '/.git/pom.xml', '/.mvn/pom.xml', '/my%20dir/pom.xml']) {
    assert.throws(() => mavenConfig('C:/workspace', { ...input, file }), /physical remote pom\.xml/u);
  }
  assert.throws(() => mavenConfig('C:/workspace', { ...input, task: 'validate -Duser.home=/other' }), /standard Maven/u);
  assert.throws(() => mavenConfig('C:/workspace', { ...input, repository: '/repo' }), /paths on the SSH host/u);
  const [worker, body, ending] = mavenRequest(checked).split('\n');
  assert.match(worker, /^[A-Za-z0-9+/]+=*$/u);
  assert.equal(JSON.parse(body).file, virtualPom);
  assert.equal(ending, '');
  assert.ok(pythonCommand('py -3', mavenProgram).length < 1024);
  assert.equal(validMavenResult({ state: 'succeeded', task: 'package', exitCode: 0,
    tests: { tests: 0, failures: 0, errors: 0, skipped: 0, reports: 0 } }, { task: 'package' }), false);
});

async function until(check, message) {
  for (let index = 0; index < 220; index++) {
    if (await check()) return;
    await delay(100);
  }
  throw Error('Timed out waiting for ' + message);
}

test('real pinned SSH reviews Maven, runs tests and packages a private offline snapshot', {
  timeout: 600000, skip: !(javaHome && mavenHome && (daemon || (python && pythonPackage)))
}, async context => {
  const abort = new AbortController();
  let fixture, connection;
  const cleanups = [];
  try {
    fixture = daemon ? await startLinuxOpenSshFixture(daemon, action => cleanups.push(action)) :
      await startSshProcessFixture({ python, pythonPackage, ownWorkerTemp: true }, action => cleanups.push(action));
    const scoped = await stageMaven(fixture, { javaHome, mavenHome }, spring, cache);
    await assert.rejects(connectWorkspace({ ...fixture.profile, knownHostsPath: fixture.wrongPin }), /Verify the SSH host key/u);
    connection = await connectWorkspace(fixture.profile);
    const input = { file: scoped.virtualPom, javaHome, mavenHome, repository: scoped.repository };
    const inspect = (task = 'test') => connection.inspectProcess('maven', { ...input, task });
    const run = (review, options) => connection.openProcess('maven', { token: review.token, allowRemoteProcess: true,
      task: review.task, file: scoped.virtualPom, ...options });
    const first = await inspect();
    const before = await connection.read(scoped.virtualPom);
    assert.equal(first.descriptorSha256, before.sha256);
    assert.equal(first.sourceFiles, spring ? 3 : 2);
    assert.ok(first.repositoryFiles > 2);
    await assert.rejects(connection.openProcess('maven', { token: first.token }), /approve/u);
    const tests = await run(first);
    assert.deepEqual(tests, { state: 'succeeded', task: 'test', exitCode: 0,
      tests: { tests: 1, failures: 0, errors: 0, skipped: 0, reports: 1 } });
    await assert.rejects(run(first), /current SSH process review/u);

    const taskMismatch = await inspect();
    await assert.rejects(run(taskMismatch, { task: 'package' }), /exact remote Maven POM and task/u);
    const packageResult = await run(await inspect('package'));
    assert.equal(packageResult.state, 'succeeded');
    assert.equal(packageResult.artifact.name, 'reviewed-remote-1.0.jar');
    assert.match(packageResult.artifact.sha256, /^[a-f0-9]{64}$/u);
    assert.ok(packageResult.artifact.size > 100);

    const sourceStale = await inspect();
    await fs.appendFile(scoped.source, '// changed after review\n');
    await assert.rejects(run(sourceStale), /changed after review/u);
    await fs.writeFile(scoped.source, sourceText);
    const cacheStale = await inspect();
    const file = path.join(scoped.repository, 'junit', 'junit', '4.13.2', 'junit-4.13.2.pom'), saved = await fs.readFile(file);
    try {
      await fs.appendFile(file, '\n');
      await assert.rejects(run(cacheStale), /offline repository changed after review/u);
    } finally { await fs.writeFile(file, saved); }

    await fs.writeFile(scoped.pom, ordinaryPom.replace('</project>', '<modules><module>hidden</module></modules></project>'));
    await assert.rejects(inspect(), /one literal Maven JAR POM/u);
    await fs.writeFile(scoped.pom, ordinaryPom);

    await fs.writeFile(scoped.testFile, testSource.replace('assertEquals(2,', 'assertEquals(3,'));
    const failed = await run(await inspect());
    assert.equal(failed.state, 'failed');
    assert.equal(failed.tests.failures, 1);
    await fs.writeFile(scoped.testFile, testSource.replace('assertEquals(2,', 'Thread.sleep(12000); assertEquals(2,'));
    const pending = assert.rejects(run(await inspect(), { signal: abort.signal }), /Maven build was cancelled/u);
    try {
      await until(async () => {
        for (const item of await fs.readdir(fixture.workerTemp)) {
          if (item.startsWith('rb-ssh-maven-') && (await fs.stat(path.join(fixture.workerTemp, item, 'project', 'target', 'test-classes'))
            .catch(error => error.code === 'ENOENT' ? undefined : Promise.reject(error)))?.isDirectory()) return true;
        }
        return false;
      }, 'a running Maven test snapshot');
    } finally { abort.abort(); }
    await pending;
    await until(async () => !(await fs.readdir(fixture.workerTemp)).length, 'owned Maven scratch cleanup');
    await fs.writeFile(scoped.testFile, testSource);

    assert.equal((await connection.read(scoped.virtualPom)).sha256, before.sha256);
    assert.ok(!(await fs.readdir(scoped.module)).includes('target'));
    const facts = { sourceCommit: process.env.GITHUB_SHA || null, platform: process.platform,
      stockOpenSshDaemon: Boolean(fixture.stockOpenSshDaemon), pinnedSsh: true, mavenTests: tests.tests.tests,
      jdbcEngine: scoped.database || null, artifact: packageResult.artifact, oneShot: true, wrongHostRejected: true,
      changedSourceRejected: true, changedOfflineRepositoryRejected: true, unsupportedReactorRejected: true,
      observedTestFailure: true, cancelledBuildCleaned: true, workspaceUnchanged: true };
    if (receipt) await fs.writeFile(receipt, JSON.stringify(facts, null, 2) + '\n');
    context.diagnostic(JSON.stringify(facts));
  } finally {
    abort.abort();
    await connection?.close();
    for (const action of cleanups.reverse()) await action();
  }
});
