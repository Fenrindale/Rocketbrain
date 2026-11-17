'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { registerRuntimeSpring } = require('../src/spring/runtime-vscode');

function harness() {
  const commands = new Map(), stored = new Map(), state = new Map(), output = [];
  class EventEmitter { constructor() { this.listeners = new Set(); this.event = listener => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; }; } fire(value) { for (const listener of this.listeners) listener(value); } dispose() { this.listeners.clear(); } }
  const input = [], picks = [];
  const vscode = { EventEmitter, workspace: { isTrusted: true, getConfiguration: () => ({ get: (name, fallback) => fallback }) }, commands: { registerCommand(name, action) { commands.set(name, action); return { dispose() { commands.delete(name); } }; } }, window: { withProgress: (options, action) => action({ report() {} }), showInputBox: async () => input.shift(), showQuickPick: async () => picks.shift(), showErrorMessage: async message => output.push(message), showInformationMessage: async () => {} }, ProgressLocation: { Notification: 15 } };
  const context = { secrets: { get: async key => stored.get(key), store: async (key, value) => stored.set(key, value), delete: async key => stored.delete(key) }, workspaceState: { get: key => state.get(key), update: async (key, value) => state.set(key, value) } };
  const api = registerRuntimeSpring(vscode, context, { appendLine: message => output.push(message) }, { analyze: async () => ({ beans: [], revision: 1 }) });
  return { api, vscode, commands, stored, state, output, input, picks };
}
async function serve(t, { delay = 0, token = '' } = {}) {
  let calls = 0;
  const server = http.createServer((request, response) => {
    calls++; if (token) assert.equal(request.headers.authorization, `Bearer ${token}`);
    const endpoint = request.url.split('/').at(-1);
    const payload = endpoint === 'env' ? { activeProfiles: ['dev'], propertySources: [{ name: 'fixture', properties: { token: { value: token } } }] } : { contexts: { application: endpoint === 'beans' ? { beans: { dynamic: { type: 'demo.Dynamic', dependencies: [] } } } : endpoint === 'conditions' ? { positiveMatches: {}, negativeMatches: {} } : endpoint === 'configprops' ? { beans: {} } : { mappings: { dispatcherServlets: {} } } } };
    setTimeout(() => response.end(JSON.stringify(payload)), delay);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { url: `http://127.0.0.1:${server.address().port}/actuator`, calls: () => calls };
}

test('runtime UI controller is disconnected and performs no request before explicit trusted connect', async t => {
  const fixture = await serve(t), h = harness(); t.after(() => h.api.dispose());
  assert.equal(h.api.snapshot().state, 'disconnected'); assert.equal(fixture.calls(), 0);
  h.vscode.workspace.isTrusted = false;
  await assert.rejects(h.api.connect({ url: fixture.url }), error => error.code === 'UNTRUSTED_WORKSPACE'); assert.equal(fixture.calls(), 0);
  h.vscode.workspace.isTrusted = true; const events = []; h.api.onDidChange(value => events.push(value.state));
  const value = await h.api.connect({ url: fixture.url }); assert.equal(value.state, 'connected'); assert.deepEqual(events, ['connecting', 'connected']); assert.equal(fixture.calls(), 5);
  assert.equal((await h.api.compare()).beans[0].observation, 'runtime-only');
  h.api.disconnect(); assert.equal(h.api.snapshot().state, 'disconnected'); assert.equal(h.api.snapshot().counts.beans, 0);
});

test('explicit connection UI stores authentication only in SecretStorage and scopes it to the URL', async t => {
  const token = 'private-controller-token', fixture = await serve(t, { token }), h = harness(); t.after(() => h.api.dispose());
  h.input.push(fixture.url, token); h.picks.push({ value: 'bearer' });
  await h.commands.get('rocketbrain.spring.connectRuntime')();
  assert.equal(h.stored.size, 1); assert.equal([...h.stored.values()][0], `Bearer ${token}`);
  assert.equal([...h.state.values()].some(value => String(value).includes(token)), false);
  assert.equal(JSON.stringify(h.api.snapshot()).includes(token), false); assert.equal(h.output.some(value => value.includes(token)), false);
  assert.equal([...h.stored.keys()][0].includes(token), false);
});

test('trust revoked during observation discards completed data and clears the connection', async t => {
  const fixture = await serve(t, { delay: 50 }), h = harness(); t.after(() => h.api.dispose());
  const pending = h.api.connect({ url: fixture.url }); h.vscode.workspace.isTrusted = false;
  await assert.rejects(pending, error => error.code === 'UNTRUSTED_WORKSPACE');
  assert.equal(h.api.snapshot().state, 'disconnected'); assert.equal(h.api.snapshot().contexts.length, 0);
});

test('disconnect during an in-flight observation prevents stale runtime data from reappearing', async t => {
  const fixture = await serve(t, { delay: 60 }), h = harness(); t.after(() => h.api.dispose());
  const events = []; h.api.onDidChange(value => events.push(value.state));
  const pending = h.api.connect({ url: fixture.url }); h.api.disconnect();
  await pending;
  assert.equal(h.api.snapshot().state, 'disconnected'); assert.equal(h.api.snapshot().counts.beans, 0);
  assert.equal(events.at(-1), 'disconnected'); assert.equal(events.includes('connected'), false);
});
