'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');
const { WATCH_BUILD, INDEXED_WATCH_BUILD, KOTLIN_LOCAL_WRITE_BUILD, KOTLIN_FIELD_BUILD, resolveDebugBundle } = require('../src/java/debug-runtime');
const { assignment, assertKotlinLocalChanges } = require('./helpers/kotlin-local-write');
const { resolveLaunch, serverSettings } = require('../src/java/runtime');
const { DapClient, freePort } = require('./java-debug-dap');
const { StdioLsp, until } = require('./helpers/stdio-lsp');
const { buildCoroutineFixture } = require('./helpers/coroutine-fixture');
const { request, breakpointName, launchKotlinWatches, assertKotlinWatchValues, assertIndexedKotlinWatchValues, kotlinWatchJdbcResult } =
  require('./helpers/kotlin-watch-expressions');

const { fieldRequest, assertKotlinFields, assertFieldsResumed } = require('./helpers/kotlin-object-fields');

const runtimeFile = process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;
const gradleHome = process.env.ROCKETBRAIN_COROUTINE_GRADLE_HOME;
const classpathFile = process.env.ROCKETBRAIN_COROUTINE_WATCH_CLASSPATH;
const dbFiles = ['mysql', 'mariadb'].map(engine => [engine, process.env['ROCKETBRAIN_COROUTINE_WATCH_' + engine.toUpperCase() + '_CONFIG']]);

