'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { createConnectionProfiles } = require('../src/db/connection-profiles');
const { MysqlService } = require('../src/db/mysql');
const { connectionProfile } = require('../src/db/connection-security');
const { javaExecutable } = require('../src/db/jdbc');
const { owned } = require('./schema-stored-diff-host');
const { jdbcReadback } = require('./java-source-analysis-host');

const expectedJdbc = { people: 2, departments: 1, rolledBackNames: 0 };
const read = async filename => JSON.parse(await fs.readFile(filename, 'utf8'));

async function keytool(executable, folder, args, password) {
  const allowed = new Set(['SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL']);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toUpperCase())));
  env.ROCKETBRAIN_FIXTURE_JKS_PASS = password;
  await new Promise((resolve, reject) => {
    const child = spawn(executable, [...args, '-storepass:env', 'ROCKETBRAIN_FIXTURE_JKS_PASS'], {
      cwd: folder, env, windowsHide: true, shell: false, stdio: 'ignore'
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
    child.once('error', reject);
    child.once('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(Error('The owned KeyTool fixture command failed.'));
    });
  });
}

async function configFromFixture() {
  const runtime = await read(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG);
  const observed = await owned(runtime.dbConfigPath);
  await observed.actor.end();
  assert.deepEqual(await jdbcReadback(), expectedJdbc);
  return { runtime, config: observed.config, version: observed.version };
}

