'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { managerOrigin, managerContext, parseList, createTomcatManager } = require('../src/java/jakarta-manager');

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
  } finally { service.dispose(); }
});
