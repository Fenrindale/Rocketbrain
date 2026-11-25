'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');
const { createAsyncInspection, parseAsyncTrace, openAsyncTrace } = require('../src/java/async-trace');
const { argumentString } = require('../src/java/debug-runtime');
const { resolveLaunch, serverSettings } = require('../src/java/runtime');
const { StdioLsp, until } = require('./helpers/stdio-lsp');
const { DapClient } = require('./java-debug-dap');
const { asyncTraceFixture, assertAsyncChain } = require('./helpers/java-async-trace-fixture');

const configPath = process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;
const traceSource = path.join(__dirname, '../runtime/java-async/src/rocketbrain/async/TaskTrace.java');
const encode = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const root = { kind: 'trace', version: 1, traceId: '11111111-2222-3333-4444-555555555555', pid: 199 };
const sourceFrame = { type: 'app.Order', method: 'work', file: 'Order.java', line: 5 };
const submission = { kind: 'submitted', id: 1, parent: 0, label: 'load', thread: { id: 1, name: 'main' }, frames: [sourceFrame] };
const active = { kind: 'entered', id: 1, thread: { id: 2, name: 'worker' } };

test('async traces validate ordering, lifecycle, and preserve a live partial tail', () => {
  const trace = parseAsyncTrace(encode([root, submission, active]) + '{"part');
  assert.equal(trace.tasks.get(1).state, 'entered');
  assert.equal(trace.tasks.get(1).worker.name, 'worker');
  assert.equal(parseAsyncTrace(encode([root, submission, { kind: 'truncated' }])).truncated, true);
  assert.throws(() => parseAsyncTrace(encode([root, { ...submission, parent: 1 }])), /invalid record/);
  assert.throws(() => parseAsyncTrace(encode([root, submission, { kind: 'completed', id: 1 }])), /invalid record/);
  assert.throws(() => parseAsyncTrace(encode([{ ...root, version: 99 }])), /version 1/);
});

test('paused Java async inspection checks runtime identity and rejects stale debugger selections', async () => {
  const state = { state: 'stopped', threadId: 7, stopVersion: 1 };
  let traceId = root.traceId;
  let resume = false;
  const session = { id: 'mysession', type: 'rocketbrain-java', async customRequest(command) {
    if (command === 'stackTrace') return { stackFrames: [{ id: 25, name: 'TaskTrace.runRecorded(Task, Runnable)' }] };
    if (command === 'scopes') return { scopes: [{ name: 'Local', variablesReference: 11 }] };
    if (command === 'variables') {
      if (resume) state.stopVersion++;
      return { variables: [{ name: 'rocketbrainTraceId', value: '"' + traceId + '"' }, { name: 'rocketbrainTaskId', value: '1' }] };
    }
    assert.fail(command);
  } };
  const inspector = createAsyncInspection({ activeSession: () => session, getState: () => state, ensureTrusted() {},
    readTrace: async () => parseAsyncTrace(encode([root, submission, active])) });
  assert.equal((await inspector.inspect('unused')).chain[0].label, 'load');
  traceId = randomUUID();
  await assert.rejects(inspector.inspect('unused'), /different Java runtime/);
  resume = true;
  await assert.rejects(inspector.inspect('unused'), /stopped elsewhere/);
});

