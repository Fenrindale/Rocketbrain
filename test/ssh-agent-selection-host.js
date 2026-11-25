'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const { MysqlService } = require('../src/db/mysql');
const { createConnectionProfiles } = require('../src/db/connection-profiles');
const { openTunnel } = require('../src/db/connection-tunnel');
const { bindConnectionResource, connectionProfile } = require('../src/db/connection-security');
const { sshServer, listening } = require('../scripts/connection-security-fixture');
const { ownedAgent } = require('./helpers/ssh-agent-fixture');
const { owned } = require('./schema-stored-diff-host');
const { jdbcReadback } = require('./java-source-analysis-host');

const jdbc = { people: 2, departments: 1, rolledBackNames: 0 };

async function fixtureConfig() {
  const runtime = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const { actor, config, version } = await owned(runtime.dbConfigPath);
  await actor.end();
  assert.deepEqual(await jdbcReadback(), jdbc);
  return { runtime, config, version };
}

async function verifySshAgentSelection(manager, adapter) {
  const { runtime, config, version } = await fixtureConfig();
  const folder = runtime.sshAgentFixturePath, agent = await ownedAgent(folder);
  let ssh, forward, service, editor, profileId;
  const inheritedEndpoint = process.env.SSH_AUTH_SOCK;
  try {
    ssh = await sshServer({ folder }, { host: config.host, port: config.port });
    const selection = { endpoint: agent.endpoint, publicKeyPath: agent.publicKeyPath };
    const target = { ...ssh.ssh, privateKeyPath: '', agent: selection };
    const key = Buffer.from((await fs.readFile(agent.publicKeyPath, 'utf8')).split(/\s+/u)[1], 'base64');
    const fingerprint = 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/u, '');
    const caPath = path.join(folder, 'ca.pem'), serverName = 'rb-db.local';
    const ca = await fs.readFile(caPath, 'utf8');
    const profile = { name: 'Owned selected SSH agent ' + randomBytes(4).toString('hex'), host: config.host,
      port: config.port, user: config.user, database: config.database, tls: { mode: 'verify', caPath, serverName }, ssh: target };
    function onlySelectedSince(start) {
      const recent = agent.requests.slice(start);
      assert.ok(recent.some(item => item.action === 'list' && item.count === 2));
      assert.equal(recent.filter(item => item.action === 'sign').length > 0, true);
      assert.ok(recent.every(item => item.action !== 'sign' || item.index === agent.selected));
    }

    forward = await openTunnel(target, config);
    const loopbackPort = forward.endpoint.port;
    assert.ok(await listening(loopbackPort));
    assert.equal(forward.agentFingerprint, fingerprint);
    service = new MysqlService(bindConnectionResource({ ...config, ssl: { ca, serverName } }, {
      endpoint: forward.endpoint, dispose: forward.dispose
    }));
    const query = await service.query('SELECT VERSION(), DATABASE()');
    assert.deepEqual(query.rows, [[version, config.database]]);
    const cipher = await service.query("SHOW SESSION STATUS LIKE 'Ssl_cipher'");
    assert.ok(cipher.rows[0][1]);
    onlySelectedSince(0);
    await service.dispose();
    service = undefined;
    assert.equal(await listening(loopbackPort), false);

    let start = agent.requests.length;
    const tested = await manager.test({ profile, password: config.password });
    assert.ok(tested.tls && tested.ssh && tested.cipher);
    assert.equal(tested.sshAgentFingerprint, fingerprint);
    assert.equal(tested.serverVersion, version);
    onlySelectedSince(start);

    start = agent.requests.length;
    await assert.rejects(manager.test({ profile: { ...profile, ssh: { ...target, knownHostsPath: ssh.badKnownHostsPath } },
      password: config.password }), /host-key verification/);
    assert.equal(agent.requests.length, start);
    await assert.rejects(manager.test({ profile: { ...profile, ssh: { ...target, agent: { ...selection, publicKeyPath: agent.otherKeyPath } } },
      password: config.password }), /authentication failed/);
    assert.ok(agent.requests.slice(start).every(item => item.action !== 'sign' || item.index !== agent.selected));
    const missing = process.platform === 'win32' ? agent.endpoint + '-missing' : agent.endpoint + '.missing';
    await assert.rejects(manager.test({ profile: { ...profile, ssh: { ...target, agent: { ...selection, endpoint: missing } } },
      password: config.password }), /authentication failed|socket is unavailable/);
    await assert.rejects(manager.test({ profile: { ...profile, ssh: { ...target, agent: { ...selection, publicKeyPath: agent.privateKeyPath } } },
      password: config.password }), /one OpenSSH Ed25519 public key/);
    await assert.rejects(manager.test({ profile: { ...profile, tls: { ...profile.tls, serverName: 'wrong-db.local' } },
      password: config.password }));

    const saved = await manager.save({ profile, password: config.password, rememberPassword: false });
    profileId = saved.id;
    assert.equal(saved.observed.sshAgentFingerprint, fingerprint);
    assert.equal(saved.hasSavedPassword, false);
    const beforeActivation = agent.requests.length;
    if (adapter.open) {
      editor = await adapter.open(profileId);
      assert.deepEqual(editor.profile.ssh.agent, selection);
      const form = { ...editor.profile };
      delete form.id;
      const active = await adapter.handle(editor.editorId,
        { editorId: editor.editorId, type: 'connect', profile: form, password: config.password, rememberPassword: false });
      assert.ok(active.connected);
    } else await manager.connect({ id: profileId, password: config.password });
    onlySelectedSince(beforeActivation);
    const authenticated = await adapter.query('SELECT VERSION(), DATABASE()');
    assert.deepEqual(authenticated.rows, [[version, config.database]]);
    assert.equal(adapter.active().id, profileId);
    const configured = manager.exportProfiles().profiles.find(item => item.name === profile.name);
    assert.deepEqual(configured.ssh, { host: target.host, port: target.port, user: target.user, requiresLocalKeyAndKnownHosts: true });

    await manager.disconnect();
    const selectedFile = await fs.readFile(agent.publicKeyPath);
    const beforeDrift = agent.requests.length;
    try {
      await fs.copyFile(agent.otherKeyPath, agent.publicKeyPath);
      await assert.rejects(manager.connect({ id: profileId, password: config.password }), /selected SSH agent public key changed/);
      assert.equal(agent.requests.length, beforeDrift);
    } finally { await fs.writeFile(agent.publicKeyPath, selectedFile); }
    await manager.connect({ id: profileId, password: config.password });
    onlySelectedSince(beforeDrift);
    assert.equal(process.env.SSH_AUTH_SOCK, inheritedEndpoint);
    assert.deepEqual(await jdbcReadback(), jdbc);
    return { engine: runtime.dbEngine, version, jdbc, agentIdentitySelected: true, twoAgentKeys: true,
      selectedFingerprint: true, verifiedKeyDriftRefused: true, blockedFallback: true, sameDatabaseAsSpring: true, actualEncryptedSql: true,
      wrongKnownHostRefusedBeforeAgentUse: true, wrongTlsNameRefused: true, privateKeyRejectedAsPublic: true,
      localAgentConfigExcludedFromExport: true, ownedForwardClosed: true, childOnlyAgentSelection: true };
  } finally {
    try {
      await manager.disconnect();
      if (editor) adapter.close(editor.editorId);
      if (profileId) {
        const current = manager.list().find(record => record.id === profileId);
        await manager.remove({ id: profileId, expectedRevision: current.revision });
      }
    } finally {
      try { await service?.dispose(); await forward?.dispose(); }
      finally { try { await ssh?.close(); } finally { await agent.close(); } }
    }
  }
}

