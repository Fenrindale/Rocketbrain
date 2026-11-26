'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');
const { prepareCoroutineProbe, readCoroutineDescriptor, fetchCoroutineSnapshot, readSnapshot } = require('../src/java/kotlin-coroutine-probe');
const { COROUTINE_BUILD, WATCH_BUILD, resolveDebugBundle } = require('../src/java/debug-runtime');
const { resolveLaunch, serverSettings } = require('../src/java/runtime');
const { DapClient, freePort } = require('./java-debug-dap');
const { StdioLsp, until } = require('./helpers/stdio-lsp');
const { buildCoroutineFixture, launchCoroutineFixture } = require('./helpers/coroutine-fixture');
const { REQUEST, EVENT, watchTarget, watchRequest, jdbcOptions, jdbcResult } = require('./helpers/coroutine-watch-fixture');

const configFile = process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;
const gradleHome = process.env.ROCKETBRAIN_COROUTINE_GRADLE_HOME;
const classpathFile = process.env.ROCKETBRAIN_COROUTINE_WATCH_CLASSPATH;
const dbFiles = ['mysql', 'mariadb'].map(engine => [engine, process.env['ROCKETBRAIN_COROUTINE_WATCH_' + engine.toUpperCase() + '_CONFIG']]);

test('coroutine watch requires the opted-in session and its exact suspended Kotlin location', async () => {
  const descriptor = { pid: 19, session: randomUUID(), debugPort: 50161 };
  const frame = { sequence: '7', className: 'sample.Frame$1', file: 'Sample.kt', line: 10 };
  const entry = { name: 'sample', state: 'SUSPENDED', creation: [],
    observed: [{ ...frame, method: 'invokeSuspend' }], debugFrame: frame };
  const value = { format: 'RocketbrainCoroutineSnapshot', version: 1, pid: descriptor.pid, session: descriptor.session,
    capturedAt: '2026-11-25T01:02:03.04Z', creationEnabled: true, truncated: false, debugCapture: randomUUID(), coroutines: [entry] };
  assert.deepEqual(readSnapshot(value, descriptor).coroutines[0].debugFrame, frame);
  assert.throws(() => readSnapshot(value, { ...descriptor, debugPort: undefined }), /outside the opted-in/u);
  assert.throws(() => readSnapshot({ ...value, coroutines: [{ ...entry, state: 'RUNNING' }] }, descriptor), /parked source frame/u);
  assert.throws(() => readSnapshot({ ...value, coroutines: [entry, entry] }, descriptor), /parked source frame/u);
  await assert.rejects(prepareCoroutineProbe({ workspaceTrusted: true, allowProbeWrites: true, debugPort: 0 }), /TCP port/u);
});