test('actual Java Executor and CompletableFuture tasks expose submission chains from a paused JVM', {
  skip: !configPath && 'Configure the independent JDT debugger runtime.', timeout: 240000
}, async context => {
  const runtime = JSON.parse(await fs.readFile(configPath, 'utf8'));
  const config = runtime.settings || runtime;
  const javaHome = runtime.javaHome || config['rocketbrain.java.javaHome'];
  const serverPath = runtime.serverPath || config['rocketbrain.java.serverPath'];
  const debugBundlePath = runtime.debugBundlePath || config['rocketbrain.java.debugBundlePath'];
  const parent = await fs.realpath(os.tmpdir());
  const owned = await fs.mkdtemp(path.join(parent, 'rb-java-async-trace-'));
  context.after(async () => {
    const real = await fs.realpath(owned);
    assert.equal(real, owned);
    assert.equal(path.dirname(real), parent);
    assert.match(path.basename(real), /^rb-java-async-trace-/);
    await fs.rm(real, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  });
  const project = path.join(owned, 'project');
  const source = path.join(project, 'src/main/java/dev/rocketbrain/asyncfixture/AsyncTraceFixture.java');
  const helper = path.join(project, 'src/main/java/rocketbrain/async/TaskTrace.java');
  for (const file of [source, helper]) await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.copyFile(traceSource, helper);
  await fs.copyFile(path.join(__dirname, 'fixtures/java/debugger/pom.xml'), path.join(project, 'pom.xml'));
  const fixture = asyncTraceFixture('dev.rocketbrain.asyncfixture', 'AsyncTraceFixture');
  await fs.writeFile(source, fixture.source, { flag: 'wx' });
  const uri = pathToFileURL(project).href;
  const trace = path.join(owned, 'events.jsonl');
  const settings = serverSettings([{ name: 'JavaSE-25', path: javaHome, default: true }]);
  const launch = resolveLaunch({ javaHome, serverPath, debugBundlePath, storagePath: path.join(owned, 'jdt') });
  const lsp = new StdioLsp(launch);
  const command = (name, ...args) => lsp.request('workspace/executeCommand', { command: name, arguments: args });
  let dap, proof;
  try {
    await lsp.request('initialize', {
      processId: process.pid, rootUri: uri, workspaceFolders: [{ uri, name: 'async-trace' }],
      capabilities: { workspace: { configuration: true } }, initializationOptions: { bundles: launch.bundles, workspaceFolders: [uri], settings }
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
    await dap.request('initialize', { adapterID: 'rocketbrain-java', clientID: 'async-trace', linesStartAt1: true,
      columnsStartAt1: true, pathFormat: 'path', supportsVariableType: true, supportsVariablePaging: true });
    const started = dap.request('launch', { type: 'rocketbrain-java', name: 'Async task tracer',
      mainClass: fixture.mainClass, projectName: main.projectName, classPaths, modulePaths, javaExec, cwd: project,
      args: argumentString([trace]), console: 'internalConsole', sourcePaths: [] });
    started.catch(() => {});
    await dap.event('initialized');
    const { breakpoints } = await dap.request('setBreakpoints', { source: { name: path.basename(source), path: source },
      breakpoints: ['UNTRACKED_STOP', 'ASYNC_STOP'].map(marker => ({ line: fixture.line(marker) })) });
    assert.ok(breakpoints.every(item => item.verified));
    await dap.request('configurationDone');
    await started;
    let stop = await dap.event('stopped', 0, 18000);
    const state = { state: 'stopped', threadId: stop.threadId, stopVersion: 1 };
    const session = { id: 'async', type: 'rocketbrain-java', customRequest: (...args) => dap.request(...args) };
    const inspector = createAsyncInspection({ activeSession: () => session, getState: () => state, ensureTrusted() {} });
    await assert.rejects(inspector.inspect(trace), /No recorded Java task/);
    const afterUntracked = dap.events.length;
    await session.customRequest('continue', { threadId: stop.threadId });
    stop = await dap.event('stopped', afterUntracked, 18000);
    state.threadId = stop.threadId;
    state.stopVersion++;
    const { stackFrames } = await session.customRequest('stackTrace', { threadId: stop.threadId, startFrame: 0, levels: 1 });
    assert.equal(stackFrames[0].line, fixture.line('ASYNC_STOP'));
    const report = await inspector.inspect(trace);
    proof = assertAsyncChain(report, fixture);
    const wrong = path.join(owned, 'other.jsonl');
    await fs.writeFile(wrong, encode([{ ...root, traceId: randomUUID() }]), { flag: 'wx' });
    await assert.rejects(inspector.inspect(wrong), /different Java runtime/);
    const after = dap.events.length;
    await session.customRequest('continue', { threadId: stop.threadId });
    await dap.event('terminated', after, 18000);
    const finalTrace = await openAsyncTrace(trace);
    assert.ok([...finalTrace.tasks.values()].every(item => item.state === 'completed'));
    assert.ok(dap.events.some(item => item.event === 'output' && item.body.output.includes('ASYNC_RESULT:42')));
  } finally {
    await dap?.close();
    await lsp.close();
  }
  if (process.env.ROCKETBRAIN_JAVA_ASYNC_RECEIPT) await fs.writeFile(process.env.ROCKETBRAIN_JAVA_ASYNC_RECEIPT,
    JSON.stringify({ ...proof, noUnrecordedTask: true, wrongTraceRejected: true, preservedResult: 42 }, null, 2) + '\n');
});
