'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { managerOrigin, managerContext, parseList, createTomcatManager } = require('../src/java/jakarta-manager');
const { createManagerHistory } = require('../src/java/jakarta-manager-history');

test('Manager targets one explicit HTTPS origin and one ordinary application context', () => {
  assert.equal(managerOrigin('https://example.test:8443/'), 'https://example.test:8443');
  for (const value of ['http://example.test', 'https://user@example.test', 'https://example.test/manager/text',
    'https://example.test/?a=1', 'https://example.test/#fragment', ' https://example.test']) {
    assert.throws(() => managerOrigin(value), /exact HTTPS origin/u);
  }
  assert.equal(managerContext('orders'), '/orders');
  for (const value of ['/', '/manager', '/host-manager', '/foo/bar', '/foo##1', '/foo%2Fbar', '/foo?update=true']) {
    assert.throws(() => managerContext(value), /one named Tomcat/u);
  }
});

test('Manager list parses stock protocol state and keeps colon-containing document bases private', () => {
  const heading = 'OK - Listed applications for virtual host [localhost]';
  const values = parseList(heading + '\r\n/manager:running:0:manager\r\n/orders:stopped:12:C:\\app\\orders.war\r\n');
  assert.deepEqual(values[1], { context: '/orders', state: 'stopped', sessions: 12, location: 'C:\\app\\orders.war' });
  assert.throws(() => parseList('FAIL - Manager command rejected'), /bounded application list/u);
  assert.throws(() => parseList('OK - Backend welcome page'), /bounded application list/u);
  assert.throws(() => parseList(heading + '\n/orders:unknown:0:orders'), /unsupported application list/u);
  assert.throws(() => parseList(heading + '\n/orders:running:0:\u0000'), /unsupported application list/u);
});

test('Manager refuses unapproved access and cancelled execution before contacting a server', async () => {
  const service = createTomcatManager();
  try {
    await assert.rejects(service.observe({ origin: 'https://example.test' }), /Explicitly approve/u);
    await assert.rejects(service.execute({ reviewId: 'arbitrary', allowExecute: true, cancellation: AbortSignal.abort() }),
      /operation was cancelled/u);
    await assert.rejects(service.execute({ reviewId: 'arbitrary', allowExecute: true }), /Review the current/u);
  } finally { await service.dispose(); }
});

test('tracked history binds live doc bases, host, account and local archive owners', async () => {
  const history = createManagerHistory(), context = '/orders';
  const input = { action: 'track-deploy', origin: 'https://example.test', context, username: 'operator',
    certificateSha256: 'certificate', caSha256: 'authority', virtualHost: 'localhost' };
  const observed = { virtualHost: 'localhost', applications: [] };
  const first = history.inspect(input, observed.applications);
  const version = 'rb001-' + 'a'.repeat(32), nextVersion = 'rb002-' + 'b'.repeat(32);
  const row = { context, state: 'running', sessions: 0, location: 'orders##' + version };
  const secondObservation = { ...observed, applications: [row] };
  let released = 0;
  try {
    history.beforeUpload(first, observed);
    assert.equal(history.confirm(first, version, secondObservation, 'digest',
      () => ({ artifact: { name: 'orders.war', size: 64 }, release: async () => { released++; } })), row);
    assert.throws(() => history.beforeUpload(first, observed), /live Tomcat versions changed/u);
    const update = history.inspect({ ...input, action: 'track-update' }, secondObservation.applications);
    assert.equal(update.current.sha256, 'digest');
    assert.equal(update.current.location, row.location);
    assert.throws(() => history.inspect({ ...input, action: 'track-update', username: 'other' }, [row]),
      /same endpoint, account and certificate/u);
    assert.throws(() => history.beforeUpload(update, { ...secondObservation, virtualHost: 'other' }), /live Tomcat versions changed/u);
    assert.throws(() => history.beforeUpload(update, { ...observed, applications: [{ ...row, location: row.location + '.war' }] }),
      /live Tomcat versions changed/u);
    history.beforeUpload(update, { ...observed, applications: [{ ...row, sessions: 3 }] });
    assert.equal(history.confirm(update, nextVersion, secondObservation, 'other digest', () => assert.fail('premature retention')), undefined);
    history.invalidate(update);
    assert.throws(() => history.inspect({ ...input, action: 'restore' }, [row]), /context tracked by this Tomcat Manager session/u);
  } finally { await history.dispose(); }
  assert.equal(released, 1);
});
