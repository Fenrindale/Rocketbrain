'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { setTimeout: delay } = require('node:timers/promises');
const { test } = require('node:test');
const { connectWorkspace } = require('../src/remote/ssh-workspace');
const { compileConfig } = require('../src/remote/ssh-java-compile');
const { compileProgram } = require('../src/remote/ssh-java-compile-runtime');
const { pythonCommand } = require('../src/remote/ssh-files-worker');
const { startSshProcessFixture } = require('./helpers/ssh-process-fixture');
const { stageJavaCompile } = require('./helpers/ssh-java-compile-fixture');

const invoke = promisify(execFile);
const { ROCKETBRAIN_SSH_PROCESS_TEST_PYTHON: python, ROCKETBRAIN_SSH_PROCESS_TEST_ASYNCSSH: pythonPackage,
  ROCKETBRAIN_SSH_PROCESS_TEST_JDK: javaHome, ROCKETBRAIN_SPRING_PROJECT_CONFIG: springConfig,
  ROCKETBRAIN_SSH_COMPILE_TEST_RECEIPT: receiptFile } = process.env;

test('SSH Java compile binds one module and rejects ambiguous, escaping and folded dependency paths', () => {
  const file = '/my service/src/main/java/sample/Hello.java', jdk = 'C:/tools/jdk25';
  assert.equal(compileConfig('C:/workspace', { file, javaHome: jdk, jars: ['/libs/library.jar'] }).module, '/my service');
  assert.throws(() => compileConfig('C:/workspace', { file, javaHome: '/opt/jdk25' }), /absolute JDK path/);
  assert.throws(() => compileConfig('C:/workspace', { file: '/file.java', javaHome: jdk }), /one conventional/);
  assert.throws(() => compileConfig('C:/workspace', { file: '/src/main/java/src/main/java/Hi.java', javaHome: jdk }), /one conventional/);
  assert.throws(() => compileConfig('C:/workspace', { file, javaHome: jdk, jars: ['/../x.jar'] }), /physical/);
  assert.throws(() => compileConfig('C:/workspace', { file, javaHome: jdk, jars: ['/libs/A.jar', '/libs/a.jar'] }), /distinct/);
  assert.ok(pythonCommand('py -3', compileProgram).length < 7950);
});

async function waitUntil(check, label) {
  for (let i = 0; i < 300; i++) {
    if (await check()) return;
    await delay(40);
  }
  throw Error('Timed out waiting for ' + label);
}

