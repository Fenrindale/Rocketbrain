'use strict';

const assert = require('node:assert/strict');
const {test} = require('node:test');
const path = require('node:path');
const net = require('node:net');
const {createHash} = require('node:crypto');
const {spawnSync} = require('node:child_process');
const mysql = require('mysql2');
const {
  format, approval, options, parseFixture, verifyCloudFixture, expiresAt, expectWireFailure
} = require('../scripts/verify-cloud-mysql-auth');
const {setupWireTlsFixture, mysqlIamEndpoint} = require('./helpers/rds-iam-fixture');

const start = Date.parse('2026-11-18T00:00:00Z');
const future = '2026-11-18T00:17:00Z';
const fixture = {
  format, approval, host: 'owned-cloud.fixture7.us-east-1.rds.amazonaws.com', user: 'rb_proof', port: 3306, database: 'rb_fixture',
  auth: {kind: 'aws-rds-iam', region: 'us-east-1', source: 'profile', profile: 'rb-test-fixture'},
  caPath: path.resolve('positive.pem'), wrongCaPath: path.resolve('negative.pem'),
  nonce: 'abcdef0123456789abcdef0123456789'
};
const fixtureFile = path.resolve('prepared fixture.json');

function signedAt(time) {
  const date = new Date(time).toISOString().replace(/[:-]|\.\d{3}/gu, '');
  const args = new URLSearchParams({Action: 'connect', DBUser: fixture.user, 'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': 'example/' + date.slice(0, 8) + '/us-east-1/rds-db/aws4_request', 'X-Amz-Date': date,
    'X-Amz-Expires': '900', 'X-Amz-SignedHeaders': 'host', 'X-Amz-Signature': 'a'.repeat(64)});
  return fixture.host + ':3306/?' + args;
}

test('cloud verifier refuses missing consent, nonliteral input and a slow check without an exact future deadline', () => {
  assert.equal(options(['--fixture', fixtureFile], start).requested, false);
  assert.equal(options(['--fixture', fixtureFile, '--with-rds-expiry', '--deadline', future], start).deadline, start + 17 * 60000);
  for (const flags of [['--with-rds-expiry'], ['--deadline', future], ['--with-rds-expiry', '--deadline', '2026-11-18T00:50:00Z'],
    ['--with-rds-expiry', '--deadline', '2026-11-18T00:10:00Z'], ['--password','fixture'], ['--sql', 'SELECT 1'], ['--fixture', fixtureFile]]) {
    assert.throws(() => options(['--fixture', fixtureFile, ...flags], start), /expiry-approval|usage/u);
  }
  for (const fields of [{approval: 'read-only'}, {host: '127.0.0.1'}, {host: 'another.fake.example'},
    {password: 'fixture'}, {ssh: {}}, {caPath: 'relative.pem'}, {auth: {...fixture.auth, source: 'environment'}},
    {auth: {...fixture.auth, token: 'fixture-only'}}, {provider: 'alternate'}]) {
    assert.throws(() => parseFixture({...fixture, ...fields}, () => {throw Error('unexpected-file-read');}),
      error => error.message !== 'unexpected-file-read');
  }
  const negative = spawnSync(process.execPath, ['scripts/verify-cloud-mysql-auth.js', '--fixture',
    path.resolve('not-present-cloud-owner-id.json')], {encoding: 'utf8', windowsHide: true});
  assert.equal(negative.status, 2);
  assert.deepEqual(JSON.parse(negative.stdout), {outcome: 'unverified', stage: 'fixture-path'});
  assert.equal(negative.stderr, '');
  assert.equal(expiresAt(signedAt(start), fixture, start), start + 900000);
});

function pretendService(record, dependencies, seen) {
  const {profile, nonce} = record;
  const state = id => ({connected: true, readOnly: true, connectionId: id});
  if (!dependencies) return {
    async metadata() {return {database: profile.database, tables: [], views: []};},
    async _metadataQuery(sql) {
      if (sql.startsWith('SELECT VERSION()')) return {rows: [['8.4.test', profile.database, profile.user + '@%']]};
      if (sql.includes('Ssl_cipher')) return {rows: [['Ssl_cipher', 'TLS_FAKE']]};
      if (sql.includes('information_schema.SCHEMATA')) return {rows: [[profile.database]]};
      assert.fail('Unexpected profile statement');
    },
    serverTlsEvidence: () => ({protocol: 'TLSv1.3', hostname: profile.host,
      caMaterialSha256: createHash('sha256').update(record.ca).digest('hex')}),
    async dispose() {}
  };
  let id = 122;
  const acquire = dependencies.mintIamToken || dependencies.mintAzureToken;
  return {
    async openSession(_, {readOnly}) {
      assert.equal(readOnly, true);
      await acquire(profile, {});
      seen.push('open');
      return state(id);
    },
    async query(sql, options) {
      assert.equal(sql, 'SELECT CURRENT_USER(), DATABASE(), CONNECTION_ID(), nonce FROM rocketbrain_live_auth_proof WHERE fixture_id = 1 LIMIT 2');
      assert.deepEqual(options, {maxRows: 2, timeoutMs: 10000});
      seen.push('read');
      return {rows: [[profile.user + '@%', profile.database, String(id), nonce]]};
    },
    async reconnect() {
      await acquire(profile, {});
      seen.push('reconnect');
      return state(++id);
    },
    async dispose() {seen.push('disposed');}
  };
}

