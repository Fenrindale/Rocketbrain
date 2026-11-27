'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { createConnectionProfiles } = require('../src/db/connection-profiles');
const { registerConnectionProfiles } = require('../src/db/connection-profiles-vscode');

const dbVersion = '8.4.13';
const serverId = 'origin-server-id';
const currentUser = 'reader@localhost';
const sqlMode = 'STRICT_TRANS_TABLES';
const schema = 'origin_schema';
const tableDdl = 'CREATE TABLE `people` (`id` int NOT NULL) ENGINE=InnoDB';
const noOp = () => ({ dispose() {} });

function savedProfile(name, database, settings = {}) {
  return { profile: { id: randomUUID(), name, group: 'Fixture profiles', color: 'none',
    host: 'owned.database.test', port: 3306, user: 'reader', database, tls: { mode: 'disabled' }, ...settings },
  revision: 9, rememberPassword: false };
}

function storage(...profiles) {
  const settings = new Map([['rocketbrain.database.profiles.v1', profiles]]);
  return {
    workspaceState: { get: (key, fallback) => settings.get(key) ?? fallback,
      async update(key, value) { settings.set(key, structuredClone(value)); } },
    secrets: { async get() {}, async store() { assert.fail('Origin capture saved a secret.'); }, async delete() {} }
  };
}

function metadata(sql, database = schema, caseMode = 0) {
  if (sql.startsWith('SELECT VERSION(),@@hostname')) return [[dbVersion, 'owned-origin', 3306, 19, caseMode, sqlMode, currentUser, database]];
  if (sql === 'SELECT @@server_uuid') return [[serverId]];
  if (sql.startsWith('SELECT VERSION(),DATABASE(),CURRENT_USER(),')) return [[dbVersion, database, currentUser, serverId, sqlMode]];
  if (sql.startsWith('SELECT TABLE_NAME,TABLE_TYPE FROM')) return [['people', 'BASE TABLE']];
  if (sql.startsWith('SELECT t.TABLE_NAME,t.TABLE_TYPE')) return [['people','BASE TABLE','InnoDB','utf8mb4_bin','','Dynamic','','utf8mb4']];
  if (sql.startsWith('SHOW CREATE TABLE ')) return [['people', tableDdl]];
  if (sql.startsWith('SELECT COLUMN_NAME,COLUMN_TYPE,')) return [['id','int','NO',null,'','',1,'',null,null,'']];
  assert.match(sql, /^SELECT .*information_schema\./s, 'The origin requests metadata only.');
  return [];
}

function controller(t, { origin, target, createService }) {
  const { workspaceState, secrets } = storage(origin, target);
  const database = {
    connectMysql() { assert.fail('An origin capture switched the active target.'); },
    disconnectMysql() { assert.fail('An origin capture disconnected the active target.'); },
    activeConnectionProfile: () => target.profile,
    onDidChangeDatabase: noOp
  };
  const vscode = {
    workspace: { isTrusted: true },
    EventEmitter: class { event = noOp; fire() {} dispose() {} },
    TreeItemCollapsibleState: { Expanded: 2, Collapsed: 1, None: 0 },
    commands: { registerCommand: noOp },
    window: { registerTreeDataProvider: noOp }
  };
  const api = registerConnectionProfiles({ workspaceState, secrets, subscriptions: [] }, vscode, { database, createService });
  t.after(() => api.dispose());
  return { api, vscode };
}

test('the profile picker captures origin metadata in an isolated force-read-only service', async t => {
  const origin = savedProfile('Source model', schema), target = savedProfile('Target workspace', 'target_schema');
  const requests = [], resources = [];
  const { api, vscode } = controller(t, { origin, target, createService(config) {
    assert.equal(config.database, origin.profile.database);
    assert.equal(config.readOnly, true);
    assert.equal(config.writeProtection.connectionReadOnly, true);
    assert.equal(config.password, 'one-time-fixture');
    resources.push('opened');
    return { async _metadataQuery(sql) { requests.push(sql); return { rows: metadata(sql) }; },
      async dispose() { resources.push('closed'); } };
  } });
  vscode.window.showQuickPick = async (items, options) => {
    assert.equal(options.title, 'Choose Read-Only Schema Origin');
    return items.find(item => item.label === origin.profile.name && item.description.includes(schema));
  };
  vscode.window.showInputBox = async options => {
    assert.equal(options.title, origin.profile.name);
    assert.equal(options.password, true);
    return 'one-time-fixture';
  };
  const result = await api.chooseSchemaComparisonOrigin({ includeStoredObjects: true });
  assert.deepEqual(Object.keys(result).sort(), ['name', 'snapshot']);
  assert.equal(result.name, origin.profile.name);
  assert.equal(result.snapshot.database, schema);
  assert.equal(result.snapshot.server.serverUniqueId, serverId);
  assert.equal(result.snapshot.tables[0].createSql, tableDdl);
  assert.deepEqual(result.snapshot.storedObjects.coverage, { procedure: 'loaded', function: 'loaded', trigger: 'loaded', event: 'loaded' });
  assert.equal(result.snapshot.rowDataIncluded, false);
  assert.ok(requests.filter(sql => sql.startsWith('SELECT VERSION(),@@hostname')).length >= 2);
  assert.ok(!JSON.stringify(result).includes('one-time-fixture'));
  assert.deepEqual(resources, ['opened', 'closed']);
  assert.deepEqual(api.list().map(row => row.revision), [9, 9]);
});

