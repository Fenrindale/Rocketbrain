'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { ActuatorClient, validateRuntimeUrl, normalizeEndpoint, compareRuntime } = require('../src/spring/runtime-client');

async function server(t, handle) { const instance = http.createServer(handle); await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => { instance.closeAllConnections(); instance.close(resolve); })); return `http://127.0.0.1:${instance.address().port}/actuator`; }
function payloads(secret = 'should-never-be-retained') {
  return {
    beans: { contexts: { application: { parentId: null, beans: { dynamicBean: { aliases: ['dynamicAlias'], type: 'demo.RuntimeProduct$$SpringCGLIB$$0', scope: 'singleton', dependencies: ['factory'] } } } } },
    conditions: { contexts: { application: { positiveMatches: { 'demo.DynamicConfig#enabled': [{ condition: 'demo.CustomCondition', message: `matched password=${secret}` }] }, negativeMatches: { 'demo.Disabled': { notMatched: [{ condition: 'OnPropertyCondition', message: `secret=${secret}` }], matched: [] } } } } },
    configprops: { contexts: { application: { beans: { settings: { prefix: 'demo', properties: { password: secret, nested: { apiToken: secret } }, inputs: { password: { value: secret, origin: secret } } } } } } },
    env: { activeProfiles: ['dev'], defaultProfiles: ['default'], propertySources: [{ name: 'fixture', properties: { 'demo.password': { value: secret, origin: secret }, 'demo.token': { value: secret } } }] },
    mappings: { contexts: { application: { mappings: { dispatcherServlets: { dispatcherServlet: [{ predicate: `GET /demo?token=${secret}`, details: { handlerMethod: { className: 'demo.Controller', name: 'demo' }, requestMappingConditions: { methods: ['GET'], patterns: ['/demo'], params: [{ name: 'token', value: secret }] } } }] } } } } }
  };
}

test('Actuator URL only permits explicit loopback HTTP(S) and rejects credential/query/remote URLs', () => {
  assert.equal(validateRuntimeUrl('http://localhost:8080/actuator').address, '127.0.0.1');
  assert.equal(validateRuntimeUrl('http://[::1]:8080/actuator').address, '::1');
  for (const url of ['https://example.com/actuator', 'http://127.0.0.1@evil.test/actuator', 'http://user:password@localhost/actuator', 'http://localhost/actuator?token=secret', 'file:///actuator', 'http://localhost:0/actuator', 'http://localhost/actuator#x']) assert.throws(() => validateRuntimeUrl(url));
});

test('loopback GET observer retains only sanitized metadata for all five endpoints', async t => {
  const token = 'highly-private-bearer-token', data = payloads(token), calls = [];
  data.beans.contexts.application.beans[token] = { type: token, dependencies: [] };
  const url = await server(t, (request, response) => { calls.push({ method: request.method, path: request.url }); assert.equal(request.headers.authorization, `Bearer ${token}`); response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(data[request.url.split('/').at(-1)])); });
  const client = new ActuatorClient({ url: url.replace('127.0.0.1', 'localhost'), authorization: `Bearer ${token}` }); t.after(() => client.dispose());
  const snapshot = await client.refresh();
  assert.equal(snapshot.state, 'connected'); assert.equal(calls.length, 5); assert.ok(calls.every(call => call.method === 'GET'));
  assert.equal(snapshot.counts.beans, 2); assert.equal(snapshot.conditions[0].matched, true);
  assert.deepEqual(snapshot.configurationProperties[0].keys, ['password', 'nested.apiToken']);
  assert.deepEqual(snapshot.environment.sources[0].keys, ['demo.password', 'demo.token']);
  assert.deepEqual(snapshot.mappings[0].paths, ['/demo']);
  const serialized = JSON.stringify(snapshot); assert.equal(serialized.includes(token), false); assert.equal(snapshot.conditions.some(item => Object.hasOwn(item, 'message')), false); assert.equal(snapshot.configurationProperties.some(item => Object.hasOwn(item, 'inputs') || Object.hasOwn(item, 'properties')), false); assert.equal(snapshot.mappings.some(item => Object.hasOwn(item, 'predicate')), false);
  assert.equal(JSON.stringify(client).includes(token), false);
  snapshot.contexts.length = 0; assert.equal(client.snapshot().contexts.length, 1, 'Callers cannot mutate internal observations');
});

