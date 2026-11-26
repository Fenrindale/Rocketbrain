'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const mysql = require('mysql2/promise');
const { MysqlService } = require('../src/db/mysql');
const { connectionProfile } = require('../src/db/connection-security');
const { createConnectionProfiles } = require('../src/db/connection-profiles');
const { inspectOpenBaoCa, readOpenBaoPassword } = require('../src/db/openbao-credential');
const { startOpenBao } = require('./helpers/openbao-fixture');
const { owned } = require('./schema-stored-diff-host');
const { jdbcReadback } = require('./java-source-analysis-host');

const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const springRows = { people: 2, departments: 1, rolledBackNames: 0 };

async function verifyOpenBaoProfile(manager, bin, adapter = {}) {
  const runtime = await read(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG);
  const runtimeFile = await fs.realpath(runtime.dbConfigPath);
  const directory = path.dirname(runtimeFile);
  const descriptor = await fs.realpath(process.env.ROCKETBRAIN_DBADMIN_TEST_CONFIG);
  assert.equal(path.dirname(descriptor), directory);
  const setup = await read(descriptor);
  assert.equal(setup.format, 'RocketbrainOwnedDatabaseAdminFixture');
  assert.equal(setup.owner, path.basename(directory));
  assert.equal(await fs.realpath(setup.sourceConfigPath), runtimeFile);
  assert.equal(setup.engine, runtime.dbEngine);
  const { actor, config, version } = await owned(runtimeFile);
  const name = 'OpenBao rotation fixture ' + randomBytes(5).toString('hex');
  const account = 'rb_bao_' + randomBytes(6).toString('hex'), host = '127.0.0.1';
  const first = randomBytes(24).toString('base64url'), second = randomBytes(24).toString('base64url') + '-끝';
  const existing = new Set(manager.list().map(record => record.id));
  const authorities = [];
  let server, editor, writer, built = false;
  const administer = async (statement, values) => {
    try { await writer.query(statement, values); }
    catch (error) {
      const code = /^ER_[A-Z0-9_]+$/.test(error.code || '') ? error.code : 'unavailable';
      throw Error('The owned database account operation failed (' + code + ').');
    }
  };
  try {
    assert.ok(setup.admin.user.startsWith('rb_acl_writer_'));
    for (const field of ['host', 'port', 'database']) assert.equal(setup.admin[field], config[field]);
    assert.deepEqual(await jdbcReadback(), springRows);
    writer = await mysql.createConnection(setup.admin);
    await administer('CREATE USER ?@? IDENTIFIED BY ?', [account, host, first]);
    built = true;
    await administer('GRANT SELECT ON rocketbrain_fixture.* TO ?@?', [account, host]);
    server = await startOpenBao(bin);
    async function issuer(uses) {
      const token = await server.createToken(uses);
      authorities.push(token);
      return token;
    }
    assert.equal(await server.put(first), 1);
    assert.equal(await server.deniedAdjacent(await issuer(2)), true);
    const caSha256 = await inspectOpenBaoCa(server.caPath);
    const auth = { kind: 'openbao-kv2', origin: server.origin, mount: server.mount, secretPath: server.secretPath,
      field: server.field, caPath: server.caPath, caSha256 };
    const profile = { name, host, port: config.port, user: account, database: config.database, auth };
    await assert.rejects(manager.test({ profile }), { code: 'ROCKETBRAIN_OPENBAO_TOKEN' });
    await assert.rejects(manager.save({ profile, rememberPassword: true }), /without saving the resolved password/);
    const aborted = new AbortController();
    aborted.abort();
    const cancelledToken = await issuer();
    await assert.rejects(readOpenBaoPassword(auth, cancelledToken, aborted.signal), { code: 'ROCKETBRAIN_OPENBAO_CANCELLED' });
    const changedCa = { ...auth, caSha256: 'a'.repeat(64) };
    await assert.rejects(manager.test({ profile: { ...profile, auth: changedCa }, openBaoToken: await issuer() }),
      { code: 'ROCKETBRAIN_OPENBAO_TLS' });
    const { caPath, caSha256: ignoredCa, ...systemTrust } = auth;
    await assert.rejects(manager.test({ profile: { ...profile, auth: systemTrust }, openBaoToken: await issuer() }),
      { code: 'ROCKETBRAIN_OPENBAO_READ' });
    const firstToken = await issuer();
    const saved = await manager.save({ profile, openBaoToken: firstToken, rememberPassword: false, connectAfterSave: true });
    assert.equal(saved.connected, true);
    assert.equal(saved.hasSavedPassword, false);
    assert.equal(saved.observed.currentUser, account + '@' + host);
    await assert.rejects(manager.connect({ id: saved.id, openBaoToken: firstToken }), { code: 'ROCKETBRAIN_OPENBAO_DENIED' });
    await manager.disconnect();

    await administer('ALTER USER ?@? IDENTIFIED BY ?', [account, host, second]);
    const unrotated = await issuer();
    await assert.rejects(manager.connect({ id: saved.id, openBaoToken: unrotated }), error =>
      ![first, second, ...authorities].some(value => error.message.includes(value)));
    assert.equal(await server.put(second), 2);
    const renewed = await manager.connect({ id: saved.id, openBaoToken: await issuer() });
    assert.equal(renewed.connected, true);
    assert.equal(renewed.credentialSaved, false);
    await adapter.inspectActive?.(account);
    const exported = manager.exportProfiles();
    assert.equal(exported.version, 9);
    const portable = exported.profiles.find(item => item.name === name);
    assert.deepEqual(portable.auth, { kind: 'openbao-kv2' });
    const liveState = JSON.stringify({ profiles: manager.list(), exported, captured: adapter.workspaceState?.() });
    for (const value of [first, second, ...authorities]) assert.ok(!liveState.includes(value), 'Credential material reached profile metadata.');
    assert.ok(!JSON.stringify(exported).includes(server.secretPath), 'The local OpenBao reference reached the portable profile.');
    assert.equal(adapter.savedSecretCount?.() || 0, 0);
    assert.equal(manager.datasetProfileSource?.list().some(item => item.id === saved.id) || false, false);
    const single = { ...exported, profiles: [portable] };
    const review = manager.reviewProfileImport(single);
    const imported = await manager.importProfiles(single, { review, strategy: 'rename' });
    assert.equal(imported.imported, 1);
    const placeholder = manager.list().find(record => !existing.has(record.id) && record.id !== saved.id);
    assert.deepEqual(placeholder.profile.auth, { kind: 'openbao-kv2' });
    await assert.rejects(manager.connect({ id: placeholder.id, openBaoToken: await issuer() }), /Configure the local OpenBao/);
    if (adapter.openEditor) {
      editor = await adapter.openEditor(saved.id);
      assert.equal(editor.profile.auth.origin, server.origin);
      assert.equal(editor.profile.auth.caSha256, caSha256);
      assert.ok(!JSON.stringify(editor).includes(second));
    }
    await manager.disconnect();
    assert.deepEqual(await jdbcReadback(), springRows);
    return { engine: runtime.dbEngine, serverVersion: version, openBao: server.version, verifiedHttps: true,
      exactSinglePath: true, oneUseAuthority: true, actualSqlPasswordRotation: true, correctSqlAccount: true,
      cancelRefused: true, replacedCaRefused: true, untrustedServerRefused: true, noSecretStorage: true,
      credentialFreeExport: true, localReconfigurationOnImport: true, springJdbcUnchanged: true, nativeProfileEditor: Boolean(editor), cleaned: true };
  } finally {
    try {
      if (editor) await adapter.closeEditor?.(editor.editorId);
      for (const record of manager.list().filter(item => !existing.has(item.id))) {
        await manager.remove({ id: record.id, expectedRevision: record.revision, disconnect: true });
      }
    } finally {
      try {
        try { if (built) await administer('DROP USER IF EXISTS ?@?', [account, host]); }
        finally { await writer?.end(); await actor.end(); }
      } finally {
        if (server) {
          await server.stop();
          await assert.rejects(() => fs.stat(server.folder), { code: 'ENOENT' });
        }
      }
    }
  }
}

