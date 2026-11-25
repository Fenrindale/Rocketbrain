'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn, spawnSync } = require('node:child_process');
const net = require('node:net');
const { resolveLaunch, serverSettings } = require('../src/java/runtime');
const { resolveDebugBundle } = require('../src/java/debug-runtime');
const { StdioLsp, until } = require('./helpers/stdio-lsp');
const { DapClient, freePort } = require('./java-debug-dap');

test('independent Java debug bundle launches and attaches real JVMs with breakpoints, stack, variables, step and continue', { skip: !process.env.ROCKETBRAIN_JAVA_TEST_CONFIG, timeout: 300000 }, async t => {
  const runtime = JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_JAVA_TEST_CONFIG, 'utf8')); const config = runtime.settings || runtime;
  const javaHome = runtime.javaHome || config['rocketbrain.java.javaHome'], serverPath = runtime.serverPath || config['rocketbrain.java.serverPath'];
  const debugBundle = resolveDebugBundle(config['rocketbrain.java.debugBundlePath'], serverPath);
  assert.ok(debugBundle, 'Provision the debug bundle before this integration test.');
  const bundles = [debugBundle.path];
  const root = path.resolve(__dirname, 'fixtures/java/maven'), rootUri = pathToFileURL(root).href;
  const lsp = new StdioLsp(resolveLaunch({ javaHome, serverPath, storagePath: path.resolve(__dirname, '../test-output/java-debug-engine-loopback') })); let lspClosed = false; t.after(() => lspClosed ? undefined : lsp.close());
  const initialized = await lsp.request('initialize', { processId: process.pid, rootUri, workspaceFolders: [{ uri: rootUri, name: 'java-debug-fixture' }], capabilities: { workspace: { configuration: true } }, initializationOptions: { bundles, workspaceFolders: [rootUri], settings: serverSettings([{ name: 'JavaSE-25', path: javaHome, default: true }]) } }, 90000); lsp.notify('initialized', {});
  assert.ok(initialized.capabilities.executeCommandProvider);
  const command = (name, ...args) => lsp.request('workspace/executeCommand', { command: name, arguments: args });
  const main = await until(async () => (await command('vscode.java.resolveMainClass', rootUri))?.find(item => item.mainClass === 'dev.rocketbrain.App'));
  const build = await command('vscode.java.buildWorkspace', JSON.stringify({ mainClass: main.mainClass, projectName: main.projectName, isFullBuild: false })); assert.ok(build === 'SUCCEED' || build === 1, JSON.stringify(build));
  const [modulePaths, classPaths] = await command('vscode.java.resolveClasspath', main.mainClass, main.projectName);
  const javaExec = await command('vscode.java.resolveJavaExecutable', main.mainClass, main.projectName);
  const source = path.join(root, 'src/main/java/dev/rocketbrain/Greeter.java'); const reports = [], debugPorts = new Set();
  async function exercise(request, args) {
    const debugPort = await command('vscode.java.startDebugSession'); debugPorts.add(debugPort);
    let listeners;
    if (process.platform === 'win32') {
      const inspection = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Get-NetTCPConnection -LocalPort ${debugPort} -State Listen | Select-Object LocalAddress,LocalPort,OwningProcess | ConvertTo-Json -Compress`], { encoding: 'utf8', windowsHide: true });
      assert.equal(inspection.status, 0, inspection.stderr); const value = JSON.parse(inspection.stdout); listeners = Array.isArray(value) ? value : [value];
      assert.ok(listeners.length && listeners.every(listener => listener.LocalAddress === '127.0.0.1'), JSON.stringify(listeners));
    }
    const dap = new DapClient(debugPort); t.after(() => dap.close());
    const capabilities = await dap.request('initialize', { adapterID: 'rocketbrain-java', clientID: 'rocketbrain-raw-test', linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path', supportsRunInTerminalRequest: false, supportsVariableType: true }); assert.ok(capabilities.supportsConfigurationDoneRequest);
    const starting = dap.request(request, args); starting.catch(() => {});
    await dap.event('initialized');
    const breakpoints = await dap.request('setBreakpoints', { source: { name: 'Greeter.java', path: source }, breakpoints: [{ line: 5 }] });
    await dap.request('configurationDone'); await starting;
    const stopped = await dap.event('stopped'); assert.equal(stopped.reason, 'breakpoint');
    const { threads } = await dap.request('threads'); assert.ok(threads.some(thread => thread.id === stopped.threadId));
    const { stackFrames } = await dap.request('stackTrace', { threadId: stopped.threadId }); assert.ok(stackFrames[0].name.includes('greet')); assert.equal(stackFrames[0].line, 5);
    const { scopes } = await dap.request('scopes', { frameId: stackFrames[0].id }); const variables = [];
    for (const scope of scopes) if (scope.variablesReference) variables.push(...(await dap.request('variables', { variablesReference: scope.variablesReference })).variables);
    assert.ok(variables.some(variable => variable.name === 'name' && variable.value.includes('Rocketbrain')), JSON.stringify(variables));
    const after = dap.events.length; await dap.request('next', { threadId: stopped.threadId }); const stepped = await dap.event('stopped', after); assert.equal(stepped.reason, 'step');
    const steppedStack = await dap.request('stackTrace', { threadId: stepped.threadId }); assert.ok(steppedStack.stackFrames.length);
    await dap.request('continue', { threadId: stepped.threadId }); await dap.event('terminated');
    reports.push({ request, debugPort, listeners, breakpoint: breakpoints.breakpoints, stopped, topFrame: stackFrames[0], variables: variables.map(({ name, value, type }) => ({ name, value, type })), step: stepped, terminated: true }); await dap.close();
  }
  await exercise('launch', { name: 'Rocketbrain raw launch', type: 'rocketbrain-java', mainClass: main.mainClass, projectName: main.projectName, modulePaths, classPaths, javaExec, cwd: root, console: 'internalConsole', sourcePaths: [], encoding: 'UTF-8' });
  const port = await freePort(); const child = spawn(javaExec, [`-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=127.0.0.1:${port}`, '-cp', classPaths.join(path.delimiter), main.mainClass], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let childOutput = ''; child.stdout.on('data', chunk => { childOutput += chunk; }); child.stderr.on('data', chunk => { childOutput += chunk; }); t.after(() => { if (child.exitCode === null) child.kill(); });
  await until(() => childOutput.includes('Listening for transport dt_socket'), 15000);
  await exercise('attach', { name: 'Rocketbrain raw attach', type: 'rocketbrain-java', hostName: '127.0.0.1', port, projectName: main.projectName, sourcePaths: [] });
  await lsp.close(); lspClosed = true;
  for (const debugPort of debugPorts) await until(() => new Promise(resolve => { const socket = net.connect({ host: '127.0.0.1', port: debugPort }); socket.once('connect', () => { socket.destroy(); resolve(false); }); socket.once('error', () => resolve(true)); socket.setTimeout(500, () => { socket.destroy(); resolve(false); }); }), 10000);
  const evidence = { engine: 'Microsoft java-debug ' + debugBundle.build, bundle: bundles[0], javaExec, main, modulePaths, classPaths, checks: reports, debugPortsClosedAfterShutdown: true, originalIdeRequired: false, marketplaceExtensionRequired: false };
  fs.writeFileSync(path.resolve(__dirname, '../test-output/java-debug-engine.json'), JSON.stringify(evidence, null, 2) + '\n');
});
