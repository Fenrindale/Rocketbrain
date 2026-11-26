'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { inspectMongoTlsCa, mongoTarget } = require('../src/db/mongodb');

test('MongoDB verified TLS accepts one explicit endpoint with a reviewed local CA', async () => {
  const base = { username: 'fixture', password: 'ephemeral', port: 27017 };
  const tls = { caPath: path.resolve('ca.pem'), caSha256: 'a'.repeat(64) };
  for (const host of ['db.example.test', 'localhost', '192.0.2.42', '2001:db8::1']) {
    assert.deepEqual(mongoTarget({ ...base, host, tls }).tls, tls);
  }
  for (const host of ['mongo://example', 'db1,db2', '127.0.0.1?tls=false', '[::1]', 'host:27017', 'key@db.test', '::1%scope']) {
    assert.throws(() => mongoTarget({ ...base, host, tls }), /DNS name or IP/);
  }
  assert.throws(() => mongoTarget({ ...base, host: 'db.example.test' }), /numeric loopback/);
  assert.throws(() => mongoTarget({ ...base, host: 'db.example.test', tls: { ...tls, allowInvalidHostnames: true } }), /review/i);
  assert.throws(() => mongoTarget({ ...base, host: 'db.example.test', tls: { caPath: tls.caPath } }), /review/i);
  await assert.rejects(() => inspectMongoTlsCa('ca.pem'), { code: 'ROCKETBRAIN_MONGO_TLS_CA' });
});