test('redirects never forward credentials and unavailable endpoints remain partial/unknown', async t => {
  let redirected = false;
  const url = await server(t, (request, response) => { if (request.url === '/target') { redirected = true; response.end('{}'); return; } if (request.url.endsWith('/beans')) { response.writeHead(302, { Location: '/target' }); response.end(); } else if (request.url.endsWith('/env')) { response.writeHead(401); response.end('private-body'); } else { response.writeHead(404); response.end('not exposed'); } });
  const client = new ActuatorClient({ url, authorization: 'Basic ' + Buffer.from('dev:private-password').toString('base64') }); t.after(() => client.dispose());
  const snapshot = await client.refresh(); assert.equal(snapshot.state, 'error'); assert.equal(snapshot.endpoints.beans.code, 'REDIRECT_BLOCKED'); assert.equal(snapshot.endpoints.env.code, 'AUTH_REQUIRED'); assert.equal(redirected, false);
  assert.equal(JSON.stringify(snapshot).includes('private'), false);
  const compared = compareRuntime({ beans: [{ id: 'local', name: 'bean', type: 'demo.Bean', state: 'unknown', aliases: [], uri: 'file:///Bean.java', range: {} }] }, snapshot);
  assert.equal(compared.beans[0].observation, 'unknown');
});

test('timeouts, byte limits and malformed JSON/schema fail without retaining response bodies', async t => {
  const secret = 'untrusted-response-secret';
  const url = await server(t, (request, response) => {
    const endpoint = request.url.split('/').at(-1);
    if (endpoint === 'beans') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.write(' '.repeat(1300)); response.end(); }
    else if (endpoint === 'conditions') { response.end(`{malformed-${secret}`); }
    else if (endpoint === 'configprops') response.end('{}');
    else if (endpoint === 'env') { /* Deliberately no response until the client timeout. */ }
    else response.end(JSON.stringify(payloads().mappings));
  });
  const client = new ActuatorClient({ url, timeoutMs: 150, maxResponseBytes: 1024 }); t.after(() => client.dispose());
  const snapshot = await client.refresh(); assert.equal(snapshot.state, 'partial');
  assert.equal(snapshot.endpoints.beans.code, 'RESPONSE_TOO_LARGE'); assert.equal(snapshot.endpoints.conditions.code, 'INVALID_JSON'); assert.equal(snapshot.endpoints.configprops.code, 'INVALID_SCHEMA'); assert.equal(snapshot.endpoints.env.code, 'TIMEOUT');
  assert.equal(JSON.stringify(snapshot).includes(secret), false);
});

test('runtime enrichment preserves static unknowns and distinguishes runtime-only, absent and proxy observations', () => {
  const snapshot = { state: 'connected', fetchedAt: 'now', endpoints: { beans: { state: 'available' } }, contexts: normalizeEndpoint('beans', payloads().beans) };
  const model = { revision: 3, beans: [{ id: 'static-1', name: 'dynamicBean', aliases: [], type: 'demo.Product', state: 'unknown', uri: 'file:///Config.java', range: {} }, { id: 'static-2', name: 'notVisible', aliases: [], type: 'demo.Other', state: 'active', uri: 'file:///Other.java', range: {} }] };
  const comparison = compareRuntime(model, snapshot);
  assert.equal(comparison.beans[0].staticState, 'unknown'); assert.equal(comparison.beans[0].observation, 'present'); assert.match(comparison.beans[0].runtime[0].type, /SpringCGLIB/);
  assert.equal(comparison.beans[1].observation, 'not-observed'); assert.equal(model.beans[0].state, 'unknown');
  const runtimeOnly = compareRuntime({ beans: [] }, snapshot); assert.equal(runtimeOnly.beans[0].observation, 'runtime-only');
});

