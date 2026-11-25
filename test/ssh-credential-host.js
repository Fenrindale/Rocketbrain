'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { createConnectionProfiles } = require('../src/db/connection-profiles');
const { connectionProfile } = require('../src/db/connection-security');
const { MysqlService } = require('../src/db/mysql');
const { createSshCredentialFixture, waitFor } = require('./helpers/ssh-credentials-fixture');

const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const springState = { people:2, departments:1, rolledBackNames:0 };

async function verifySshCredentials(manager, adapter, runtimePath) {
  const runtime = await read(runtimePath);
  const db = await read(runtime.dbConfigPath);
  const folder = path.dirname(runtime.dbConfigPath);
  const owner = await read(path.join(folder, 'owner.json'));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(owner.kind));
  assert.equal(db.host, '127.0.0.1');
  assert.equal(db.database, 'rocketbrain_fixture');
  assert.equal(new URL(runtime.baseUrl).hostname, '127.0.0.1');
  const fixture = await createSshCredentialFixture(folder, { host:db.host, port:db.port });
  const opened = [], saved = [];
  const scope = { host:db.host, port:db.port, user:db.user, database:db.database, tls:{mode:'disabled'} };
  const profiles = [
    ['password', fixture.passwordProfile, fixture.password],
    ['encrypted-key', fixture.keyProfile, fixture.passphrase]
  ];
  const waitClosed = () => waitFor(() => fixture.clients.size === 0 && fixture.sockets.size === 0, 'Owned SSH channels or connections remained active.');
  try {
    const wrongPin = 'SHA256:' + createHash('sha256').update('owned mismatch').digest('base64').slice(0, -1);
    const refuse = { id:randomUUID(), name:'Owned refused SSH', ...scope, ssh:{ ...fixture.passwordProfile, hostFingerprint:wrongPin } };
    await assert.rejects(manager.test({ profile:refuse, password:db.password, sshCredential:fixture.password }), /host-key verification/);
    assert.equal(fixture.count.password + fixture.count.publickey + fixture.count.other + fixture.count.forward, 0);
    await waitClosed();

    let serverVersion;
    for (const [authentication, ssh, sshCredential] of profiles) {
      let id = randomUUID();
      const profileFields = { name:'Owned SSH ' + authentication + ' ' + id.slice(0,6), ...scope, ssh };
      const credentials = { password:db.password, sshCredential };
      const wrong = { password:db.password, sshCredential:'owned-wrong-credential' };
      const expectedAuth = authentication === 'password' ? /authentication method or credential/ : /could not be unlocked/;
      await assert.rejects(manager.test({ profile:{ id, ...profileFields }, ...wrong }), expectedAuth);
      await waitClosed();
      const authEvents = fixture.count.password + fixture.count.publickey + fixture.count.other;
      const forwardEvents = fixture.count.forward;
      const tested = await manager.test({ profile:{ id, ...profileFields }, ...credentials });
      assert.equal(tested.ssh, true);
      assert.equal(tested.database, db.database);
      assert.ok(tested.schemas.includes(db.database));
      assert.equal(tested.currentUser.startsWith(db.user + '@'), true);
      assert.equal(fixture.count.password + fixture.count.publickey + fixture.count.other, authEvents + (authentication === 'password' ? 1 : 2));
      assert.ok(fixture.count.forward > forwardEvents);
      await waitClosed();
      serverVersion = tested.serverVersion;

      let record;
      if (adapter.openEditor) {
        const editor = await adapter.openEditor();
        opened.push(editor.editorId);
        id = editor.profile.id;
        record = await adapter.handle(editor.editorId, { type:'connect', editorId:editor.editorId,
          profile:profileFields, ...credentials, rememberPassword:false });
        assert.equal(record.connected, true);
      } else {
        record = await manager.save({ profile:{ id, ...profileFields }, ...credentials, rememberPassword:false, connectAfterSave:true });
        assert.equal(record.connected, true);
      }
      assert.equal(record.id, id);
      saved.push(id);
      assert.equal(record.profile.ssh.authentication, authentication);
      assert.equal(record.profile.ssh.hostFingerprint, ssh.hostFingerprint);
      assert.equal(record.hasSavedPassword, false);
      assert.equal(adapter.active().id, id);
      const { rows } = await adapter.query('SELECT id FROM rb_spring_person ORDER BY id');
      assert.deepEqual(rows.map(row => Number(row[0])), [1,2]);

      await manager.disconnect();
      await waitClosed();
      await assert.rejects(manager.connect({ id, password:db.password }), /SSH (password|key passphrase) for this attempt/);
      const next = await manager.connect({ id, ...credentials });
      assert.equal(next.connected, true);
      const all = manager.exportProfiles(), exported = all.profiles.find(item => item.name === record.profile.name);
      assert.equal(all.credentialsIncluded, false);
      assert.deepEqual(exported.ssh, { host:ssh.host, port:ssh.port, user:ssh.user, authentication, requiresLocalHostFingerprint:true });
      adapter.assertCredentialFree?.([sshCredential, db.password]);
      for (const sensitive of [sshCredential, db.password]) {
        assert.ok(!JSON.stringify(record).includes(sensitive));
        assert.ok(!JSON.stringify(all).includes(sensitive));
      }
      await manager.disconnect();
      await waitClosed();
    }
    assert.equal(fixture.count.other, 0);
    assert.ok(fixture.count.password > 0 && fixture.count.publickey > 0 && fixture.count.forward > 0);
    const response = await fetch(runtime.baseUrl + '/probe/testing-state', { signal:AbortSignal.timeout(9000) });
    assert.equal(response.ok, true);
    assert.deepEqual(await response.json(), springState);
    return { engine:runtime.dbEngine, serverVersion, methods: profiles.map(([method]) => method),
      wrongPinWithheldAuthentication:true, retryRequiresFreshInput:true, exportCredentialFree:true, cleanup:true, spring:springState };
  } finally {
    try {
      await manager.disconnect();
      for (const editor of opened) adapter.closeEditor?.(editor);
      for (const id of saved) {
        const record = manager.list().find(item => item.id === id);
        if (record) await manager.remove({ id, expectedRevision:record.revision });
      }
    } finally { await fixture.close(); }
  }
}

