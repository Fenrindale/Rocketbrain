'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { registerRuntimeSpring } = require('../src/spring/runtime-vscode');

function harness() {
  const commands = new Map(), stored = new Map(), state = new Map(), output = [];
  class EventEmitter { constructor() { this.listeners = new Set(); this.event = listener => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; }; } fire(value) { for (const listener of this.listeners) listener(value); } dispose() { this.listeners.clear(); } }
  const input = [], picks = [], panels = [];
  const vscode = { EventEmitter, workspace: { isTrusted: true, getConfiguration: () => ({ get: (name, fallback) => fallback }) }, commands: { registerCommand(name, action) { commands.set(name, action); return { dispose() { commands.delete(name); } }; } }, window: { withProgress: (options, action) => action({ report() {} }), showInputBox: async () => input.shift(), showQuickPick: async () => picks.shift(), showErrorMessage: async message => output.push(message), showInformationMessage: async () => {} }, ProgressLocation: { Notification: 15 } };
  vscode.ViewColumn = { Beside: -2 };
  vscode.window.createWebviewPanel = (type, title, column, options) => {
    const closed = new EventEmitter(), inbound = new EventEmitter();
    const panel = { type, title, column, options, reveal() {}, onDidDispose: closed.event,
      dispose() { closed.fire(); closed.dispose(); inbound.dispose(); }, webview: { html: '', onDidReceiveMessage: inbound.event } };
    panels.push(panel);
    return panel;
  };
  const context = { secrets: { get: async key => stored.get(key), store: async (key, value) => stored.set(key, value), delete: async key => stored.delete(key) }, workspaceState: { get: key => state.get(key), update: async (key, value) => state.set(key, value) } };
  const api = registerRuntimeSpring(vscode, context, { appendLine: message => output.push(message) }, { analyze: async () => ({ beans: [], revision: 1 }) });
  return { api, vscode, commands, stored, state, output, input, picks, panels };
}
async function serve(t, { delay = 0, token = '' } = {}) {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url); if (token) assert.equal(request.headers.authorization, `Bearer ${token}`);
    if (request.url.startsWith('/actuator/health')) {
      const root = request.url === '/actuator/health';
      const readiness = request.url.endsWith('/readiness');
      const payload = root ? { status: 'UP', groups: ['readiness'], components: { db: { status: 'UP' }, '<unsafe label>': { status: 'UP' } } } :
        { status: readiness ? 'OUT_OF_SERVICE' : 'UP', details: { content: 'discard-me' } };
      setTimeout(() => { response.writeHead(readiness ? 503 : 200); response.end(JSON.stringify(payload)); }, delay);
      return;
    }
    const endpoint = request.url.split('/').at(-1);
    const payload = endpoint === 'env' ? { activeProfiles: ['dev'], propertySources: [{ name: 'fixture', properties: { token: { value: token } } }] } : { contexts: { application: endpoint === 'beans' ? { beans: { dynamic: { type: 'demo.Dynamic', dependencies: [] } } } : endpoint === 'conditions' ? { positiveMatches: {}, negativeMatches: {} } : endpoint === 'configprops' ? { beans: {} } : { mappings: { dispatcherServlets: {} } } } };
    setTimeout(() => response.end(JSON.stringify(payload)), delay);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { url: `http://127.0.0.1:${server.address().port}/actuator`, calls: () => requests.length, requests };
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

test('the Spring Health pane drills down only through observed groups and components and separates HTTP status', async t => {
  const fixture = await serve(t), h = harness(); t.after(() => h.api.dispose());
  assert.equal((await h.commands.get('rocketbrain.spring.runtimeHealth')()).state, 'disconnected');
  assert.equal(fixture.calls(), 0);
  assert.match(h.panels[0].webview.html, /Connect to a Spring runtime/);
  await h.api.connect({ url: fixture.url });
  assert.equal(fixture.calls(), 5);
  const root = await h.commands.get('rocketbrain.spring.runtimeHealth')();
  assert.equal(root.observation.status, 'UP');
  assert.equal(root.observation.httpStatus, 200);
  assert.deepEqual(root.choices.map(choice => [choice.kind, choice.name]), [['group', 'readiness'], ['component', 'db']]);
  assert.match(h.panels[0].webview.html, /&lt;unsafe label&gt;/);
  assert.doesNotMatch(h.panels[0].webview.html, /<unsafe label>/);
  assert.match(h.panels[0].webview.html, /Content-Security-Policy/);
  await h.api.health.select(-1);
  assert.equal(fixture.calls(), 6);
  const readiness = await h.api.health.select(0);
  assert.equal(readiness.observation.status, 'OUT_OF_SERVICE');
  assert.match(h.panels[0].webview.html, /HTTP 503/);
  assert.match(h.panels[0].webview.html, /Only the aggregate status is visible/);
  assert.doesNotMatch(h.panels[0].webview.html, /discard-me/);
  await h.api.health.back();
  const database = await h.api.health.select(1);
  assert.deepEqual(database.path.map(item => item.name), ['db']);
  await h.api.health.refresh();
  assert.deepEqual(fixture.requests.filter(candidate => candidate.includes('/health')), [
    '/actuator/health', '/actuator/health/readiness', '/actuator/health', '/actuator/health/db', '/actuator/health/db'
  ]);
});

test('disconnect removes a pending Health pane report and drops the stale response', async t => {
  const fixture = await serve(t, { delay: 60 }), h = harness(); t.after(() => h.api.dispose());
  await h.api.connect({ url: fixture.url });
  const pending = h.api.health.open();
  assert.equal(h.api.health.snapshot().state, 'loading');
  h.api.disconnect();
  assert.equal((await pending).state, 'disconnected');
  assert.equal(h.api.health.snapshot().observation, null);
  assert.match(h.panels[0].webview.html, /Connect to a Spring runtime/);
});