async function verifySshAgentBackend() {
  const state = new Map(), secrets = new Map();
  let active, profile;
  const manager = createConnectionProfiles({
    state: { get: (key, fallback) => state.get(key) ?? fallback, async update(key, value) { state.set(key, value); } },
    secrets: { async get(key) { return secrets.get(key); }, async store(key, value) { secrets.set(key, value); },
      async delete(key) { secrets.delete(key); } },
    async connect(config) { profile = connectionProfile(config); active = new MysqlService(config); await active.metadata(); },
    async disconnect() { await active?.dispose(); active = undefined; profile = undefined; },
    getActiveProfile: () => profile,
    isTrusted: () => true, createService: config => new MysqlService(config)
  });
  try {
    return await verifySshAgentSelection(manager, { active: () => profile, query: text => active.query(text) });
  } finally { await manager.dispose(); }
}

async function runSshAgentSelectionChecks(api, _vscode, checks) {
  const manager = api.dbConnections;
  const result = await verifySshAgentSelection(manager, {
    active: api.activeConnectionProfile, query: text => api.withDatabaseAdmin(({ db }) => db._metadataQuery(text)),
    open: manager.openEditor, handle: manager.handle, close: manager.closeEditor
  });
  checks.push('The native connection editor activated one Ed25519 agent identity against this Spring database over strict OpenSSH and verified TLS.');
  checks.push('An agent with two keys used only the selected signing key. Bad host keys, unavailable agents and wrong TLS identities failed before a usable SQL session.');
  return { ...result, nativeProfileEditor: true };
}

module.exports = { runSshAgentSelectionChecks, verifySshAgentBackend };
if (require.main === module) verifySshAgentBackend().then(result => console.log(JSON.stringify(result)))
  .catch(error => { console.error(error.stack); process.exitCode = 1; });
