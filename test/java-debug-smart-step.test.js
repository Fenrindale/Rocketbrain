'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');
const { createSmartStep, mergeStepFilters, stepTargets } = require('../src/java/debug-step');
const { resolveLaunch, serverSettings } = require('../src/java/runtime');
const { StdioLsp, until } = require('./helpers/stdio-lsp');
const { DapClient } = require('./java-debug-dap');
const { smartStepFixture, exerciseSmartStep } = require('./helpers/java-smart-step-fixture');
const { auditProfile } = require('../src/keyboard-profile');

const configPath = process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;

test('Java step filter defaults merge with exact per-session overrides and legacy exclusions', () => {
  assert.deepEqual(mergeStepFilters({ skipClasses: ['lib.*'], skipSynthetics: true, allowClasses: ['*.Main'] },
    { skipClasses: [], skipSynthetics: false, classNameFilters: ['*.Generated', '*.Generated'] }),
  { skipClasses: ['*.Generated'], skipSynthetics: false, allowClasses: ['*.Main'] });
  assert.throws(() => mergeStepFilters({ skipClasses: ['lib.*.internal'] }), /leading\/trailing wildcards/);
  assert.throws(() => mergeStepFilters({ skipConstructors: 'true' }), /true or false/);
  assert.deepEqual(stepTargets({ targets: [{ id: 1, label: 'call(\n)', line: 20, column: 14 }, { id: 0, label: 'invalid' }] }),
    [{ id: 1, label: 'call( )', line: 20, column: 14 }]);
});

test('Java step target reviews reject fabricated ids, changed stops, and wrong focused frames', async () => {
  const calls = [];
  const state = { state: 'stopped', stopVersion: 1, threadId: 9, capabilities: { supportsStepInTargetsRequest: true } };
  const session = { type: 'rocketbrain-java', id: 'mine', async customRequest(method, args) {
    calls.push([method, args]);
    if (method === 'stackTrace') return { stackFrames: [{ id: 15, name: 'main', line: 20 }] };
    if (method === 'stepInTargets') return { targets: [{ id: 21, label: 'call()', line: 20, column: 12 }] };
  } };
  const vscode = { debug: { activeDebugSession: session }, window: { async showQuickPick(choices) { return choices[0]; } } };
  const service = createSmartStep(vscode, { getState: () => state, ensureTrusted() {} });
  const report = await service.inspect();
  await assert.rejects(service.step(report, 99), /current Java step list/);
  state.stopVersion++;
  await assert.rejects(service.step(report, 21), /different position/);
  vscode.debug.activeStackItem = { session, threadId: 9, frameId: 16 };
  await assert.rejects(service.inspect(), /top frame/);
  vscode.debug.activeStackItem = { session, threadId: 9, frameId: 15 };
  state.resuming = 6;
  await assert.rejects(service.inspect(), /Pause the Java session/);
  delete state.resuming;
  assert.equal((await service.choose()).id, 21);
  assert.deepEqual(calls.filter(([name]) => name === 'stepIn'), [['stepIn', { threadId: 9, targetId: 21 }]]);
});