test('patched real JDT attaches to a running opted-in JVM, stops only the selected Kotlin continuation and detaches on actual Spring JDBC', {
  skip: !configFile || !gradleHome || !classpathFile || !dbFiles.every(([, file]) => file), timeout: 300000
}, async t => {
  const runtime = JSON.parse(await fs.readFile(configFile, 'utf8'));
  const javaHome = runtime.javaHome, serverPath = runtime.serverPath;
  const bundle = resolveDebugBundle(runtime.settings?.['rocketbrain.java.debugBundlePath'], serverPath);
  assert.ok([COROUTINE_BUILD, WATCH_BUILD].includes(bundle?.build));
  const parent = await fs.realpath(os.tmpdir()), owned = await fs.mkdtemp(path.join(parent, 'rb-coro-dap-'));
  let lsp;
  t.after(async () => {
    if (lsp) await lsp.close();
    assert.equal(await fs.realpath(owned), owned);
    assert.equal(path.dirname(owned), parent);
    await fs.rm(owned, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  });
  const fixture = await buildCoroutineFixture(path.join(owned, 'kotlin'), { javaHome, gradleHome,
    gradleUserHome: process.env.ROCKETBRAIN_COROUTINE_GRADLE_USER_HOME || path.join(owned, 'gradle-cache') });
  const workspace = path.join(owned, 'workspace');
  await fs.cp(path.resolve('test/fixtures/java/maven'), workspace, { recursive: true });
  const rootUri = pathToFileURL(workspace).href;
  lsp = new StdioLsp(resolveLaunch({ javaHome, serverPath, storagePath: path.join(owned, 'lsp'), debugBundlePath: bundle.path }));
  await lsp.request('initialize', { processId: process.pid, rootUri, workspaceFolders: [{ uri: rootUri, name: 'Kotlin debug workspace' }],
    capabilities: { workspace: { configuration: true } }, initializationOptions: {
      bundles: [bundle.path], workspaceFolders: [rootUri], settings: serverSettings([{ name: 'JavaSE-25', path: javaHome, default: true }])
    } }, 90000);
  lsp.notify('initialized', {});
  const sourceRoot = path.join(fixture.root, 'src/main/kotlin');
  const reports = [];
  for (const [engine, configFile] of dbFiles) {
    const debugPort = await freePort();
    const prepared = await prepareCoroutineProbe({ javaHome, workspaceTrusted: true, allowProbeWrites: true,
      debugJar: fixture.debugJar, debugPort, storageRoot: owned });
    const running = launchCoroutineFixture(fixture, prepared, await jdbcOptions({ engine, classpathFile, configFile }));
    let dap;
    try {
      await running.ready();
      const descriptor = await readCoroutineDescriptor(prepared.descriptor);
      assert.equal(descriptor.pid, running.pid);
      assert.equal(descriptor.debugPort, debugPort);
      const snapshot = await fetchCoroutineSnapshot(descriptor);
      const picked = watchTarget(snapshot);
      const port = await until(() => lsp.request('workspace/executeCommand', { command: 'vscode.java.startDebugSession', arguments: [] }, 10000), 65000);
      dap = new DapClient(port);
      await dap.request('initialize', { adapterID: 'rocketbrain-java', clientID: 'rocketbrain-raw-test',
        linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path' });
      const attach = dap.request('attach', { hostName: '127.0.0.1', port: descriptor.debugPort, sourcePaths: [sourceRoot] });
      void attach.catch(() => {});
      await dap.event('initialized');
      await dap.request('configurationDone');
      await attach;
      const identity = { action: 'verify', pid: String(descriptor.pid), session: descriptor.session };
      assert.deepEqual(await dap.request(REQUEST, identity), { verified: true });
      await assert.rejects(dap.request(REQUEST, { ...identity, pid: String(descriptor.pid + 1) }), /PID or coroutine probe session/u);
      await assert.rejects(dap.request(REQUEST, { ...identity, session: randomUUID() }), /PID or coroutine probe session/u);
      const newSnapshot = await fetchCoroutineSnapshot(descriptor);
      assert.notEqual(newSnapshot.debugCapture, snapshot.debugCapture);
      await assert.rejects(dap.request(REQUEST, watchRequest(descriptor, snapshot, picked)), /capture changed/u);
      const selected = watchTarget(newSnapshot);
      const request = watchRequest(descriptor, newSnapshot, selected);
      await assert.rejects(dap.request(REQUEST, { ...request, sequence: selected.sibling.sequence }), /resumed, disappeared or changed/u);
      const start = dap.events.length;
      assert.deepEqual(await dap.request(REQUEST, request), { armed: true, watch: request.watch, expiresInSeconds: 45 });
      running.send('sibling');
      await running.waitFor('Rocketbrain coroutine sibling resumed');
      assert.ok(!dap.events.slice(start).some(event => event.event === EVENT || event.event === 'stopped'));
      running.send('selected');
      const event = await dap.event(EVENT, start, 15000);
      const stop = await dap.event('stopped', start, 15000);
      assert.equal(stop.allThreadsStopped, false);
      assert.equal(event.threadId, stop.threadId);
      assert.equal(event.watch, request.watch);
      assert.equal(event.sequence, selected.selected.sequence);
      assert.equal(event.className, selected.selected.className);
      assert.equal(event.parkedLine, selected.selected.line);
      const [frame] = (await dap.request('stackTrace', { threadId: stop.threadId, startFrame: 0, levels: 1 })).stackFrames;
      assert.equal(frame.line, event.line);
      assert.match(frame.name, /invokeSuspend/u);
      assert.equal(path.relative(path.join(sourceRoot, 'coroutinesfixture/CoroutineWatch.kt'), frame.source.path), '');
      assert.ok(!running.output().includes('Rocketbrain coroutine selected resumed'));
      running.send('status');
      const whileStopped = jdbcResult(await running.waitFor('Rocketbrain coroutine fixture still running'), engine);
      await dap.request('disconnect', { terminateDebuggee: false }, 5000).catch(error => {
        if (!dap.events.some(event => event.event === 'terminated')) throw error;
      });
      await running.waitFor('Rocketbrain coroutine selected resumed');
      assert.equal((await fetchCoroutineSnapshot(descriptor)).pid, running.pid);
      reports.push({ ...whileStopped, parkedLine: event.parkedLine, resumedLine: frame.line, sameClassSiblingDidNotStop: true,
        wrongPidAndSessionRefused: true, staleCaptureRefused: true, siblingSequenceRefused: true,
        stockDapStackFrame: true, appContinuedAfterDetach: true });
    } finally {
      if (dap && !dap.socket.destroyed) {
        await dap.request('disconnect', { terminateDebuggee: false }, 3000).catch(() => {});
        dap.socket.destroy();
      }
      assert.equal(await running.stop(), 0);
      await assert.rejects(fs.stat(prepared.descriptor), { code: 'ENOENT' });
    }
  }
  const receipt = process.env.ROCKETBRAIN_COROUTINE_WATCH_RECEIPT;
  if (receipt) await fs.writeFile(receipt, JSON.stringify({ debugBundle: bundle.build, bundleSha256: bundle.sha256,
    version: 'kotlinx.coroutines 1.11.0', sameNameAndClassVerified: true, reports }) + '\n');
});
