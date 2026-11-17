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
  const vscode = { workspace: { isTrusted: trusted, textDocuments: [] }, window: { showErrorMessage: message => errors.push(message) }, commands: { registerCommand: () => disposable }, debug: { registerDebugConfigurationProvider(type, provider) { handlers.provider = provider; return disposable; }, registerDebugAdapterDescriptorFactory(type, factory) { handlers.factory = factory; return disposable; }, onDidStartDebugSession: () => disposable, onDidTerminateDebugSession: () => disposable, stopDebugging: async () => {} }, EventEmitter: Emitter, DebugAdapterInlineImplementation: class { constructor(implementation) { this.implementation = implementation; } } };
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

test('Java debugger validates attach ports and directly asks its own language engine for a loopback DAP port', async t => {
  const sockets = new Set(), server = net.createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  const { provider, factory, controller, calls, errors } = setup(true, server.address().port);
  assert.equal(await provider.resolveDebugConfigurationWithSubstitutedVariables(undefined, { request: 'attach', port: 70000 }), undefined); assert.match(errors[0], /TCP port/); assert.equal(calls.length, 0);
  const resolved = await provider.resolveDebugConfigurationWithSubstitutedVariables(undefined, { request: 'attach', port: 5005 }); assert.equal(resolved.hostName, '127.0.0.1');
  const adapter = await factory.createDebugAdapterDescriptor({ id: 'unit', type: 'rocketbrain-java' }); assert.ok(adapter.implementation); assert.equal(calls.at(-1).command, 'vscode.java.startDebugSession'); adapter.implementation.dispose();
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
