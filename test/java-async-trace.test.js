'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');
const { createAsyncInspection, parseAsyncTrace, openAsyncTrace } = require('../src/java/async-trace');
const { argumentString, launchCommandMode } = require('../src/java/debug-runtime');
const { resolveLaunch, serverSettings } = require('../src/java/runtime');
const { StdioLsp, until } = require('./helpers/stdio-lsp');
const { DapClient } = require('./java-debug-dap');
const { asyncTraceFixture, assertAsyncChain } = require('./helpers/java-async-trace-fixture');
const { virtualTraceFixture, checkVirtualChain, writeRejectedTraces, verifyVirtualCompletion, jdbcOptions } =
  require('./helpers/virtual-async-trace-fixture');

const configPath = process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;
const traceSource = path.join(__dirname, '../runtime/java-async/src/rocketbrain/async/TaskTrace.java');
const encode = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const root = { kind: 'trace', version: 1, traceId: '11111111-2222-3333-4444-555555555555', pid: 199 };
const sourceFrame = { type: 'app.Order', method: 'work', file: 'Order.java', line: 5 };
const submission = { kind: 'submitted', id: 1, parent: 0, label: 'load', thread: { id: 1, name: 'main' }, frames: [sourceFrame] };
const active = { kind: 'entered', id: 1, thread: { id: 2, name: 'worker' } };
const virtualDatabases = ['mysql', 'mariadb'].map(engine =>
  [engine, process.env['ROCKETBRAIN_JAVA_ASYNC_VIRTUAL_' + engine.toUpperCase() + '_CONFIG']]);
const virtualClasspath = process.env.ROCKETBRAIN_JAVA_ASYNC_VIRTUAL_CLASSPATH;

async function launchAsyncFixture(lsp, uri, project, source, fixture, trace, markers, env, longClasspath = false) {
  const command = (name, ...args) => lsp.request('workspace/executeCommand', { command: name, arguments: args });
  const main = await until(async () => (await command('vscode.java.resolveMainClass', uri))
    ?.find(item => item.mainClass === fixture.mainClass), 65000);
  const built = await command('vscode.java.buildWorkspace', JSON.stringify({ mainClass: fixture.mainClass, projectName: main.projectName, isFullBuild: false }));
  assert.ok(built === 'SUCCEED' || built === 1, 'JDT fixture build ' + JSON.stringify(built));
  const [modulePaths, classPaths] = await command('vscode.java.resolveClasspath', fixture.mainClass, main.projectName);
  const javaExec = await command('vscode.java.resolveJavaExecutable', fixture.mainClass, main.projectName);
  const dap = new DapClient(await command('vscode.java.startDebugSession'));
  try {
    await dap.request('initialize', { adapterID: 'rocketbrain-java', clientID: 'async-trace', linesStartAt1: true,
      columnsStartAt1: true, pathFormat: 'path', supportsVariableType: true, supportsVariablePaging: true });
    const cmd = { type: 'rocketbrain-java', name: 'Async task tracer',
      mainClass: fixture.mainClass, projectName: main.projectName, classPaths, modulePaths, javaExec, cwd: project,
      args: argumentString([trace]), console: 'internalConsole', sourcePaths: [], env };
    if (longClasspath && process.platform === 'win32') {
      // Existing directories make this launch exceed CreateProcessW's ordinary limit.
      cmd.classPaths = [...classPaths, ...Array(Math.ceil(35000 / project.length)).fill(project)];
      assert.ok(cmd.classPaths.join(path.delimiter).length > 32767);
      cmd.shortenCommandLine = launchCommandMode(cmd);
      assert.equal(cmd.shortenCommandLine, 'argfile');
    }
    const started = dap.request('launch', cmd);
    started.catch(() => {});
    await dap.event('initialized', 0, 15000);
    const { breakpoints } = await dap.request('setBreakpoints', { source: { name: path.basename(source), path: source },
      breakpoints: markers.map(marker => ({ line: fixture.line(marker) })) });
    assert.ok(breakpoints.every(item => item.verified));
    await dap.request('configurationDone');
    await started;
    return dap;
  } catch (error) {
    await dap.close();
    throw error;
  }
}

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

