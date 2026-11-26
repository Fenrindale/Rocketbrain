'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');
const { WATCH_BUILD, INDEXED_WATCH_BUILD, KOTLIN_LOCAL_WRITE_BUILD, KOTLIN_FIELD_BUILD, KOTLIN_LINE_BUILDS,
  KOTLIN_FIELD_VALUES_BUILDS, KOTLIN_BOX_BUILDS, KOTLIN_MAP_BUILDS, resolveDebugBundle } = require('../src/java/debug-runtime');
const { assignment, assertKotlinLocalChanges } = require('./helpers/kotlin-local-write');
const { resolveLaunch, serverSettings } = require('../src/java/runtime');
const { DapClient, freePort } = require('./java-debug-dap');
const { waitForOwnedListener } = require('../src/java/testing-debug');
const { StdioLsp, until } = require('./helpers/stdio-lsp');
const { buildCoroutineFixture } = require('./helpers/coroutine-fixture');
const { request, breakpointName, launchKotlinWatches, assertKotlinWatchValues, assertIndexedKotlinWatchValues, kotlinWatchJdbcResult } =
  require('./helpers/kotlin-watch-expressions');

const { fieldRequest, assertKotlinFields, assertFieldsResumed } = require('./helpers/kotlin-object-fields');
const { assertKotlinFieldValues, assertKotlinFieldValuesResumed, assertFreshKotlinBoxes, assertFreshBoxesResumed } = require('./helpers/kotlin-field-values');
const { localValuesRequest, assertKotlinCollections, assertKotlinCollectionsResumed } = require('./helpers/kotlin-collection-values');

const runtimeFile = process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;
const gradleHome = process.env.ROCKETBRAIN_COROUTINE_GRADLE_HOME;
const classpathFile = process.env.ROCKETBRAIN_COROUTINE_WATCH_CLASSPATH;
const dbFiles = ['mysql', 'mariadb'].map(engine => [engine, process.env['ROCKETBRAIN_COROUTINE_WATCH_' + engine.toUpperCase() + '_CONFIG']]);

async function assertManualAttachLimited(lsp, fixture, sourceRoot, database, boxes, maps) {
  const target = await freePort(), running = await launchKotlinWatches(fixture, database, target);
  let dap;
  try {
    await running.ready();
    const port = await lsp.request('workspace/executeCommand', { command: 'vscode.java.startDebugSession', arguments: [] }, 10000);
    dap = new DapClient(port);
    const send = (method,args) => dap.request(method,args,12000);
    await send('initialize', { adapterID:'rocketbrain-java', clientID:'unverified-attach-proof',
      linesStartAt1:true, columnsStartAt1:true, pathFormat:'path' });
    const attaching = send('attach', { hostName:'127.0.0.1', port:target, sourcePaths:[sourceRoot] });
    void attaching.catch(()=>{});
    await dap.event('initialized');
    await send('setFunctionBreakpoints',{breakpoints:[{name:breakpointName}]});
    await send('configurationDone');
    await attaching;
    running.send('inspect');
    const stopped=await dap.event('stopped',0,20000);
    const [frame]=(await send('stackTrace',{threadId:stopped.threadId,startFrame:0,levels:1})).stackFrames;
    const result=await send(fieldRequest,{action:'fields',frameId:frame.id,receiver:'target'});
    assert.ok(result.fields.some(row=>row.name==='count'));
    assert.ok(!result.fields.some(row=>row.kind==='text'||row.kind==='array'));
    await assert.rejects(send(fieldRequest,{action:'page',frameId:frame.id,receiver:'target',name:'history',start:0,count:2}), /verified local JVM/u);
    if (boxes) {
      assert.ok(!result.fields.some(row=>row.boxLiteral));
      await assert.rejects(send(fieldRequest,{action:'prepareLiteral',frameId:frame.id,receiver:'target',name:'freshInt',input:'77'}),
        /verified local JVM/u);
    }
    if (maps) {
      const observed = await send(localValuesRequest, {action:'list',frameId:frame.id});
      assert.ok(!observed.values.some(row => row.kind === 'orderedMap'));
      await assert.rejects(send(localValuesRequest, {action:'mapOpen',frameId:frame.id,name:'orderedMap',start:0,count:32}),
        /verified local Kotlin frame/u);
    }
    await send('continue',{threadId:stopped.threadId});
    await running.waitFor('Rocketbrain Kotlin JDBC|');
    await send('disconnect',{terminateDebuggee:false});
  } finally {
    if (dap) dap.socket.destroy();
    await running.stop();
  }
  return true;
}