test('Actuator Health observes status, bounded contributor trees and advertised groups without retaining details', () => {
  const detail = 'driver-connection-string-or-health-secret';
  const value = normalizeEndpoint('health', { status: 'DOWN', groups: ['readiness', 'liveness', 'readiness'], components: {
    db: { status: 'DOWN', components: { primary: { status: 'OUT_OF_SERVICE', details: { trace: detail } } } },
    mistyped: { status: 503 },
    ...Object.fromEntries(Array.from({ length: 300 }, (_, index) => ['contributor' + index, { status: 'UP' }]))
  } });
  assert.equal(value.status, 'DOWN');
  assert.deepEqual(value.groups.map(group => group.segment), ['readiness', 'liveness']);
  assert.equal(value.visibility, 'components');
  assert.equal(value.components.length, 255);
  assert.equal(value.components[0].components[0].status, 'OUT_OF_SERVICE');
  assert.equal(value.limited, true);
  assert.equal(value.detailsRetained, false);
  assert.equal(JSON.stringify(value).includes(detail), false);
  assert.equal(normalizeEndpoint('health', { status: 'UNKNOWN' }).visibility, 'status-only');
  assert.equal(normalizeEndpoint('health', { status: 'UNKNOWN', components: {} }).visibility, 'components');
  assert.throws(() => normalizeEndpoint('health', { status: 503 }), /aggregate status/);
});

test('Actuator Health treats JSON HTTP 503 as observed and refuses access, redirects and unsafe drill-down paths', async t => {
  const token = 'health-private-token-0101', calls = [];
  const url = await server(t, (request, response) => {
    calls.push({ method: request.method, path: request.url });
    assert.equal(request.headers.authorization, 'Bearer ' + token);
    const path = request.url;
    if (path.endsWith('/private')) { response.writeHead(403); response.end(token); return; }
    if (path.endsWith('/moved')) { response.writeHead(302, { Location: '/other' }); response.end(); return; }
    if (path.endsWith('/not-exposed')) { response.writeHead(404); response.end(); return; }
    if (path.endsWith('/error-page')) { response.writeHead(503); response.end('{"status":503,"error":"Gateway trouble"}'); return; }
    if (path.endsWith('/large')) { response.writeHead(200); response.end(' '.repeat(2048)); return; }
    response.writeHead(path.endsWith('/readiness') ? 503 : 200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ status: path.endsWith('/readiness') ? 'OUT_OF_SERVICE' : 'UP', groups: ['readiness', token, '../wrong'],
      components: { [token]: { status: 'UP', details: { jdbc: token } } } }));
  });
  const client = new ActuatorClient({ url, authorization: 'Bearer ' + token, maxResponseBytes: 1024 });
  t.after(() => client.dispose());
  const root = await client.health();
  assert.equal(root.httpStatus, 200);
  assert.equal(root.status, 'UP');
  assert.deepEqual(root.groups.map(group => group.segment), ['readiness', null, null]);
  assert.equal(JSON.stringify(root).includes(token), false);
  assert.equal(root.components[0].segment, null);
  const readiness = await client.health(['readiness']);
  assert.equal(readiness.status, 'OUT_OF_SERVICE');
  assert.equal(readiness.httpStatus, 503);
  await assert.rejects(client.health(['private']), { code: 'AUTH_REQUIRED', status: 403 });
  await assert.rejects(client.health(['moved']), { code: 'REDIRECT_BLOCKED', status: 302 });
  await assert.rejects(client.health(['not-exposed']), { code: 'NOT_EXPOSED', status: 404 });
  await assert.rejects(client.health(['error-page']), { code: 'INVALID_SCHEMA', status: 503 });
  await assert.rejects(client.health(['large']), { code: 'RESPONSE_TOO_LARGE' });
  const before = calls.length;
  for (const path of [['../beans'], ['/env'], ['..'], ['a?query=b'], Array(9).fill('x'), new Array(1)]) {
    await assert.rejects(client.health(path), { code: 'INVALID_HEALTH_PATH' });
  }
  assert.equal(calls.length, before);
  assert.ok(calls.every(call => call.path.startsWith('/actuator/health') && call.method === 'GET'));
});