async function verifyJksTrustStore(manager, adapter) {
  const { runtime, config, version } = await configFromFixture();
  const identity = await read(runtime.clientIdentityFixturePath);
  assert.equal(identity.format, 'RocketbrainOwnedClientIdentityFixture');
  assert.equal(identity.dbConfigPath, runtime.dbConfigPath);
  assert.match(identity.user, /^rb_client_[0-9a-f]{10}$/u);
  const { folder } = identity, marker = await read(path.join(folder, 'owner.json'));
  assert.equal(marker.kind, 'RocketbrainConnectionSecurityFixture-v18');
  assert.equal(marker.id, path.basename(await fs.realpath(folder)));
  const java = await javaExecutable(adapter.javaHome, 'JKS test truststores');
  const keytoolPath = path.join(java.root, 'bin', process.platform === 'win32' ? 'keytool.exe' : 'keytool');
  const secret = randomBytes(24).toString('base64url'), tag = randomBytes(5).toString('hex');
  const storePath = label => path.join(folder, tag + '-' + label + '.jks');
  const paths = ['correct', 'untrusted', 'leaf', 'wrong-format', 'mixed'].map(storePath);
  const [valid, wrong, leaf, disguised, mixed] = paths;
  const baseRequest = { password: config.password, trustStorePassphrase: secret };
  const client = { password: identity.password, trustStorePassphrase: secret, clientIdentityPassphrase: identity.passphrase };
  const group = 'Owned JKS trust ' + tag;
  const route = { group, host: config.host, port: config.port, database: config.database, user: config.user };
  const serverTrust = { mode: 'verify', serverName: 'rb-db.local', serverTrust: 'jks', trustStorePath: valid };
  const base = { ...route, name: 'JKS trust only', tls: serverTrust };
  const mutual = { ...route, name: 'Separate JKS and PKCS12', user: identity.user,
    tls: { ...serverTrust, clientIdentity: 'pkcs12', pfxPath: path.join(folder, 'client.p12') } };
  const importStore = (file, certificate, type = 'JKS') => keytool(keytoolPath, folder,
    ['-importcert', '-noprompt', '-alias', 'owned-ca', '-keystore', file,
      '-storetype', type, '-file', path.join(folder, certificate)], secret);
  const ids = [];
  let editor;
  try {
    await importStore(valid, 'ca.pem');
    await importStore(wrong, 'wrong-ca.pem');
    await importStore(leaf, 'server.pem');
    await importStore(disguised, 'ca.pem', 'PKCS12');
    await importStore(mixed, 'ca.pem');
    await keytool(keytoolPath, folder, ['-genkeypair', '-noprompt', '-alias', 'owned-private', '-keyalg', 'RSA',
      '-keysize', '2048', '-dname', 'CN=Rocketbrain owned private test', '-validity', '1',
      '-keystore', mixed, '-storetype', 'JKS', '-keypass:env', 'ROCKETBRAIN_FIXTURE_JKS_PASS'], secret);

    const flags = await manager.test({ profile: base, ...baseRequest });
    assert.equal(flags.serverTrust, 'jks');
    assert.equal(flags.serverVersion, version);
    assert.equal(flags.tls, true);
    assert.ok(flags.cipher);
    await assert.rejects(manager.test({ profile: base, password: config.password }), /JKS truststore passphrase/);
    await assert.rejects(manager.test({ profile: base, ...baseRequest, trustStorePassphrase: identity.passphrase }), /only valid CA certificate entries/);
    for (const trustStorePath of [leaf, disguised, mixed]) {
      await assert.rejects(manager.test({ profile: { ...base, tls: { ...serverTrust, trustStorePath } }, ...baseRequest }),
        /only valid CA certificate entries/);
    }
    await assert.rejects(manager.test({ profile: { ...base, tls: { ...serverTrust, trustStorePath: wrong } }, ...baseRequest }));
    await assert.rejects(manager.test({ profile: { ...base, tls: { ...serverTrust, serverName: 'wrong-db.local' } }, ...baseRequest }));
    await assert.rejects(manager.test({ profile: { ...base, user: identity.user }, ...client, clientIdentityPassphrase: undefined }));
    await assert.rejects(manager.test({ profile: mutual, ...client, clientIdentityPassphrase: secret }), /PKCS#12/);

    const saved = await manager.save({ profile: mutual, ...client, rememberPassword: true });
    ids.push(saved.id);
    assert.equal(saved.observed.serverTrust, 'jks');
    assert.equal(saved.hasSavedPassword, true);
    await assert.rejects(manager.connect({ id: saved.id, clientIdentityPassphrase: identity.passphrase }), /JKS truststore passphrase/);
    await assert.rejects(manager.connect({ id: saved.id, trustStorePassphrase: secret }), /client identity passphrase/);
    if (adapter.open) {
      editor = await adapter.open(saved.id);
      const form = { ...editor.profile };
      delete form.id;
      assert.equal(form.tls.trustStorePath, valid);
      const connected = await adapter.handle(editor.editorId, { type: 'connect', editorId: editor.editorId,
        profile: form, ...client, rememberPassword: true });
      assert.equal(connected.connected, true);
    } else await manager.connect({ id: saved.id, trustStorePassphrase: secret, clientIdentityPassphrase: identity.passphrase });
    assert.equal(adapter.active().id, saved.id);
    const identityReadback = await adapter.query('SELECT CURRENT_USER(), DATABASE()');
    assert.deepEqual(identityReadback.rows, [[identity.user + '@127.0.0.1', config.database]]);
    await manager.disconnect();

    const port = manager.exportProfiles(), portable = port.profiles.find(row => row.group === group);
    assert.ok(port.version >= 7);
    assert.equal(port.credentialsIncluded, false);
    assert.deepEqual(portable.tls, { mode: 'verify', serverName: 'rb-db.local', clientIdentity: 'pkcs12', serverTrust: 'jks' });
    assert.equal([secret, identity.passphrase, identity.password, valid].some(text =>
      JSON.stringify([flags, saved.observed, port]).includes(text)), false);
    await manager.importProfiles({ ...port, profiles: [{ ...portable, name: 'Imported trust' }] });
    const imported = manager.list().find(row => row.profile.name === 'Imported trust' && row.profile.group === group);
    ids.push(imported.id);
    assert.equal(imported.profile.tls.trustStorePath, '');
    assert.equal(imported.hasSavedPassword, false);
    await assert.rejects(manager.connect({ id: imported.id, ...client }), /Select a local JKS server truststore/);
    assert.deepEqual(await jdbcReadback(), expectedJdbc);
    return { engine: runtime.dbEngine, version, jdbc: expectedJdbc, exactJksTrustedCa: true, verifiedTlsHostname: true,
      separateMutualIdentity: true, passwordsAttemptOnly: true, omittedLocalPaths: true, importedTrustRebind: true,
      privateEntryRefused: true, nonCaEntryRefused: true, pkcs12TypeSubstitutionRefused: true,
      wrongCaRefused: true, wrongHostnameRefused: true };
  } finally {
    try {
      await manager.disconnect();
      if (editor) adapter.close(editor.editorId);
      for (const id of ids) {
        const current = manager.list().find(row => row.id === id);
        if (current) await manager.remove({ id, expectedRevision: current.revision });
      }
    } finally {
      for (const file of paths) await fs.unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
}

async function verifyJksBackend() {
  const build = await read(path.resolve(__dirname, '../test-output/spring-project/dependencies.json'));
  const records = new Map(), passwords = new Map();
  let active, profile;
  const manager = createConnectionProfiles({
    state: { get: (key, fallback) => records.get(key) ?? fallback, async update(key, value) { records.set(key, value); } },
    secrets: { async get(key) { return passwords.get(key); }, async store(key, value) { passwords.set(key, value); },
      async delete(key) { passwords.delete(key); } },
    async connect(config) { profile = connectionProfile(config); active = new MysqlService(config); await active.metadata(); },
    async disconnect() { await active?.dispose(); active = undefined; profile = undefined; },
    getActiveProfile: () => profile, getJavaHome: () => build.javaHome,
    isTrusted: () => true, createService: config => new MysqlService(config)
  });
  try {
    return await verifyJksTrustStore(manager, { javaHome: build.javaHome, active: () => profile, query: text => active.query(text) });
  } finally { await manager.dispose(); }
}

async function runJksTrustStoreChecks(api, vscode, checks) {
  const manager = api.dbConnections, javaHome = vscode.workspace.getConfiguration('rocketbrain.java').get('javaHome');
  const result = await verifyJksTrustStore(manager, {
    javaHome, active: api.activeConnectionProfile, query: text => api.withDatabaseAdmin(({ db }) => db._metadataQuery(text)),
    open: manager.openEditor, handle: manager.handle, close: manager.closeEditor
  });
  checks.push('The native profile used a CA-only JKS truststore for hostname-verified TLS on the actual Spring database.');
  checks.push('JKS server trust remained separate from the PKCS#12 client identity. A private entry, a leaf entry and a different container type were refused.');
  return { ...result, nativeProfileEditor: true };
}

module.exports = { runJksTrustStoreChecks, verifyJksBackend };
if (require.main === module) verifyJksBackend().then(result => console.log(JSON.stringify(result)))
  .catch(error => { console.error(error.stack); process.exitCode = 1; });