test('actual pinned SSH compiles a scoped Java module, reports exact diagnostics and releases scoped output', {
  timeout: 165000, skip: !(python && pythonPackage && javaHome)
}, async context => {
  const fixture = await startSshProcessFixture({ python, pythonPackage, ownWorkerTemp: true }, callback => context.after(callback));
  const scoped = await stageJavaCompile(fixture, springConfig);
  await assert.rejects(connectWorkspace({ ...fixture.profile, knownHostsPath: fixture.wrongPin }), /Verify the SSH host key/);
  const connection = await connectWorkspace(fixture.profile);
  context.after(() => connection.close());
  const args = { file: scoped.selectedFile, javaHome, jars: scoped.jars };
  const inspect = changes => connection.inspectProcess('compile', { ...args, ...changes });
  const run = (review, extra) => connection.openProcess('compile', { allowRemoteProcess: true,
    token: review.token, file: scoped.selectedFile, ...extra });
  const first = await inspect();
  assert.equal(first.module, scoped.module);
  assert.equal(first.sourceCount, 2);
  assert.equal(first.selectedSha256, (await connection.read(scoped.selectedFile)).sha256);
  assert.match(first.jdkSha256, /^[0-9a-f]{64}$/u);
  await assert.rejects(connection.openProcess('compile', { token: first.token }), /approve/);
  const result = await run(first);
  assert.equal(result.state, 'compiled', JSON.stringify(result));
  assert.deepEqual(result.classes, ['compilefixture/AccountRead.class', 'compilefixture/TableName.class']);
  assert.match(result.artifactSha256, /^[0-9a-f]{64}$/u);
  await assert.rejects(run(first), /current SSH process review/);
  assert.deepEqual(await fs.readdir(fixture.workerTemp), []);
  assert.ok(!(await fs.readdir(path.join(fixture.profile.root, scoped.module))).includes('target'));

  const mismatch = await inspect();
  await assert.rejects(run(mismatch, { file: '/modules/other/src/main/java/Irrelevant.java' }), /exact remote Java source/);
  const stale = await inspect();
  await fs.writeFile(scoped.companionFile, scoped.companionText + '// changed after review\n');
  await assert.rejects(run(stale), /changed after review/);
  await fs.writeFile(scoped.companionFile, 'package compilefixture; final class TableName {}\n');
  const broken = await run(await inspect());
  assert.equal(broken.state, 'failed');
  assert.equal(broken.diagnostics[0].path, 'compilefixture/AccountRead.java');
  assert.equal(broken.diagnostics[0].sha256, first.selectedSha256);
  assert.match(broken.diagnostics[0].code, /compiler\.err\.cant\.resolve/u);
  await fs.writeFile(scoped.companionFile, scoped.companionText);

  const jar = path.join(javaHome, 'bin', process.platform === 'win32' ? 'jar.exe' : 'jar');
  const manifest = path.join(fixture.profile.root, 'manifest.txt');
  await fs.writeFile(manifest, 'Manifest-Version: 1.0\r\nClass-Path: other.jar\r\n\r\n');
  await invoke(jar, ['--create', '--file', 'external.jar', '--manifest', 'manifest.txt'], {
    cwd: fixture.profile.root, windowsHide: true, timeout: 12000
  });
  await assert.rejects(inspect({ jars: ['/external.jar'] }), /external manifest Class-Path/);
  if (scoped.jars.length) {
    const library = path.join(fixture.profile.root, scoped.jars[0]);
    const bytes = await fs.readFile(library);
    const reviewed = await inspect();
    try {
      await fs.appendFile(library, Buffer.from([0]));
      await assert.rejects(run(reviewed), /changed after review/);
    } finally {
      await fs.writeFile(library, bytes);
    }
  }

  const controller = new AbortController();
  const pending = run(await inspect(), { signal: controller.signal });
  const cancelled = assert.rejects(pending, /compile was cancelled/);
  try {
    await waitUntil(async () => {
      for (const candidate of await fs.readdir(fixture.workerTemp)) {
        if (candidate.startsWith('rb-ssh-compile-') && (await fs.readdir(path.join(fixture.workerTemp, candidate))
          .catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error))).includes('diagnostics')) return true;
      }
      return false;
    }, 'the owned remote compiler stage');
  } finally { controller.abort(); }
  await cancelled;
  await waitUntil(async () => (await fs.readdir(fixture.workerTemp)).length === 0, 'remote compile cleanup');
  assert.equal((await connection.read(scoped.selectedFile)).sha256, first.selectedSha256);
  const facts = { sourceCommit: process.env.GITHUB_SHA || null, platform: process.platform, asyncssh: fixture.asyncssh,
    classCount: result.classCount, artifactSha256: result.artifactSha256, typedSpringJars: scoped.framework,
    compilerDiagnostic: broken.diagnostics[0].code, exactDiagnosticNavigationTarget: true,
    wrongHostRejected: true, oneShot: true, changedCompanionRejected: true, externalClasspathRejected: true,
    cancelledScopedCompile: true, workspaceAndFileReadsPreserved: true, temporaryOutputsCleaned: true,
    ...(scoped.jars.length > 0 && { changedJarRejected: true }) };
  if (receiptFile) await fs.writeFile(receiptFile, JSON.stringify(facts, null, 2) + '\n');
  context.diagnostic(JSON.stringify(facts));
});