async function runOpenBaoProfileChecks(api, vscode, checks) {
  const bin = process.env.ROCKETBRAIN_OPENBAO_TEST_BIN;
  assert.ok(bin, 'Configure the owned OpenBao fixture executable.');
  const result = await verifyOpenBaoProfile(api.dbConnections, bin, {
    openEditor: id => vscode.commands.executeCommand('rocketbrain.connections.edit', id),
    closeEditor: id => api.dbConnections.closeEditor(id)
  });
  checks.push('Genuine scoped OpenBao HTTPS credentials with one-use authority, SQL password rotation and credential-free state.');
  return result;
}

async function headless() {
  const stored = new Map(), secretStore = new Map();
  let active, profile;
  const disconnect = async () => { const old = active; active = profile = undefined; await old?.dispose(); };
  const manager = createConnectionProfiles({
    state: { get: (key, initial) => stored.get(key) ?? initial, update: async (key, value) => stored.set(key, value) },
    secrets: { get: async key => secretStore.get(key), delete: async key => secretStore.delete(key),
      store: async (key, value) => secretStore.set(key, value) },
    async connect(config) {
      const next = new MysqlService(config);
      try { await next.metadata(); }
      catch (error) { await next.dispose(); throw error; }
      await disconnect();
      active = next;
      profile = connectionProfile(config);
    },
    disconnect, getActiveProfile: () => profile, isTrusted: () => true, createService: config => new MysqlService(config)
  });
  try {
    return await verifyOpenBaoProfile(manager, process.env.ROCKETBRAIN_OPENBAO_TEST_BIN, {
      workspaceState: () => [...stored], savedSecretCount: () => secretStore.size,
      async inspectActive(account) {
        const observed = await active._metadataQuery('SELECT CURRENT_USER()');
        assert.deepEqual(observed.rows, [[account + '@127.0.0.1']]);
      }
    });
  } finally { await disconnect(); await manager.dispose(); }
}

if (require.main === module) headless().then(result => console.log(JSON.stringify(result)), error => {
  console.error(error);
  process.exitCode = 1;
});
module.exports = { runOpenBaoProfileChecks };
