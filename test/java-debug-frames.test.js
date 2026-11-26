'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');
const { createFrameRestart } = require('../src/java/debug-frames');
const { createLocalValueInspection } = require('../src/java/debug-local-values');
const { DEBUG_BUILD, COROUTINE_BUILD, WATCH_BUILD, INDEXED_WATCH_BUILD, KOTLIN_LOCAL_WRITE_BUILD } = require('../src/java/debug-runtime');
const { resolveLaunch, serverSettings } = require('../src/java/runtime');
const { StdioLsp, until } = require('./helpers/stdio-lsp');
const { DapClient } = require('./java-debug-dap');
const { frameFixture, exerciseFrameRestart, exerciseLocalValues } = require('./helpers/java-frame-fixture');

const configPath = process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;

test('frame restart guards adapter support, trust, paused thread and single-use review', async () => {
  const frames = [{ id: 4, name: 'Test.call()', line: 9 }, { id: 5, name: 'Test.main()', line: 12 }];
  const state = { state: 'stopped', threadId: 21, stopVersion: 8, capabilities: { supportsRestartFrame: true } };
  const calls = [];
  const session = { id: 'java', type: 'rocketbrain-java', async customRequest(command, args) {
    calls.push({ command, args });
    if (command === 'stackTrace') return { stackFrames: frames };
  } };
  let trusted = true;
  const vscode = { debug: { activeDebugSession: session }, window: { showQuickPick: async records => records[0] } };
  const service = createFrameRestart(vscode, { getState: () => state, ensureTrusted() { if (!trusted) throw Error('Untrusted'); } });
  const report = await service.inspect();
  assert.deepEqual(report.frames, [{ id: 4, label: 'Test.call()', line: 9 }]);
  await assert.rejects(service.restart(report, 5), /current Java call stack/);
  trusted = false;
  await assert.rejects(service.restart(report, 4), /Untrusted/);
  trusted = true;
  state.capabilities.supportsRestartFrame = false;
  await assert.rejects(service.restart(report, 4), /does not support/);
  state.capabilities.supportsRestartFrame = true;
  vscode.debug.activeStackItem = { session, threadId: 22 };
  await assert.rejects(service.restart(report, 4), /thread that reported/);
  delete vscode.debug.activeStackItem;
  state.resuming = 16;
  await assert.rejects(service.restart(report, 4), /Pause the Java session/);
  delete state.resuming;
  state.stopVersion++;
  await assert.rejects(service.restart(report, 4), /different position/);
  assert.equal((await service.choose()).id, 4);
  assert.deepEqual(calls.filter(call => call.command === 'restartFrame'), [{ command: 'restartFrame', args: { frameId: 4 } }]);
});