async function verifySshCredentialBackend(runtimePath = process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG) {
  const persisted = new Map(), secrets = new Map(), writes = [];
  let active, info;
  const manager = createConnectionProfiles({
    state:{ get:(key, fallback) => persisted.get(key) ?? fallback, async update(key, value){ persisted.set(key, value); writes.push(value); } },
    secrets:{ async get(key){ return secrets.get(key); }, async delete(key){ secrets.delete(key); },
      async store(key, secret){ secrets.set(key, secret); assert.fail('An attempt-only secret reached Secret Storage.'); } },
    createService:config => new MysqlService(config),
    async connect(config) { active = new MysqlService(config); info = connectionProfile(config); await active.metadata(); },
    async disconnect() { await active?.dispose(); active = undefined; info = undefined; },
    getActiveProfile:() => info, isTrusted:() => true
  });
  try {
    const result = await verifySshCredentials(manager, { active:() => info, query:sql => active.query(sql),
      assertCredentialFree(items) {
        const durable = JSON.stringify(writes);
        for (const item of items) assert.ok(!durable.includes(item));
        assert.ok(!durable.includes('sshCredential'));
      }
    }, runtimePath);
    assert.equal(secrets.size, 0);
    return { ...result, secretStorageWrites:0 };
  } finally { await manager.dispose(); }
}

async function runSshCredentialChecks(api, _vscode, checks) {
  const manager = api.dbConnections;
  const result = await verifySshCredentials(manager, { active:api.activeConnectionProfile,
    query:sql => api.withDatabaseAdmin(({ db }) => db._metadataQuery(sql)),
    openEditor:manager.openEditor, handle:manager.handle, closeEditor:manager.closeEditor },
  process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG);
  checks.push('The native connection editor used pinned SSH password and encrypted keys and closed both owned forwards.');
  return { ...result, nativeProfileEditor:true };
}

module.exports = { runSshCredentialChecks, verifySshCredentialBackend };
if (require.main === module) verifySshCredentialBackend()
  .then(report => console.log(JSON.stringify(report)))
  .catch(error => { console.error(error.stack); process.exitCode = 1; });