test('native DAP Kotlin watch evaluates live locals from actual Spring JDBC frames', {
  skip: !runtimeFile || !gradleHome || !classpathFile || !dbFiles.every(([, file]) => file), timeout: 320000
}, async t => {
  const runtime = JSON.parse(await fs.readFile(runtimeFile, 'utf8'));
  const { javaHome, serverPath } = runtime;
  const bundle = resolveDebugBundle(runtime.settings['rocketbrain.java.debugBundlePath'], serverPath);
  assert.ok([WATCH_BUILD,INDEXED_WATCH_BUILD,KOTLIN_LOCAL_WRITE_BUILD,KOTLIN_FIELD_BUILD].includes(bundle?.build));
  const parent = await fs.realpath(os.tmpdir()), directory = await fs.mkdtemp(path.join(parent, 'rb-kotlin-watch-'));
  let lsp;
  t.after(async () => {
    if (lsp) await lsp.close();
    assert.equal(await fs.realpath(directory), directory);
    assert.equal(path.dirname(directory), parent);
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  });
  const fixture = await buildCoroutineFixture(path.join(directory, 'fixture'), {
    javaHome, gradleHome, gradleUserHome: process.env.ROCKETBRAIN_COROUTINE_GRADLE_USER_HOME || path.join(directory, 'gradle-cache')
  });
  const workspace = path.join(directory, 'workspace');
  await fs.cp(path.resolve('test/fixtures/java/maven'), workspace, { recursive: true });
  const rootUri = pathToFileURL(workspace).href;
  lsp = new StdioLsp(resolveLaunch({ javaHome, serverPath, storagePath: path.join(directory, 'lsp'), debugBundlePath: bundle.path }));
  await lsp.request('initialize', { processId: process.pid, rootUri, workspaceFolders: [{ uri: rootUri, name: 'Kotlin watches' }],
    capabilities: { workspace: { configuration: true } }, initializationOptions: {
      bundles: [bundle.path], workspaceFolders: [rootUri], settings: serverSettings([{ name: 'JavaSE-25', path: javaHome, default: true }])
    } }, 90000);
  lsp.notify('initialized', {});
  const reports = [];
  const sourceRoot = path.join(fixture.root, 'src/main/kotlin');
  const source = path.join(sourceRoot, 'coroutinesfixture/KotlinWatchInspection.kt');
  let previousSessionFrame;
  for (const [engine, configFile] of dbFiles) {
    const jdwp = await freePort();
    const fieldSignal = bundle.build === KOTLIN_FIELD_BUILD ? path.join(directory, engine + '.signal') : undefined;
    const running = await launchKotlinWatches(fixture, { engine, configFile, classpathFile, fieldSignal }, jdwp);
    let dap, failure;
    try {
      await running.ready();
      const port = await until(() => lsp.request('workspace/executeCommand', { command: 'vscode.java.startDebugSession', arguments: [] }, 10000), 65000);
      dap = new DapClient(port);
      const send = (method, options) => dap.request(method, options, 12000);
      const initialized = await send('initialize', { adapterID: 'rocketbrain-java', clientID: 'rocketbrain-watch-proof',
        linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path', supportsVariableType: true });
      assert.equal(initialized.supportsFunctionBreakpoints, true);
      const attaching = send('attach', { hostName: '127.0.0.1', port: jdwp, sourcePaths: [sourceRoot] });
      void attaching.catch(() => {});
      await dap.event('initialized');
      await send('setFunctionBreakpoints', { breakpoints: [{ name: breakpointName }] });
      await send('configurationDone');
      await attaching;
      running.send('inspect');
      const stopped = await dap.event('stopped', 0, 20000);
      assert.equal(stopped.reason, 'function breakpoint');
      if (previousSessionFrame) {
        await assert.rejects(send(request, { frameId: previousSessionFrame, expression: 'amount' }), /current suspended frame/u);
      }
      const [frame] = (await send('stackTrace', { threadId: stopped.threadId, startFrame: 0, levels: 1 })).stackFrames;
      assert.match(frame.name, /paused/u);
      assert.equal(path.relative(source, frame.source.path), '');
      const values = await assertKotlinWatchValues(send, frame.id);
      const indexed = bundle.build !== WATCH_BUILD ? await assertIndexedKotlinWatchValues(send, frame.id) : undefined;
      const write = [KOTLIN_LOCAL_WRITE_BUILD,KOTLIN_FIELD_BUILD].includes(bundle.build) ? await assertKotlinLocalChanges(send,frame.id) : undefined;
      const fields = fieldSignal ? await assertKotlinFields(send,frame.id,async () => {
        await fs.writeFile(fieldSignal,'change',{flag:'wx'});
        await running.waitFor('Rocketbrain Kotlin field changed by fixture');
      }) : undefined;
      const resumed = await send('continue', { threadId: stopped.threadId });
      assert.ok(resumed);
      const output = await running.waitFor('Rocketbrain Kotlin JDBC|');
      const completion = kotlinWatchJdbcResult(output, engine);
      if (fields) {
        fields.resumed = assertFieldsResumed(output);
        await assert.rejects(send(fieldRequest,{action:'apply',frameId:frame.id,reviewId:fields.staleId}),/same Kotlin frame suspended/u);
        delete fields.staleId;
        fields.resumedWriteRefused = true;
      }
      await assert.rejects(send('evaluate', { frameId: frame.id, expression: 'amount', context: 'watch' }), /current suspended frame/u);
      await assert.rejects(send(request, { frameId: frame.id, expression: 'amount' }), /current suspended frame/u);
      if(write){
        await assert.rejects(send(assignment,{action:'apply',frameId:frame.id,reviewId:write.staleId}),/same Kotlin frame suspended/u);
        delete write.staleId;
        write.resumedWriteRefused=true;
      }
      previousSessionFrame = frame.id;
      reports.push({ ...completion, line: frame.line, values, indexed, write, fields, staleFrameRefused: true,
        otherDebugSessionFrameRefused: reports.length > 0, liveFrameSource: 'KotlinWatchInspection.kt' });
      await send('disconnect', { terminateDebuggee: false }).catch(error => {
        if (!dap.events.some(event => event.event === 'terminated')) throw error;
      });
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      if (dap && !dap.socket.destroyed) {
        await dap.request('disconnect', { terminateDebuggee: false }, 3000).catch(() => {});
        dap.socket.destroy();
      }
      const exit = await running.stop();
      if (!failure) assert.equal(exit, 0, running.output());
    }
  }
  const receipt = process.env.ROCKETBRAIN_KOTLIN_EXPRESSION_RECEIPT;
  if (receipt) await fs.writeFile(receipt, JSON.stringify({ build: bundle.build, sha256: bundle.sha256,
    kotlin: '2.4.21', reports }, null, 2) + '\n');
});