test('real JDT step targets select the second overloaded call and JDI skips both package and exact class', {
  skip: !configPath && 'Provision the independent Java debugger.', timeout: 230000
}, async context => {
  const runtime = JSON.parse(await fs.readFile(configPath, 'utf8'));
  const config = runtime.settings || runtime;
  const javaHome = runtime.javaHome || config['rocketbrain.java.javaHome'];
  const serverPath = runtime.serverPath || config['rocketbrain.java.serverPath'];
  const debugBundlePath = runtime.debugBundlePath || config['rocketbrain.java.debugBundlePath'];
  const parent = await fs.realpath(os.tmpdir());
  const owned = await fs.mkdtemp(path.join(parent, 'rb-java-smart-step-'));
  context.after(async () => {
    const real = await fs.realpath(owned);
    assert.equal(real, owned);
    assert.equal(path.dirname(real), parent);
    assert.match(path.basename(real), /^rb-java-smart-step-/);
    await fs.rm(real, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  });
  const project = path.join(owned, 'project');
  const fixture = smartStepFixture('dev.rocketbrain.smartstep');
  const source = path.join(project, 'src/main/java', fixture.mainFile);
  for (const [file, text] of fixture.paths) {
    const physical = path.join(project, 'src/main/java', file);
    await fs.mkdir(path.dirname(physical), { recursive: true });
    await fs.writeFile(physical, text, { flag: 'wx' });
  }
  await fs.copyFile(path.join(__dirname, 'fixtures/java/debugger/pom.xml'), path.join(project, 'pom.xml'));
  const uri = pathToFileURL(project).href;
  const settings = serverSettings([{ name: 'JavaSE-25', path: javaHome, default: true }]);
  const launch = resolveLaunch({ javaHome, serverPath, debugBundlePath, storagePath: path.join(owned, 'jdt') });
  const lsp = new StdioLsp(launch);
  const command = (name, ...args) => lsp.request('workspace/executeCommand', { command: name, arguments: args });
  let dap, proof;
  try {
    await lsp.request('initialize', {
      processId: process.pid, rootUri: uri, workspaceFolders: [{ uri, name: 'smart-step' }],
      capabilities: { workspace: { configuration: true } },
      initializationOptions: { bundles: launch.bundles, workspaceFolders: [uri], settings }
    }, 75000);
    lsp.notify('initialized', {});
    lsp.notify('workspace/didChangeConfiguration', { settings });
    const main = await until(async () => (await command('vscode.java.resolveMainClass', uri))
      ?.find(item => item.mainClass === fixture.mainClass), 65000);
    const built = await command('vscode.java.buildWorkspace', JSON.stringify({ mainClass: fixture.mainClass, projectName: main.projectName, isFullBuild: false }));
    assert.ok(built === 'SUCCEED' || built === 1);
    const [modulePaths, classPaths] = await command('vscode.java.resolveClasspath', fixture.mainClass, main.projectName);
    const javaExec = await command('vscode.java.resolveJavaExecutable', fixture.mainClass, main.projectName);
    dap = new DapClient(await command('vscode.java.startDebugSession'));
    const capabilities = await dap.request('initialize', {
      adapterID: 'rocketbrain-java', clientID: 'smart-step', linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path'
    });
    assert.equal(capabilities.supportsStepInTargetsRequest, true);
    const started = dap.request('launch', {
      type: 'rocketbrain-java', name: 'Smart Step fixture', mainClass: fixture.mainClass, projectName: main.projectName,
      modulePaths, classPaths, javaExec, cwd: project, console: 'internalConsole', sourcePaths: [],
      stepFilters: mergeStepFilters(fixture.filters, { skipSynthetics: true })
    });
    started.catch(() => {});
    await dap.event('initialized');
    const { breakpoints } = await dap.request('setBreakpoints', { source: { name: path.basename(source), path: source },
      breakpoints: fixture.gates.map(gate => ({ line: fixture.line(gate) })) });
    assert.ok(breakpoints.every(item => item.verified));
    await dap.request('configurationDone');
    await started;
    const first = await dap.event('stopped', 0, 18000);
    const state = { state: 'stopped', stopVersion: 0, threadId: first.threadId, capabilities };
    const session = { type: 'rocketbrain-java', id: 'fixture', customRequest: (...args) => dap.request(...args) };
    const service = createSmartStep({ debug: { activeDebugSession: session },
      window: { async showQuickPick(items) { return items.find(item => item.label === 'choose("abc")'); } }
    }, { getState: () => state, ensureTrusted() {} });
    const commands = new Map([['rocketbrain.java.smartStepInto', () => service.choose()]]);
    const keyboard = auditProfile('win32', { commands: commands.keys() }).routes.find(rule => rule.command === 'rocketbrain.java.smartStepInto');
    assert.ok(keyboard.available);
    const frame = async stop => (await dap.request('stackTrace', { threadId: stop.threadId, startFrame: 0, levels: 1 })).stackFrames[0];
    const proceed = async resume => {
      const after = dap.events.length;
      await resume();
      const stopped = await dap.event('stopped', after, 18000);
      state.stopVersion++;
      state.threadId = stopped.threadId;
      return stopped;
    };
    const outcome = await exerciseSmartStep({ fixture, service, first, session, frame, proceed,
      choose: () => commands.get(keyboard.command)() });
    const index = dap.events.length;
    await session.customRequest('continue', { threadId: outcome.stopped.threadId });
    await dap.event('terminated', index, 18000);
    proof = { debugBuild: launch.debugBuild, ...outcome.proof, finished: true, keyboardRouteInvokedRealJdiSmartStep: true };
  } finally {
    await dap?.close();
    await lsp.close();
  }
  if (process.env.ROCKETBRAIN_SMART_STEP_RECEIPT) {
    await fs.writeFile(process.env.ROCKETBRAIN_SMART_STEP_RECEIPT, JSON.stringify(proof, null, 2) + '\n');
  }
});
