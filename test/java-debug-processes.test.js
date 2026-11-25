'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');
const { createDebugProcessDiscovery, processId, readSocketOwners, readyProcesses } = require('../src/java/debug-processes');
const { resolveLaunch, serverSettings } = require('../src/java/runtime');
const { StdioLsp, until } = require('./helpers/stdio-lsp');
const { DapClient } = require('./java-debug-dap');
const { processFixture, fixtureJvm } = require('./helpers/java-debug-process-fixture');

const testConfig = process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;

test('Java process discovery binds debugger metadata to the operating system listener owner', () => {
  const owners = readSocketOwners('870:50110\n870:61234\n871:50111\n4294967296:5555\n0:50111\n900:0\nbroken\n');
  assert.deepEqual([...owners.keys()], [870, 871]);
  assert.deepEqual(readyProcesses('870\t1795610598078\t50110\tinvoice.jar\n871\t1795610598079\t50110\tforeign', owners),
    [{ pid: 870, startedAt: 1795610598078, hostName: '127.0.0.1', port: 50110, label: 'invoice.jar' }]);
  assert.deepEqual(readyProcesses('870\t1795610598078\t50110\tfirst\n870\t1795610598078\t61234\tsecond', owners), []);
  assert.deepEqual(readyProcesses('870\t1795610598078\t50110\tfirst\n870\t1795610598079\t50110\tsecond', owners), []);
  assert.deepEqual(readyProcesses('870\t1795610598078\t50110\tfirst --token=secret', owners), []);
  assert.equal(processId('870'), 870);
  for (const bad of ['-9', '2; exit', '0x11', 1.1, 0, 4294967296, null]) assert.throws(() => processId(bad), /local Java process ID/);
});

test('Java process discovery respects trust and cancellation before reading system processes', async () => {
  let homeReached = false;
  const restricted = createDebugProcessDiscovery({
    javaHome() { homeReached = true; }, trusted() { throw Error('Workspace restricted'); }
  });
  await assert.rejects(restricted.list(), /Workspace restricted/);
  assert.equal(homeReached, false);
  const trusted = createDebugProcessDiscovery({ javaHome() { homeReached = true; }, trusted() {} });
  const cancel = new AbortController(); cancel.abort();
  await assert.rejects(trusted.list(cancel.signal), /cancelled/);
  assert.equal(homeReached, false);
});