test('actual JDT DAP restarts a chosen caller frame in the same JVM and replays its method body', {
  skip: !configPath && 'Provision the independent Java debugger.', timeout: 210000
}, async t => {
  const runtime = JSON.parse(await fs.readFile(configPath, 'utf8'));
  const settings = runtime.settings || runtime;
  const javaHome = runtime.javaHome || settings['rocketbrain.java.javaHome'];
  const serverPath = runtime.serverPath || settings['rocketbrain.java.serverPath'];
  const debugBundlePath = runtime.debugBundlePath || settings['rocketbrain.java.debugBundlePath'];
  const parent = await fs.realpath(os.tmpdir());
  const owned = await fs.mkdtemp(path.join(parent, 'rb-java-frames-'));
  t.after(async () => {
    const real = await fs.realpath(owned);
    assert.equal(real, owned);
    assert.equal(path.dirname(real), parent);
    assert.match(path.basename(real), /^rb-java-frames-/);
    await fs.rm(real, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  });
  const project = path.join(owned, 'project');
  const fixture = frameFixture();
  const source = path.join(project, 'src/main/java', fixture.mainFile);
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.writeFile(source, fixture.source, { flag: 'wx' });
  await fs.copyFile(path.join(__dirname, 'fixtures/java/debugger/pom.xml'), path.join(project, 'pom.xml'));
  const uri = pathToFileURL(project).href;
  const jdtSettings = serverSettings([{ name: 'JavaSE-25', path: javaHome, default: true }]);
  const launch = resolveLaunch({ javaHome, serverPath, debugBundlePath, storagePath: path.join(owned, 'jdt') });
  const lsp = new StdioLsp(launch);
  const command = (name, ...args) => lsp.request('workspace/executeCommand', { command: name, arguments: args });
  let dap, proof;
  try {
    await lsp.request('initialize', { processId: process.pid, rootUri: uri, workspaceFolders: [{ uri, name: 'java-frames' }],
      capabilities: { workspace: { configuration: true } },
      initializationOptions: { bundles: launch.bundles, workspaceFolders: [uri], settings: jdtSettings } }, 75000);
    lsp.notify('initialized', {});
    lsp.notify('workspace/didChangeConfiguration', { settings: jdtSettings });
    const main = await until(async () => (await command('vscode.java.resolveMainClass', uri))
      ?.find(item => item.mainClass === fixture.mainClass), 65000);
    const built = await command('vscode.java.buildWorkspace', JSON.stringify({ mainClass: fixture.mainClass, projectName: main.projectName, isFullBuild: false }));
    assert.ok(built === 'SUCCEED' || built === 1);
    const [modulePaths, classPaths] = await command('vscode.java.resolveClasspath', fixture.mainClass, main.projectName);
    const javaExec = await command('vscode.java.resolveJavaExecutable', fixture.mainClass, main.projectName);
    dap = new DapClient(await command('vscode.java.startDebugSession'));
    const capabilities = await dap.request('initialize', { adapterID: 'rocketbrain-java', clientID: 'frame-restart',
      linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path', supportsVariableType: true });
    assert.equal(capabilities.supportsRestartFrame, true);
    const starting = dap.request('launch', { type: 'rocketbrain-java', name: 'Frame restart fixture', mainClass: fixture.mainClass,
      projectName: main.projectName, modulePaths, classPaths, javaExec, cwd: project, console: 'internalConsole', sourcePaths: [] });
    starting.catch(() => {});
    await dap.event('initialized');
    const { breakpoints } = await dap.request('setBreakpoints', { source: { name: path.basename(source), path: source }, breakpoints: [{ line: fixture.gate }] });
    assert.equal(breakpoints[0].verified, true);
    await dap.request('configurationDone');
    await starting;
    const first = await dap.event('stopped', 0, 18000);
    const state = { state: 'stopped', threadId: first.threadId, stopVersion: 0, capabilities, debugBuild: launch.debugBuild };
    const requests = [];
    const session = { type: 'rocketbrain-java', id: 'frame-fixture', customRequest: (...args) => { requests.push(args[0]); return dap.request(...args); } };
    const vscode = { debug: { activeDebugSession: session } };
    const context = { getState: () => state, ensureTrusted() {} };
    const service = createFrameRestart(vscode, context);
    const values = createLocalValueInspection(vscode, context);
    const inspected = [DEBUG_BUILD, COROUTINE_BUILD, WATCH_BUILD, INDEXED_WATCH_BUILD, KOTLIN_LOCAL_WRITE_BUILD].includes(launch.debugBuild) ?
      await exerciseLocalValues(values, fixture, session) : undefined;
    if (inspected) {
      assert.deepEqual([...new Set(requests)], ['stackTrace', 'rocketbrain/readJavaValues']);
      const { stackFrames } = await session.customRequest('stackTrace', { threadId: first.threadId, startFrame: 0, levels: 1 });
      await assert.rejects(session.customRequest('rocketbrain/readJavaValues', { action: 'string', frameId: stackFrames[0].id, name: 'beyondLimit' }), /256 Ki/);
      await assert.rejects(session.customRequest('rocketbrain/readJavaValues', { action: 'page', frameId: stackFrames[0].id,
        name: 'samples', start: 0, count: 101 }), /up to 100/);
    } else await assert.rejects(values.inspect(), /Update the Rocketbrain Java engine/);
    const frame = async stop => (await dap.request('stackTrace', { threadId: stop.threadId, startFrame: 0, levels: 1 })).stackFrames[0];
    const proceed = async resume => {
      const index = dap.events.length;
      await resume();
      const stopped = await dap.event('stopped', index, 18000);
      state.stopVersion++;
      state.threadId = stopped.threadId;
      return stopped;
    };
    const outcome = await exerciseFrameRestart({ fixture, service, session, first, proceed, frame });
    if (inspected) await assert.rejects(values.read(inspected.review, 'message'), /different position/);
    const index = dap.events.length;
    await session.customRequest('continue', { threadId: outcome.stopped.threadId });
    await dap.event('terminated', index, 18000);
    const output = dap.events.filter(message => message.event === 'output').map(message => message.body.output).join('');
    assert.match(output, /FRAME_ATTEMPT:1\s+FRAME_ATTEMPT:2\s+FRAME_RESULT:42:2/);
    proof = { debugBuild: launch.debugBuild, ...outcome.proof, sideEffectsBeforeRestartPreserved: true, finalResult: 42 };
    if (inspected) {
      assert.match(output, /FRAME_INSPECTION_CALLS:0/);
      proof.localValues = { ...inspected.proof, noTargetMethodCalls: true, staleValueRefused: true };
    }
  } finally {
    await dap?.close();
    await lsp.close();
  }
  if (process.env.ROCKETBRAIN_FRAMES_RECEIPT) {
    await fs.writeFile(process.env.ROCKETBRAIN_FRAMES_RECEIPT, JSON.stringify(proof, null, 2) + '\n');
  }
});
