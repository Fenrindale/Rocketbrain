'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { test } = require('node:test');
const { ActuatorClient } = require('../src/spring/runtime-client');
const { registerRuntimeProperty, renderProperty } = require('../src/spring/runtime-property-vscode');

const key = 'fixture.message';
const approval = { key, approved: true };
const auth = 'Bearer locally-generated-fixture-token';
const source = 'systemEnvironment';
const origin = 'System Environment Property "FIXTURE_MESSAGE"';
function propertyDocument(value) {
  return { property: { source, value }, propertySources: [
    { name: 'commandLineArgs' }, { name: source, property: { value, origin } },
    { name: 'application.properties', property: { value: 'masked-shadow-value', origin: 'application.properties - 8:15' } }
  ] };
}

test('property requests use exact bounded GETs, validate debugger identity twice and preserve summary privacy', async () => {
  const requests = [];
  let document = propertyDocument('<resolved>'), processIds = [77, 77];
  const server = http.createServer((req, res) => {
    requests.push([req.method, req.url, req.headers.authorization]);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/actuator/info') return res.end(JSON.stringify({ process: { pid: processIds.shift() }, accidental: 'unrelated-info' }));
    if (req.url === '/actuator/env/' + key) return res.end(JSON.stringify(document));
    if (req.url === '/actuator/env') return res.end(JSON.stringify({ propertySources: [{ name: source, properties: { [key]: { value: 'private-inventory' } } }] }));
    if (req.url === '/actuator/env/redirect') { res.statusCode = 302; res.setHeader('Location','/unexpected'); }
    else res.statusCode = 404;
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = new ActuatorClient({ url: 'http://127.0.0.1:'+server.address().port+'/actuator', authorization: auth });
  try {
    const result = await client.property(key, { verifiedPid: 77 });
    assert.deepEqual(requests, [['GET','/actuator/info',auth],['GET','/actuator/env/'+key,auth],['GET','/actuator/info',auth]]);
    assert.deepEqual(result.display, { state:'visible', type:'string', value:'<resolved>' });
    assert.equal(result.origin, origin);
    assert.equal(result.debugProcessVerified, true);
    assert.deepEqual(result.sources.map(({ position, effective }) => [position, effective]), [[2,true],[3,false]]);
    assert.doesNotMatch(JSON.stringify(result), /masked-shadow-value|unrelated-info|locally-generated-fixture-token/);
    const html = renderProperty(result);
    assert.match(html, /&lt;resolved&gt;/);
    assert.doesNotMatch(html, /<resolved>|<script|masked-shadow-value/);
    assert.match(html, /default-src 'none'/);

    processIds = [78];
    const before = requests.length;
    await assert.rejects(() => client.property(key, { verifiedPid: 77 }), error => error.code === 'DEBUG_PROCESS_MISMATCH');
    assert.equal(requests.length, before + 1);
    processIds = [77, 78];
    await assert.rejects(() => client.property(key, { verifiedPid: 77 }), error => error.code === 'DEBUG_PROCESS_MISMATCH');
    assert.equal(requests.length, before + 4);
    for (const invalid of ['/env','..','fixture/../key','fixture.%2fkey','foo?bar','fixture#name','x'.repeat(201)])
      await assert.rejects(() => client.property(invalid), error => error.code === 'INVALID_PROPERTY_KEY');
    assert.equal(requests.length, before + 4);
    await assert.rejects(() => client.property('redirect'), error => error.code === 'REDIRECT_BLOCKED');
    await assert.rejects(() => client.property('missing'), error => error.code === 'NOT_EXPOSED');
    assert.equal(requests.some(([,path]) => path === '/unexpected'), false);

    for (const value of ['******','locally-generated-fixture-token','mysql://name:pass@host/']) {
      document = propertyDocument(value);
      assert.deepEqual((await client.property(key)).display, { state:'redacted' });
    }
    document = propertyDocument({ nested:'opaque' });
    assert.deepEqual((await client.property(key)).display, { state:'unavailable' });
    document = propertyDocument('z'.repeat(70000));
    await assert.rejects(() => client.property(key), error => error.code === 'RESPONSE_TOO_LARGE');
    await client.refresh();
    assert.doesNotMatch(JSON.stringify(client.snapshot()), /private-inventory|unrelated-info|locally-generated-fixture-token/);
  } finally { client.dispose(); await new Promise(resolve => server.close(resolve)); }
});

test('property panel requires review, is tied to the debugger session and closes on stale connection', async () => {
  const callbacks = {}, changes = [], session = { id: 'owned-a', type: 'rocketbrain-java' };
  const active = { activeDebugSession: session,
    onDidChangeActiveDebugSession(callback) { callbacks.active = callback; return { dispose() {} }; },
    onDidTerminateDebugSession(callback) { callbacks.ended = callback; return { dispose() {} }; } };
  let reviewed, panel, unblock;
  let client = { snapshot: () => ({ baseUrl:'http://127.0.0.1:1234/actuator' }),
    async property(chosenKey, options) {
      options.assertCurrent();
      changes.push({ chosenKey, pid: options.verifiedPid });
      if (unblock) await new Promise(resolve => { unblock = resolve; });
      options.assertCurrent();
      return { key:chosenKey, source, origin, display:{state:'redacted'}, sources:[], observedAt:'2026-11-26T01:00:00Z', debugProcessVerified:!!options.verifiedPid };
    } };
  const vscode = { debug: active, ViewColumn:{ Beside:2 }, window: {
    async showInputBox() { return key; },
    async showWarningMessage(message, options) { assert.match(options.detail, /fixture\.message/); return reviewed ? 'Inspect' : undefined; },
    createWebviewPanel(_id, _title, _side, options) {
      assert.deepEqual(options, { enableScripts:false, localResourceRoots:[], enableCommandUris:false });
      panel = { webview:{}, reveal() {}, onDidDispose(callback) { this.callback=callback; }, dispose() { this.callback(); panel=undefined; } };
      return panel;
    }
  } };
  const ui = registerRuntimeProperty(vscode, { getClient:() => client, assertTrusted() {},
    verifiedLocalPid:current => current===session ? 77 : undefined,
    onConnectionChange(callback) { callbacks.connect = callback; return { dispose() {} }; } });
  try {
    await assert.rejects(() => ui.open(true,{key}), error => error.code === 'REVIEW_REQUIRED');
    await ui.open(true);
    assert.equal(changes.length,0);
    reviewed = true;
    const value = await ui.open(true);
    assert.equal(value.view,'rocketbrain.spring.propertyOrigin');
    assert.match(panel.webview.html,/Verified active local Java debug target|Value redacted/);
    assert.deepEqual(changes[0],{ chosenKey:key, pid:77 });

    unblock = true;
    const stale = ui.open(true,approval);
    active.activeDebugSession = { id:'other', type:'rocketbrain-java' };
    callbacks.active(active.activeDebugSession);
    assert.equal(panel,undefined);
    unblock(); unblock = undefined;
    await assert.rejects(stale, error => error.code === 'STALE_PROPERTY');
    await assert.rejects(() => ui.open(true,approval), error => error.code === 'UNVERIFIED_DEBUG_TARGET');
    await ui.open(false,approval);
    assert.match(panel.webview.html,/Selected loopback Spring runtime/);
    client = null; callbacks.connect();
    assert.equal(panel,undefined);
  } finally { ui.dispose(); }
});