test('actual Windows JVM discovery finds only debug-ready PIDs, attaches and detaches without killing the external JVM', {
  skip: (process.platform !== 'win32' || !testConfig) && 'Configure Windows and the independent Java test engine.',
  timeout: 240000
}, async context => {
  const runtime = JSON.parse(await fs.readFile(testConfig, 'utf8'));
  const config = runtime.settings || runtime;
  const javaHome = runtime.javaHome || config['rocketbrain.java.javaHome'];
  const serverPath = runtime.serverPath || config['rocketbrain.java.serverPath'];
  const debugBundlePath = runtime.debugBundlePath || config['rocketbrain.java.debugBundlePath'];
  const parent = await fs.realpath(os.tmpdir());
  const owned = await fs.mkdtemp(path.join(parent, 'rb-debug-picker-test-'));
  context.after(async () => {
    const real = await fs.realpath(owned);
    assert.equal(real, owned);
    assert.equal(path.dirname(real), parent);
    assert.match(path.basename(real), /^rb-debug-picker-test-/);
    await fs.rm(real, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  });
  const project = path.join(owned, 'project');
  const source = path.join(project, 'src/main/java/dev/rocketbrain/picker/AttachFixture.java');
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.copyFile(path.join(__dirname, 'fixtures/java/debugger/pom.xml'), path.join(project, 'pom.xml'));
  const fixture = processFixture('dev.rocketbrain.picker', 'AttachFixture');
  await fs.writeFile(source, fixture.source, { flag: 'wx' });
  const rootUri = pathToFileURL(project).href;
  const settings = serverSettings([{ name: 'JavaSE-25', path: javaHome, default: true }]);
  const launch = resolveLaunch({ javaHome, serverPath, debugBundlePath, storagePath: path.join(owned, 'jdt') });
  const lsp = new StdioLsp(launch);
  const command = (name, ...args) => lsp.request('workspace/executeCommand', { command: name, arguments: args });
  let actual, nonDebug, dap;
  const receipt = {};
  try {
    await lsp.request('initialize', {
      processId: process.pid, rootUri, workspaceFolders: [{ uri: rootUri, name: 'java-pid-fixture' }],
      capabilities: { workspace: { configuration: true } },
      initializationOptions: { bundles: launch.bundles, workspaceFolders: [rootUri], settings }
    }, 75000);
    lsp.notify('initialized', {});
    lsp.notify('workspace/didChangeConfiguration', { settings });
    const main = await until(async () => (await command('vscode.java.resolveMainClass', rootUri))
      ?.find(item => item.mainClass === fixture.mainClass), 65000);
    const build = await command('vscode.java.buildWorkspace', JSON.stringify({ mainClass: fixture.mainClass, projectName: main.projectName, isFullBuild: false }));
    assert.ok(build === 'SUCCEED' || build === 1, String(build));
    const [, classPaths] = await command('vscode.java.resolveClasspath', fixture.mainClass, main.projectName);
    const java = await command('vscode.java.resolveJavaExecutable', fixture.mainClass, main.projectName);
    actual = fixtureJvm(java, project, fixture.mainClass, classPaths);
    nonDebug = fixtureJvm(java, project, fixture.mainClass, classPaths, { debug: false });
    const [port, plainPort] = await Promise.all([actual.readyPort(), nonDebug.readyPort()]);
    assert.notEqual(port, plainPort);
    const service = createDebugProcessDiscovery({ javaHome: () => javaHome, trusted() {} });
    const listed = await service.list();
    const picked = listed.find(item => item.pid === actual.target.pid);
    assert.ok(picked, 'Expected the pre-enabled JVM to be listed.');
    assert.equal(picked.port, port);
    assert.ok(!listed.some(entry => entry.pid === nonDebug.target.pid), 'Normal TCP listeners are not JDWP.');
    assert.doesNotMatch(JSON.stringify(listed), /fixture-private-argument/);
    await assert.rejects(service.resolve({ ...picked, startedAt: picked.startedAt - 1 }), /changed/);
    const target = await service.resolve(picked);
    assert.deepEqual(target, picked);

    dap = new DapClient(await command('vscode.java.startDebugSession'));
    await dap.request('initialize', { adapterID: 'rocketbrain-java', clientID: 'pid-picker-test',
      linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path', supportsRunInTerminalRequest: false });
    const connecting = dap.request('attach', { hostName: target.hostName, port: target.port, projectName: main.projectName,
      type: 'rocketbrain-java', name: 'PID-discovered Java fixture', sourcePaths: [] });
    connecting.catch(() => {});
    await dap.event('initialized');
    const breakpoints = await dap.request('setBreakpoints', { source: { name: path.basename(source), path: source }, breakpoints: [{ line: fixture.line }] });
    assert.ok(breakpoints.breakpoints[0].verified);
    await dap.request('configurationDone');
    await connecting;
    const stopped = await dap.event('stopped', 0, 18000);
    assert.equal(stopped.reason, 'breakpoint');
    const { stackFrames } = await dap.request('stackTrace', { threadId: stopped.threadId });
    assert.equal(stackFrames[0].line, fixture.line);
    assert.equal((await dap.request('evaluate', { frameId: stackFrames[0].id, expression: 'watched', context: 'watch' })).result, '73');
    await dap.request('disconnect', { terminateDebuggee: false });
    await until(() => actual.output().includes('DEBUG_FIXTURE_RESUMED:73'), 10000);
    assert.equal(actual.ended(), false);
    await actual.leave();
    await assert.rejects(service.resolve(target), /does not have a verified local JDWP listener/);
    Object.assign(receipt, { platform: process.platform, selected: target, dynamicallyAssignedPort: true,
      normalSocketExcluded: true, staleIdentityRefused: true, exitedTargetRefused: true, detachedProcessSurvived: true,
      breakpoint: { line: fixture.line, watched: 73 } });
  } finally {
    await dap?.close();
    await Promise.all([actual?.leave(), nonDebug?.leave()]);
    await lsp.close();
  }
  if (process.env.ROCKETBRAIN_JAVA_PROCESS_RECEIPT) {
    await fs.writeFile(process.env.ROCKETBRAIN_JAVA_PROCESS_RECEIPT, JSON.stringify(receipt, null, 2) + '\n');
  }
});
