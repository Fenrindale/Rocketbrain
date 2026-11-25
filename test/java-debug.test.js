'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { registerJavaDebugger } = require('../src/java/debug');
const { independentJavaExecutable, resolveDebugBundles } = require('../src/java/debug-runtime');

function setup(trusted = true, port = 40001) {
  const handlers = {}, calls = [], errors = []; const disposable = { dispose() {} };
  class Emitter { constructor() { this.listeners = new Set(); this.event = callback => { this.listeners.add(callback); return { dispose: () => this.listeners.delete(callback) }; }; } fire(value) { for (const callback of this.listeners) callback(value); } dispose() { this.listeners.clear(); } }
  const vscode = { workspace: { isTrusted: trusted, textDocuments: [] }, window: { showErrorMessage: message => errors.push(message) }, commands: { registerCommand: () => disposable }, debug: { registerDebugConfigurationProvider(type, provider) { handlers.provider = provider; return disposable; }, registerDebugAdapterDescriptorFactory(type, factory) { handlers.factory = factory; return disposable; }, onDidStartDebugSession: () => disposable, onDidTerminateDebugSession: () => disposable, stopDebugging: async () => {}, startDebugging: async (scope, configuration, options) => { calls.push({ scope, configuration, options }); return true; } }, EventEmitter: Emitter, DebugAdapterInlineImplementation: class { constructor(implementation) { this.implementation = implementation; } } };
  const api = { start: async () => calls.push('start'), getState: () => ({ debugBundlePath: '/independent/pinned.jar' }), executeWorkspaceCommand: async (command, ...args) => { calls.push({ command, args }); return command === 'vscode.java.startDebugSession' ? port : {}; } };
  const controller = registerJavaDebugger(vscode, api, { appendLine() {} });
  return { ...handlers, controller, calls, errors };
}

test('Java debugger blocks untrusted attach and cancellation before engine execution', async () => {
  const restricted = setup(false);
  assert.equal(await restricted.provider.resolveDebugConfigurationWithSubstitutedVariables(undefined, { request: 'attach', port: 5005 }), undefined);
  assert.equal(restricted.calls.length, 0); assert.match(restricted.errors[0], /Trust this workspace/);
  await assert.rejects(() => restricted.factory.createDebugAdapterDescriptor(), /Trust/); restricted.controller.dispose();
  const cancelled = setup();
  assert.equal(await cancelled.provider.resolveDebugConfigurationWithSubstitutedVariables(undefined, { request: 'launch', mainClass: 'example.Main' }, { isCancellationRequested: true }), undefined);
  assert.equal(cancelled.calls.length, 0); cancelled.controller.dispose();
});

test('Attaching to an already running local JVM bypasses the editor save dialog and retains the reviewed identity', async () => {
  const restricted = setup(false);
  await assert.rejects(() => restricted.controller.processes.attach(870, { folder: {} }), /Trust this workspace/);
  assert.equal(restricted.calls.length, 0);
  restricted.controller.dispose();
  const { controller, calls } = setup();
  const folder = { name: 'spring-fixture' };
  const target = { pid: 870, startedAt: 1795610598078, hostName: '127.0.0.1', port: 50110 };
  assert.equal(await controller.processes.attach({ ...target, label: 'fixture.jar' }, { folder, projectName: 'fixture' }), true);
  const [{ configuration, options, scope }] = calls;
  assert.strictEqual(scope, folder);
  assert.deepEqual(options, { suppressSaveBeforeStart: true });
  assert.equal(configuration.request, 'attach');
  assert.equal(configuration.processId, target.pid);
  assert.equal(configuration.projectName, 'fixture');
  assert.deepEqual(configuration.__rocketbrainJavaProcessSelection, target);
  controller.dispose();
});

test('Java debugger validates attach ports and directly asks its own language engine for a loopback DAP port', async t => {
  const sockets = new Set(), server = net.createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  const { provider, factory, controller, calls, errors } = setup(true, server.address().port);
  assert.equal(await provider.resolveDebugConfigurationWithSubstitutedVariables(undefined, { request: 'attach', processId: 12, port: 5005 }), undefined);
  assert.match(errors.at(-1), /either a local process ID or a host and port/);
  assert.equal(await provider.resolveDebugConfigurationWithSubstitutedVariables(undefined, { request: 'attach', processId: 'x' }), undefined);
  assert.match(errors.at(-1), /positive local Java process ID/);
  assert.equal(await provider.resolveDebugConfigurationWithSubstitutedVariables(undefined, { request: 'attach', port: 70000 }), undefined); assert.match(errors.at(-1), /TCP port/); assert.equal(calls.length, 0);
  const resolved = await provider.resolveDebugConfigurationWithSubstitutedVariables(undefined, { request: 'attach', port: 5005, __rocketbrainVerifiedAttach: 'forged' });
  assert.equal(resolved.hostName, '127.0.0.1');
  assert.equal(resolved.__rocketbrainVerifiedAttach, undefined);
  const session = { id: 'unit', type: 'rocketbrain-java', configuration: resolved };
  const adapter = await factory.createDebugAdapterDescriptor(session); assert.ok(adapter.implementation); assert.equal(calls.at(-1).command, 'vscode.java.startDebugSession');
  adapter.implementation.send({ type:'response', command:'attach', success:true });
  assert.equal(controller.verifiedLocalPid(session), undefined, 'A manual host/port attach cannot claim an OS-verified PID');
  adapter.implementation.dispose();
  await assert.rejects(() => controller.hotCodeReplace(), /Pause/);
  controller.dispose(); await assert.rejects(() => factory.createDebugAdapterDescriptor(), /disposed/);
});

test('Java application launch rejects embedded JBR and the original unpatched debug JAR', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rocketbrain-java-debug-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin); const java = path.join(bin, process.platform === 'win32' ? 'java.exe' : 'java'); fs.writeFileSync(java, 'fixture');
  fs.writeFileSync(path.join(dir, 'release'), 'JAVA_VERSION="21.0.1"\nIMPLEMENTOR="JetBrains s.r.o."\n'); assert.throws(() => independentJavaExecutable(java), /JetBrains Runtime/);
  fs.writeFileSync(path.join(dir, 'release'), 'JAVA_VERSION="21.0.1"\nIMPLEMENTOR="Eclipse Adoptium"\n'); assert.equal(independentJavaExecutable(java), fs.realpathSync(java));
  const jar = path.join(dir, 'unpatched.jar'); fs.writeFileSync(jar, 'Original or unverified bundle'); assert.throws(() => resolveDebugBundles(jar), /loopback-only build/);
});
