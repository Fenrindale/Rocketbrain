'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { normalizeProfile, createConnectionProfiles } = require('../src/db/connection-profiles');
const { validEndpoint, mintRdsIamToken, validateToken, createRdsIamHandshake } = require('../src/db/rds-iam');
const { target } = require('./helpers/rds-iam-fixture');

const options = { ...target, database: 'app', name: 'RDS fixture', tls: { mode: 'verify', serverName: target.host,
  caPath: path.resolve('fixture-ca.pem') } };

test('RDS IAM profile validation binds direct TCP and verified TLS to the AWS endpoint and region', () => {
  assert.deepEqual(normalizeProfile(options).auth, target.auth);
  assert.equal(validEndpoint('cluster.cluster-xyz.cn-north-1.rds.amazonaws.com.cn', 'cn-north-1'), true);
  for (const host of ['127.0.0.1', 'elsewhere.example', `${target.host}.example`, 'db.proxy-x.us-east-1.rds.amazonaws.com']) {
    assert.throws(() => normalizeProfile({ ...options, host }), /actual AWS RDS/);
  }
  for (const tls of [{ mode: 'disabled' }, { ...options.tls, serverName: 'other.example' }, { ...options.tls, caPath: '' },
    { ...options.tls, certPath: path.resolve('c.pem'), keyPath: path.resolve('k.pem') }]) {
    assert.throws(() => normalizeProfile({ ...options, tls }));
  }
  for (const auth of [{ ...target.auth, region: 'us-west-2' }, { ...target.auth, source: 'profile', profile: '--debug' },
    { ...target.auth, accessKey: 'unused' }, { kind: 'aws-rds-iam', region: 'us-east-1' }]) {
    assert.throws(() => normalizeProfile({ ...options, auth }));
  }
});

test('RDS profile exports omit local credential selectors and import without auto-connecting', async () => {
  const values = new Map(), secrets = new Map();
  const manager = createConnectionProfiles({ state: { get: (key, fallback) => values.get(key) ?? fallback,
    async update(key, value) { values.set(key, value); } }, secrets: { get: async key => secrets.get(key),
    async store(key, value) { secrets.set(key, value); }, async delete(key) { secrets.delete(key); } },
  isTrusted: () => true, getActiveProfile: () => undefined, createService: () => { throw Error('Unexpected network'); } });
  try {
    const profile = { ...options, auth: { ...target.auth, source: 'profile', profile: 'fixture-profile' } };
    await assert.rejects(() => manager.save({ profile, verify: false, password: 'fixture-only' }), /uses AWS credentials/);
    await assert.rejects(() => manager.save({ profile, verify: false, rememberPassword: true }), /temporary tokens/);
    const saved = await manager.save({ profile, verify: false });
    assert.equal(saved.hasSavedPassword, false);
    assert.equal(secrets.size, 0);
    const portable = manager.exportProfiles();
    assert.equal(portable.version, 3);
    assert.deepEqual(portable.profiles[0].auth, { kind: 'aws-rds-iam', region: 'us-east-1' });
    assert.deepEqual(portable.profiles[0].tls, { mode: 'verify', serverName: target.host });
    await assert.rejects(() => manager.importProfiles({ ...portable, profiles: [{ ...portable.profiles[0], auth: profile.auth }] }));
    assert.deepEqual(await manager.importProfiles(portable), { imported: 1, connectionsAttempted: 0 });
    const imported = manager.list().find(item => item.id !== saved.id);
    await assert.rejects(() => manager.connect({ id: imported.id }), /local AWS credential source/);
  } finally { await manager.dispose(); }
});

test('token checks reject wrong endpoints, user scope, expiration and duplicate signed parameters', () => {
  const query = new URLSearchParams({ Action: 'connect', DBUser: target.user, 'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': 'fixture/20260720/us-east-1/rds-db/aws4_request', 'X-Amz-Date': '20260720T123456Z',
    'X-Amz-Expires': '900', 'X-Amz-SignedHeaders': 'host', 'X-Amz-Signature': 'a'.repeat(64) });
  const now = Date.parse('2026-07-20T12:34:56Z');
  const candidate = `${target.host}:${target.port}/?${query}`;
  assert.equal(validateToken(candidate, target, now), candidate);
  for (const invalid of [candidate + '&Action=connect', candidate.replace('rds-db', 'rds'), candidate.replace('900', '800'),
    candidate.replace(target.user, 'wrong_user'), candidate.replace('3306', '3307'), candidate.replace(target.host, 'wrong.example'), candidate + '#fragment']) {
    assert.throws(() => validateToken(invalid, target, now), /fresh token/);
  }
  assert.throws(() => validateToken(candidate, target, now + 121000));
});

test('the clear-password plugin leaves the initial password empty and refuses a plaintext transport before minting', async () => {
  let minted = false;
  const handshake = createRdsIamHandshake(target, async () => { minted = true; });
  assert.equal(handshake.options.password, '');
  await assert.rejects(() => handshake.options.authPlugins.mysql_clear_password({ connection: { stream: { encrypted: true,
    authorized: true, off() {} } } })(), /verified TLS/);
  assert.equal(handshake.sent(), false);
  assert.equal(minted, false);
  await assert.rejects(() => mintRdsIamToken(target, { environment: { AWS_ACCESS_KEY_ID: 'fixture' } }), /AWS_SECRET_ACCESS_KEY/);
});