test('native DAP Kotlin watch evaluates live locals from actual Spring JDBC frames', {
  skip: !runtimeFile || !gradleHome || !classpathFile || !dbFiles.every(([, file]) => file), timeout: 380000
}, async t => {
  const runtime = JSON.parse(await fs.readFile(runtimeFile, 'utf8'));
  const { javaHome, serverPath } = runtime;
  const bundle = resolveDebugBundle(runtime.settings['rocketbrain.java.debugBundlePath'], serverPath);
  assert.ok([WATCH_BUILD,INDEXED_WATCH_BUILD,KOTLIN_LOCAL_WRITE_BUILD,KOTLIN_FIELD_BUILD,...KOTLIN_LINE_BUILDS].includes(bundle?.build));
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
    const fieldSignal = [KOTLIN_FIELD_BUILD,...KOTLIN_LINE_BUILDS].includes(bundle.build) ? path.join(directory, engine + '.signal') : undefined;
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
      const extended=KOTLIN_FIELD_VALUES_BUILDS.includes(bundle.build);
      if (extended) {
        const ownership=await waitForOwnedListener({pid:running.pid,port:jdwp});
        assert.deepEqual([ownership.verified,ownership.pid,ownership.port],[true,running.pid,jdwp]);
      }
      const attaching = send('attach', { hostName: '127.0.0.1', port: jdwp, sourcePaths: [sourceRoot],
        ...(extended&&{rocketbrainLocalKotlinFieldValues:true}) });
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
      assert.ok(frame.source?.path, engine+' did not map the paused Kotlin source frame '+JSON.stringify(frame));
      assert.equal(path.relative(source, frame.source.path), '');
      const values = await assertKotlinWatchValues(send, frame.id);
      const indexed = bundle.build !== WATCH_BUILD ? await assertIndexedKotlinWatchValues(send, frame.id) : undefined;
      const write = [KOTLIN_LOCAL_WRITE_BUILD,KOTLIN_FIELD_BUILD,...KOTLIN_LINE_BUILDS].includes(bundle.build) ? await assertKotlinLocalChanges(send,frame.id) : undefined;
      const fields = fieldSignal ? await assertKotlinFields(send,frame.id,async () => {
        await fs.writeFile(fieldSignal,'change',{flag:'wx'});
        await running.waitFor('Rocketbrain Kotlin field changed by fixture');
      }) : undefined;
      const fieldValues=extended ? await assertKotlinFieldValues(send,frame.id,async (suffix,message)=>{
        await fs.writeFile(fieldSignal+'.'+suffix,'change',{flag:'wx'});
        await running.waitFor(message);
      }) : undefined;
      const freshBoxes=KOTLIN_BOX_BUILDS.includes(bundle.build) ? await assertFreshKotlinBoxes(send,frame.id,async (suffix,message)=>{
        await fs.writeFile(fieldSignal+'.'+suffix,'change',{flag:'wx'});
        await running.waitFor(message);
      }) : undefined;
      const orderedMaps=KOTLIN_MAP_BUILDS.includes(bundle.build) ? await assertKotlinCollections(send,frame.id,async (suffix,message)=>{
        await fs.writeFile(fieldSignal+'.'+suffix,'change',{flag:'wx'});
        await running.waitFor(message);
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
      if (fieldValues) {
        fieldValues.resumed=assertKotlinFieldValuesResumed(output);
        await assert.rejects(send(fieldRequest,{action:'apply',frameId:frame.id,reviewId:fieldValues.staleId}),/same Kotlin frame suspended/u);
        delete fieldValues.staleId;
        fieldValues.resumedWriteRefused=true;
      }
      if (freshBoxes) {
        freshBoxes.resumed = assertFreshBoxesResumed(output);
        await assert.rejects(send(fieldRequest,{action:'apply',frameId:frame.id,reviewId:freshBoxes.staleId}),/same Kotlin frame suspended/u);
        delete freshBoxes.staleId;
        freshBoxes.resumedWriteRefused = true;
      }
      if (orderedMaps) {
        orderedMaps.resumed = assertKotlinCollectionsResumed(output, true);
        await assert.rejects(send(localValuesRequest, {action:'mapPage',frameId:frame.id,name:'orderedMap',start:0,count:32,
          snapshotId:orderedMaps.snapshotId,viewId:orderedMaps.viewId}), /frame|resumed/u);
        delete orderedMaps.snapshotId;
        delete orderedMaps.viewId;
        orderedMaps.resumedSnapshotRefused = true;
      }
      await assert.rejects(send('evaluate', { frameId: frame.id, expression: 'amount', context: 'watch' }), /current suspended frame/u);
      await assert.rejects(send(request, { frameId: frame.id, expression: 'amount' }), /current suspended frame/u);
      if(write){
        await assert.rejects(send(assignment,{action:'apply',frameId:frame.id,reviewId:write.staleId}),/same Kotlin frame suspended/u);
        delete write.staleId;
        write.resumedWriteRefused=true;
      }
      previousSessionFrame = frame.id;
      reports.push({ ...completion, line: frame.line, values, indexed, write, fields, fieldValues, freshBoxes, orderedMaps, staleFrameRefused: true,
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
  if (KOTLIN_FIELD_VALUES_BUILDS.includes(bundle.build)) reports[0].manualPortOnlyExtendedRefused=await assertManualAttachLimited(lsp,fixture,
    sourceRoot,{engine:dbFiles[0][0],configFile:dbFiles[0][1],classpathFile},KOTLIN_BOX_BUILDS.includes(bundle.build),
    KOTLIN_MAP_BUILDS.includes(bundle.build));
  const receipt = process.env.ROCKETBRAIN_KOTLIN_EXPRESSION_RECEIPT;
  if (receipt) await fs.writeFile(receipt, JSON.stringify({ build: bundle.build, sha256: bundle.sha256,
    kotlin: '2.4.21', reports }, null, 2) + '\n');
});