test('origin cancellation and profile revision drift prevent opening the separate connection', async t => {
  const origin = savedProfile('Source model', schema), target = savedProfile('Target workspace', 'target_schema');
  const { api, vscode } = controller(t, { origin, target, createService() { assert.fail('An incomplete pick opened a connection.'); } });
  vscode.window.showQuickPick = async () => undefined;
  vscode.window.showInputBox = async () => assert.fail('A cancelled pick requested credentials.');
  assert.equal(await api.chooseSchemaComparisonOrigin(), undefined);
  vscode.window.showQuickPick = async items => items[0];
  vscode.window.showInputBox = async () => undefined;
  assert.equal(await api.chooseSchemaComparisonOrigin(), undefined);
  vscode.window.showInputBox = async () => {
    await api.save({ profile: { ...origin.profile, name: 'Changed origin' }, expectedRevision: origin.revision, verify: false });
    return 'never-used-fixture';
  };
  await assert.rejects(api.chooseSchemaComparisonOrigin(), /origin profile changed/);
});

test('origin schema identity follows server ASCII case handling and requires exact Unicode spelling', async t => {
  const cases = [
    { saved: 'ORIGIN_SCHEMA', observed: 'origin_schema', caseMode: 1, matches: true },
    { saved: 'ORIGIN_SCHEMA', observed: 'origin_schema', caseMode: 0, matches: false },
    { saved: 'ORIGIN_SCHEMA', observed: 'other_schema', caseMode: 1, matches: false },
    { saved: 'Äpp', observed: 'äpp', caseMode: 1, matches: false },
    { saved: 'Äpp', observed: 'Äpp', caseMode: 1, matches: true }
  ];
  for (const { saved, observed, caseMode, matches } of cases) {
    const origin = savedProfile('Case test', saved);
    const { workspaceState, secrets } = storage(origin);
    let releases = 0;
    const api = createConnectionProfiles({ state: workspaceState, secrets, isTrusted: () => true,
      createService: () => ({ async _metadataQuery(sql) { return { rows: metadata(sql, observed, caseMode) }; },
        async dispose() { releases++; } }) });
    t.after(() => api.dispose());
    const result = api.captureSchemaComparisonOrigin({ id: origin.profile.id, revision: origin.revision });
    if (matches) assert.equal((await result).snapshot.database, observed);
    else await assert.rejects(result, /opened a different schema/);
    assert.equal(releases, 1);
  }
});

test('origin failure closes both the isolated metadata service and its tunnel', async t => {
  const origin = savedProfile('Tunnel origin', schema, {
    ssh: { host: 'owned.bastion.test', port: 22, user: 'fixture', knownHostsPath: path.resolve('owned-known-hosts') }
  });
  const { workspaceState, secrets } = storage(origin);
  let trusted = true;
  const events = [];
  const api = createConnectionProfiles({ state: workspaceState, secrets, isTrusted: () => trusted,
    connect() { assert.fail('Origin metadata cannot connect the workbench.'); },
    disconnect() { assert.fail('Origin metadata cannot disconnect the workbench.'); },
    async createTunnel(_ssh, destination) {
      assert.deepEqual(destination, { host: origin.profile.host, port: origin.profile.port });
      events.push('opened tunnel');
      return { endpoint: { host: '127.0.0.1', port: 3307 }, async dispose() { events.push('closed tunnel'); } };
    },
    createService(config) {
      assert.equal(config.writeProtection.connectionReadOnly, true);
      events.push('opened service');
      return { async _metadataQuery(sql) {
        events.push('one read');
        trusted = false;
        return { rows: metadata(sql) };
      }, async dispose() { events.push('closed service'); } };
    }
  });
  t.after(() => api.dispose());
  await assert.rejects(api.captureSchemaComparisonOrigin({ id: origin.profile.id, revision: origin.revision }), /Trust this workspace/);
  assert.deepEqual(events, ['opened tunnel', 'opened service', 'one read', 'closed service', 'closed tunnel']);
});