test('owned synthetic workflow proves explicit deadlines, exact written profile, denied token timing and masked receipts', {
  skip: process.env.ROCKETBRAIN_CLOUD_AUTH_LOCAL_TEST !== '1'
}, async t => {
  const tls = await setupWireTlsFixture(fixture.host);
  t.after(() => tls.close());
  const record = parseFixture({...fixture, caPath: tls.caPath, wrongCaPath: path.join(tls.folder, 'wrong-ca.pem')});
  assert.throws(() => parseFixture({...fixture, caPath: tls.caPath, wrongCaPath: tls.caPath}), /fixture-trust/u);
  for (const requested of [false, true]) {
    let now = start;
    const receipt = [];
    const proof = await verifyCloudFixture(record, {requested, deadline: start + 17 * 60000}, {
      serviceFactory: (config, deps) => {
        assert.equal(config.host, fixture.host);
        assert.equal(config.readOnly, true);
        assert.equal(config.password, '');
        assert.equal(config.ssl.verifyIdentity, true);
        assert.equal(config.ssl.ca, tls.ca);
        return pretendService(record, deps, receipt);
      },
      rds: async target => {
        assert.equal(target.auth.profile, fixture.auth.profile);
        return signedAt(now);
      },
      async wire(config, wrong, expired, signal) {
        assert.equal(signal.aborted, false);
        assert.equal(config.user, fixture.user);
        if (wrong) {
          assert.equal(wrong, tls.wrongCa);
          assert.equal(expired, undefined);
          receipt.push('wrong-root');
        } else {
          assert.equal(expired.value, signedAt(start));
          assert.equal(expired.allowedAfter, start + 905000);
          assert.ok(now >= expired.allowedAfter);
          receipt.push('expired');
        }
      },
      now: () => now,
      async wait(duration) {
        assert.equal(duration, 905000);
        now += duration;
      }
    });
    assert.deepEqual(receipt, ['open', 'read', 'wrong-root', ...(requested ? ['expired'] : []), 'reconnect', 'read', 'disposed']);
    assert.equal(proof.expiredRdsTokenRejected, requested ? true : 'not-requested');
    assert.equal(proof.credentialAcquisitionPerConnection, true);
    for (const identifier of [fixture.host, fixture.user, fixture.database, fixture.nonce, fixture.auth.profile, signedAt(start)]) {
      assert.ok(!JSON.stringify(proof).includes(identifier));
    }
  }
  const azureRecord = parseFixture({...fixture, host: 'owned-cloud.mysql.database.azure.com',
    caPath: tls.caPath, wrongCaPath: path.join(tls.folder, 'wrong-ca.pem'),
    auth: {kind: 'azure-mysql-entra', account: 'owned-fixture@example.invalid',
      tenant: 'aaaaaaaa-1111-4444-8000-123456789012', subscription: 'bbbbbbbb-1111-4444-8000-123456789012'}
  });
  await assert.rejects(verifyCloudFixture(azureRecord, {requested: true}), /expiry-approval/u);
  const cachedResponse = {accessToken: 'synthetic-same-unexpired-cache-value'};
  let azureCalls = 0;
  const azureProof = await verifyCloudFixture(azureRecord, {requested: false, deadline: start + 120000}, {
    serviceFactory: (_config, dependencies) => pretendService(azureRecord, dependencies, []),
    async azure(target) {
      assert.equal(target.auth.account, azureRecord.profile.auth.account);
      azureCalls++;
      return cachedResponse;
    },
    async wire() {},
    now: () => start
  });
  assert.equal(azureCalls, 2);
  assert.equal(azureProof.provider, 'azure-mysql-entra');
  assert.equal(azureProof.expiredRdsTokenRejected, 'not-requested');
  assert.ok(!JSON.stringify(azureProof).includes(cachedResponse.accessToken));
});

test('local real TLS wrong-root branch rejects before any mock service token or command', {
  skip: process.env.ROCKETBRAIN_CLOUD_AUTH_LOCAL_TEST !== '1'
}, async () => {
  const tls = await setupWireTlsFixture(fixture.host);
  let server;
  try {
    server = await mysqlIamEndpoint(tls, {databaseUser: fixture.user});
    const config = {host: fixture.host, port: fixture.port, user: fixture.user, database: fixture.database,
      ssl: {ca: tls.ca, serverName: fixture.host}};
    const signal = new AbortController().signal;
    const create = options => mysql.createConnection({...options, stream: () => net.connect(server.port, '127.0.0.1')});
    await expectWireFailure(config, tls.wrongCa, undefined, signal, create);
    assert.equal(server.state.receivedTokens, 0);
    assert.deepEqual(server.state.commands, []);
  } finally {
    try {await server?.close();}
    finally {await tls.close();}
  }
});

test('local real TLS expired-token control requires a verified peer and the vendor-style refusal code', {
  skip: process.env.ROCKETBRAIN_CLOUD_AUTH_LOCAL_TEST !== '1'
}, async () => {
  const tls = await setupWireTlsFixture(fixture.host);
  let server;
  try {
    const clock = Date.now(), received = signedAt(clock - 906000);
    server = await mysqlIamEndpoint(tls, {databaseUser: fixture.user, rejectToken: true,
      verify(token) {assert.equal(token, received);}});
    const config = {host: fixture.host, port: fixture.port, user: fixture.user, database: fixture.database,
      ssl: {ca: tls.ca, serverName: fixture.host}};
    const signal = new AbortController().signal;
    const create = options => mysql.createConnection({...options, stream: () => net.connect(server.port, '127.0.0.1')});
    await expectWireFailure(config, undefined, {value: received, allowedAfter: clock - 1000}, signal, create);
    assert.equal(server.state.receivedTokens, 1);
    assert.equal(server.state.accepted, 0);
    assert.deepEqual(server.state.commands, []);
    await assert.rejects(expectWireFailure(config, undefined,
      {value: received, allowedAfter: clock + 120000}, signal, create), /live-expired-token|wire-guard/u);
    assert.equal(server.state.receivedTokens, 1);
  } finally {
    try {await server?.close();}
    finally {await tls.close();}
  }
});
