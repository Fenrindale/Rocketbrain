'use strict';

const assert = require('node:assert/strict');
const { createHash, createHmac, randomUUID } = require('node:crypto');
const net = require('node:net');
const { setTimeout: wait } = require('node:timers/promises');
const mysql = require('mysql2');
const { MysqlService } = require('../src/db/mysql');
const { mintRdsIamToken, validateToken } = require('../src/db/rds-iam');
const { target, access, key, token, setupIamFixture, mysqlIamEndpoint } = require('./helpers/rds-iam-fixture');

const encode = value => encodeURIComponent(value).replace(/[!'()*]/g, character =>
  '%' + character.charCodeAt(0).toString(16).toUpperCase());
const hash = value => createHash('sha256').update(value).digest('hex');
const hmac = (secret, input) => createHmac('sha256', secret).update(input).digest();

function verifyOfflineSignature(signed) {
  validateToken(signed, target);
  const params = new URL('https://' + signed).searchParams;
  const signature = params.get('X-Amz-Signature');
  const stamp = params.get('X-Amz-Date');
  assert.equal(params.get('X-Amz-Security-Token'), token);
  assert.equal(params.get('X-Amz-Credential').split('/')[0], access);
  params.delete('X-Amz-Signature');
  const query = [...params].map(([name, value]) => encode(name) + '=' + encode(value)).sort().join('&');
  const canonical = ['GET', '/', query, `host:${target.host}:${target.port}\n`, 'host', hash('')].join('\n');
  const parts = [stamp.slice(0, 8), target.auth.region, 'rds-db', 'aws4_request'];
  const scope = parts.join('/');
  const signatureKey = parts.reduce((seed, part) => hmac(seed, part), Buffer.from('AWS4' + key));
  const calculated = hmac(signatureKey, ['AWS4-HMAC-SHA256', stamp, scope, hash(canonical)].join('\n')).toString('hex');
  assert.ok(calculated === signature, 'Official AWS CLI signature differs from independent SigV4 verification.');
}

async function verifyRdsIam(credentials) {
  const minted = await mintRdsIamToken(target, { environment: credentials.env });
  verifyOfflineSignature(minted);
  const named = { ...target, auth: { ...target.auth, source: 'profile', profile: 'fixture-rds' } };
  verifyOfflineSignature(await mintRdsIamToken(named, { environment: { ...credentials.env, AWS_ACCESS_KEY_ID: 'IGNORED-ENV-KEY',
    AWS_SECRET_ACCESS_KEY: 'ignored-profile-selection-value', AWS_SESSION_TOKEN: 'ignored-profile-session' } }));

  let calls = 0;
  const all = [];
  function service(endpoint, config = {}) {
    const db = new MysqlService({ ...target, database: 'rocketbrain_fixture', ssl: { ca: credentials.ca, serverName: target.host }, ...config }, {
      createConnection: options => mysql.createConnection({ ...options, stream: () => net.connect(endpoint.port, '127.0.0.1') }),
      mintIamToken: async (request, options) => {
        calls++;
        return mintRdsIamToken(request, { ...options, environment: credentials.env });
      }
    });
    all.push(db);
    return db;
  }
  const offered = [];
  const fixture = await mysqlIamEndpoint(credentials, { verify: value => { verifyOfflineSignature(value); offered.push(value); } });
  const plain = await mysqlIamEndpoint(credentials, { secure: false });
  const fallback = await mysqlIamEndpoint(credentials, { requestToken: false });
  try {
    const db = service(fixture);
    const first = await db.openSession('default');
    assert.equal(first.connected, true);
    assert.equal(first.readOnly, true);
    assert.equal(calls, 1);
    await wait(1100);
    const next = await db.reconnect('default');
    assert.equal(next.connected, true);
    assert.notEqual(next.connectionId, first.connectionId);
    assert.equal(calls, 2);
    assert.equal(fixture.state.initialEmpty, 2);
    assert.equal(fixture.state.receivedTokens, 2);
    assert.equal(fixture.state.accepted, 2);
    assert.ok(offered[0] !== offered[1], 'Reconnect did not produce a newer authentication token.');
    assert.deepEqual(fixture.state.commands, ['SET SESSION TRANSACTION READ ONLY', 'DO 0', 'SET SESSION TRANSACTION READ ONLY', 'DO 0']);

    const wrongHost = 'wrong-db.rbtest123456.us-east-1.rds.amazonaws.com';
    const wrongIdentity = service(fixture, { host: wrongHost, ssl: { ca: credentials.ca, serverName: wrongHost } });
    const badCa = service(fixture, { ssl: { ca: credentials.wrongCa, serverName: target.host } });
    for (const invalid of [wrongIdentity, badCa, service(plain)]) {
      await assert.rejects(() => invalid.openSession('default'), error => !error.message.includes(key) && !error.message.includes(token));
    }
    await assert.rejects(() => service(fallback).openSession('default'), /did not authenticate.*RDS IAM/);
    assert.equal(fallback.state.initialEmpty, 1);
    assert.deepEqual(fallback.state.commands, []);
    assert.equal(calls, 2);
    assert.equal(fixture.state.receivedTokens, 2);
    assert.equal(plain.state.receivedTokens, 0);
    return { officialCli: true, offlineSigV4: true, namedProfile: true, verifiedTlsAuthSwitch: true, freshReconnect: true,
      missingTlsRejected: true, wrongCaRejected: true, hostnameMismatchRejected: true, emptyPasswordFallbackRejected: true };
  } finally {
    offered.length = 0;
    try { await Promise.all(all.map(db => db.dispose())); }
    finally { await Promise.all([fixture.close(), plain.close(), fallback.close()]); }
  }
}

async function runRdsIamChecks(api, _vscode, checks) {
  const credentials = await setupIamFixture();
  const profiles = api.dbConnections, created = [];
  const name = 'RDS IAM owned fixture ' + randomUUID();
  try {
    const result = await verifyRdsIam(credentials);
    const { auth } = target;
    const profile = { name, host: target.host, port: target.port, user: target.user, database: 'rocketbrain_fixture',
      auth: { ...auth, source: 'profile', profile: 'fixture-rds' }, tls: { mode: 'verify', serverName: target.host, caPath: credentials.caPath } };
    await assert.rejects(() => profiles.save({ profile, verify: false, password: 'fixture-only' }), /uses AWS credentials/);
    await assert.rejects(() => profiles.save({ profile: { ...profile, tls: { mode: 'disabled' } }, verify: false }), /verified TLS/);
    await assert.rejects(() => profiles.save({ profile, verify: false, rememberPassword: true }), /temporary tokens/);
    const saved = await profiles.save({ profile, verify: false });
    created.push(saved);
    assert.equal(saved.hasSavedPassword, false);
    assert.equal(saved.profile.auth.profile, 'fixture-rds');
    const editor = await profiles.openEditor(saved.id);
    assert.deepEqual(editor.profile.auth, saved.profile.auth);
    profiles.closeEditor(editor.editorId);
    const portable = profiles.exportProfiles();
    assert.equal(portable.version, 3);
    const exported = portable.profiles.find(item => item.name === name);
    assert.deepEqual(exported.auth, { kind: 'aws-rds-iam', region: 'us-east-1' });
    assert.equal(exported.tls.caPath, undefined);
    await profiles.importProfiles({ ...portable, profiles: [exported] });
    const imported = profiles.list().find(item => item.id !== saved.id && item.profile.name === name);
    created.push(imported);
    await assert.rejects(() => profiles.connect({ id: imported.id }), /local AWS credential source/);
    checks.push('AWS RDS IAM profile and offline signed MySQL TLS authentication checks ran without a cloud account.');
    return { ...result, nativeProfileEditor: true, localAuthReentryAfterImport: true };
  } finally {
    try { for (const profile of created) await profiles.remove({ id: profile.id, expectedRevision: profile.revision }); }
    finally { await credentials.close(); }
  }
}

if (require.main === module) setupIamFixture().then(async fixture => {
  try { console.log(JSON.stringify(await verifyRdsIam(fixture))); }
  finally { await fixture.close(); }
}).catch(error => { console.error(error.message); process.exitCode = 1; });

module.exports = { runRdsIamChecks, verifyRdsIam };