test('virtual-thread provenance requires exact typed parent and worker identity without breaking legacy traces', async () => {
  const initial = { ...submission, handoff: 'virtual-thread', thread: { ...submission.thread, virtual: false } };
  const entered = { ...active, thread: { ...active.thread, virtual: true } };
  const nested = { ...initial, id: 2, parent: 1, handoff: 'executor', thread: entered.thread };
  const trace = (...rows) => parseAsyncTrace(encode([root, ...rows]));
  assert.equal(trace(initial, entered, nested).tasks.get(2).submittedBy.virtual, true);
  assert.throws(() => trace(initial, { ...entered, thread: { ...entered.thread, virtual: false } }), /invalid record/);
  assert.throws(() => trace(initial, { ...entered, thread: { ...entered.thread, id: initial.thread.id } }), /invalid record/);
  assert.throws(() => trace(initial, entered, { ...nested, thread: initial.thread }), /invalid record/);
  assert.throws(() => trace(initial, entered, { kind: 'completed', id: 1 }, nested), /invalid record/);
  assert.throws(() => trace({ ...initial, handoff: 'unknown' }), /invalid record/);
  assert.equal(trace(submission, active).tasks.get(1).worker.virtual, undefined);
  let typedWorker = [{ name: 'rocketbrainWorkerThreadId', value: '2' }, { name: 'rocketbrainWorkerVirtual', value: 'true' }];
  const state = { state: 'stopped', threadId: 7, stopVersion: 1 };
  const session = { id: 'virtual', type: 'rocketbrain-java', async customRequest(command) {
    if (command === 'stackTrace') return { stackFrames: [{ id: 25, name: 'TaskTrace.runRecorded(Task, Runnable)' }] };
    if (command === 'scopes') return { scopes: [{ name: 'Local', variablesReference: 11 }] };
    if (command === 'variables') return { variables: [
      { name: 'rocketbrainTraceId', value: '"' + root.traceId + '"' }, { name: 'rocketbrainTaskId', value: '1' }, ...typedWorker
    ] };
    assert.fail(command);
  } };
  let current = trace(initial, entered);
  const inspector = createAsyncInspection({ activeSession: () => session, getState: () => state, ensureTrusted() {},
    readTrace: async () => current });
  assert.equal((await inspector.inspect('unused')).chain[0].worker.virtual, true);
  typedWorker[0].value = '3';
  await assert.rejects(inspector.inspect('unused'), /worker identity differs/);
  typedWorker[0].value = '2';
  typedWorker[1].value = 'false';
  await assert.rejects(inspector.inspect('unused'), /worker identity differs/);
  typedWorker[1].value = 'true';
  current = trace(submission, active);
  await assert.rejects(inspector.inspect('unused'), /worker identity differs/);
  typedWorker = [];
  assert.equal((await inspector.inspect('unused')).chain[0].label, 'load');
  current = trace(initial, entered);
  await assert.rejects(inspector.inspect('unused'), /worker identity differs/);
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
  let dap, proof;
  try {
    await lsp.request('initialize', {
      processId: process.pid, rootUri: uri, workspaceFolders: [{ uri, name: 'async-trace' }],
      capabilities: { workspace: { configuration: true } }, initializationOptions: { bundles: launch.bundles, workspaceFolders: [uri], settings }
    }, 75000);
    lsp.notify('initialized', {});
    lsp.notify('workspace/didChangeConfiguration', { settings });
    dap = await launchAsyncFixture(lsp, uri, project, source, fixture, trace, ['UNTRACKED_STOP', 'ASYNC_STOP']);
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

test('a paused virtual Java thread identifies both traced launches and its CompletableFuture parent on real Spring JDBC', {
  skip: !(configPath && virtualClasspath && virtualDatabases.every(([, file]) => file)) && 'Configure the JDT debugger and owned Spring JDBC databases.',
  timeout: 240000
}, async context => {
  const runtime = JSON.parse(await fs.readFile(configPath, 'utf8'));
  const config = runtime.settings || runtime;
  const javaHome = runtime.javaHome || config['rocketbrain.java.javaHome'];
  const serverPath = runtime.serverPath || config['rocketbrain.java.serverPath'];
  const debugBundlePath = runtime.debugBundlePath || config['rocketbrain.java.debugBundlePath'];
  const parent = await fs.realpath(os.tmpdir());
  const owned = await fs.mkdtemp(path.join(parent, 'rb-virtual-async-'));
  context.after(async () => {
    const real = await fs.realpath(owned);
    assert.equal(path.relative(real, owned), '');
    assert.equal(path.relative(path.dirname(real), parent), '');
    assert.match(path.basename(real), /^rb-virtual-async-/);
    await fs.rm(real, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  });
  const project = path.join(owned, 'project');
  const source = path.join(project, 'src/main/java/dev/rocketbrain/virtualfixture/VirtualAsyncFixture.java');
  const helper = path.join(project, 'src/main/java/rocketbrain/async/TaskTrace.java');
  for (const file of [source, helper]) await fs.mkdir(path.dirname(file), { recursive: true });
  const fixture = virtualTraceFixture('dev.rocketbrain.virtualfixture', 'VirtualAsyncFixture');
  const pom = await fs.readFile(path.join(__dirname, 'fixtures/java/debugger/pom.xml'), 'utf8');
  const dependencies = [
    ['org.springframework', 'spring-jdbc', '7.0.10'], ['com.mysql', 'mysql-connector-j', '9.7.0'],
    ['org.mariadb.jdbc', 'mariadb-java-client', '3.5.10']
  ].map(([group, artifact, version]) => '<dependency><groupId>' + group + '</groupId><artifactId>' +
    artifact + '</artifactId><version>' + version + '</version></dependency>').join('');
  await Promise.all([
    fs.writeFile(source, fixture.source, { flag: 'wx' }),
    fs.copyFile(traceSource, helper),
    fs.writeFile(path.join(project, 'pom.xml'), pom.replace('</project>', '<dependencies>' + dependencies + '</dependencies></project>'), { flag: 'wx' })
  ]);
  const uri = pathToFileURL(project).href;
  const settings = serverSettings([{ name: 'JavaSE-25', path: javaHome, default: true }]);
  const lsp = new StdioLsp(resolveLaunch({ javaHome, serverPath, debugBundlePath, storagePath: path.join(owned, 'jdt') }));
  const reports = [];
  try {
    await lsp.request('initialize', {
      processId: process.pid, rootUri: uri, workspaceFolders: [{ uri, name: 'virtual-async' }],
      capabilities: { workspace: { configuration: true } }, initializationOptions: { bundles: [debugBundlePath], workspaceFolders: [uri], settings }
    }, 75000);
    lsp.notify('initialized', {});
    lsp.notify('workspace/didChangeConfiguration', { settings });
    for (const [engine, configFile] of virtualDatabases) {
      const { env } = await jdbcOptions({ engine, configFile, classpathFile: virtualClasspath });
      const files = ['live', 'other-id', 'other-worker', 'stripped-worker'].map(name => path.join(owned, engine + '-' + name + '.jsonl'));
      const [trace, wrongId, wrongWorker, strippedWorker] = files;
      let dap;
      try {
        dap = await launchAsyncFixture(lsp, uri, project, source, fixture, trace, ['UNWRAPPED_STOP', 'VIRTUAL_STOP'], env, true);
        const first = await dap.event('stopped', 0, 18000);
        const state = { state: 'stopped', threadId: first.threadId, stopVersion: 1 };
        const session = { id: engine, type: 'rocketbrain-java', customRequest: (...args) => dap.request(...args) };
        const inspector = createAsyncInspection({ activeSession: () => session, getState: () => state, ensureTrusted() {} });
        const top = async threadId => (await session.customRequest('stackTrace', { threadId, startFrame: 0, levels: 1 })).stackFrames[0];
        assert.equal((await top(first.threadId)).line, fixture.line('UNWRAPPED_STOP'));
        await assert.rejects(inspector.inspect(trace), /No recorded Java task/);
        const afterUnwrapped = dap.events.length;
        await session.customRequest('continue', { threadId: first.threadId });
        const worker = await dap.event('stopped', afterUnwrapped, 18000);
        Object.assign(state, { threadId: worker.threadId, stopVersion: 2 });
        assert.notEqual(worker.threadId, first.threadId);
        const paused = await top(worker.threadId);
        assert.equal(paused.line, fixture.line('VIRTUAL_STOP'));
        assert.equal(path.relative(paused.source.path, source), '');
        const report = await inspector.inspect(trace);
        const proof = checkVirtualChain(fixture, report);
        await writeRejectedTraces(...files, report.taskId);
        await assert.rejects(inspector.inspect(wrongId), /different Java runtime/);
        await assert.rejects(inspector.inspect(wrongWorker), /worker identity differs/);
        await assert.rejects(inspector.inspect(strippedWorker), /worker identity differs/);
        const after = dap.events.length;
        await session.customRequest('continue', { threadId: worker.threadId });
        state.state = 'running';
        await assert.rejects(inspector.inspect(trace), /Pause a Rocketbrain Java task/);
        await dap.event('terminated', after, 18000);
        const output = dap.events.filter(event => event.event === 'output').map(event => event.body.output).join('');
        reports.push({ ...proof, ...await verifyVirtualCompletion(trace, output, engine), pausedLine: paused.line,
          unwrappedRejected: true, mismatchedTraceRejected: true, mismatchedWorkerRejected: true, strippedWorkerRejected: true,
          resumedInspectionRejected: true });
      } finally {
        await dap?.close();
      }
    }
  } finally {
    await lsp.close();
  }
  if (process.env.ROCKETBRAIN_JAVA_ASYNC_VIRTUAL_RECEIPT) {
    await fs.writeFile(process.env.ROCKETBRAIN_JAVA_ASYNC_VIRTUAL_RECEIPT,
      JSON.stringify({ reports }, null, 2) + '\n', { flag: 'wx' });
  }
});
