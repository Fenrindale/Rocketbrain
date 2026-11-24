'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const metadata = require('../src/db/database-admin-metadata');
const grant = require('../src/db/database-table-grant');
const { registerDatabaseAdmin } = require('../src/db/database-admin-vscode');

test('system catalog reads actual version, visible schemas and object metadata without touching rows', async () => {
  const reads = [];
  const read = async (sql, values = []) => {
    reads.push([sql, values]);
    if (sql.startsWith('SELECT VERSION')) return [['11.4.8-MariaDB', 'application', 'reader@127.0.0.1', null, 0]];
    if (sql.includes('SCHEMATA')) return [['information_schema', 'utf8mb3', 'utf8mb3_general_ci'], ['performance_schema', 'utf8mb4', 'utf8mb4_bin']];
    if (sql.includes('COLUMNS')) return [['TABLE_NAME', 'varchar(64)', 'NO', 1]];
    if (sql.includes('TABLES')) return [['TABLES', 'SYSTEM VIEW', null]];
    assert.fail(sql);
  };
  const catalog = await metadata.scope(read);
  assert.equal(catalog.dialect, 'mariadb');
  assert.equal(catalog.accountLimited, true);
  assert.equal(catalog.schemas.find(item => item.name === 'mysql').visibility, 'not-observed');
  assert.equal(catalog.schemas.find(item => item.name === 'performance_schema').instrumentation, 'disabled');
  const page = await metadata.objects(read, { schema: 'information_schema', page: 2, search: '%t_' });
  assert.equal(page.objects[0].name, 'TABLES');
  assert.deepEqual(reads.at(-1)[1], ['information_schema', '%=%t=_%']);
  assert.match(reads.at(-1)[0], /OFFSET 200$/);
  const detail = await metadata.object(read, { schema: 'information_schema', name: 'TABLES' });
  assert.equal(detail.rowDataIncluded, false);
  assert.deepEqual(detail.columns, [{ name: 'TABLE_NAME', type: 'varchar(64)', nullable: false, ordinal: 1 }]);
  await assert.rejects(metadata.object(read, { schema: 'application', name: 'TABLES' }), /observed system schema/);
  assert.ok(reads.every(([sql]) => !sql.includes('SELECT *')));
});

test('access scope distinguishes direct privilege, role and account catalog coverage', async () => {
  for (const dialect of ['mysql', 'mariadb']) {
    const reads = [];
    const context = { dialect, version: 'sentinel', database: 'application', account: 'reader@127.0.0.1', activeRoles: null };
    const read = async (sql, args) => {
      reads.push([sql, args]);
      if (sql.includes('FROM mysql.user')) throw new Error('denied fixture authority');
      if (sql.includes('SCHEMA_PRIVILEGES')) return [['SELECT', 'YES', 'application']];
      if (sql.includes('APPLICABLE_ROLES')) return [['reporter', dialect === 'mysql' ? '%' : null, 'NO', 'YES']];
      return [];
    };
    assert.equal((await metadata.accounts(read, context)).visibility, 'unavailable');
    const access = await metadata.inspectAccess(read, context);
    assert.equal(access.credentialsIncluded, false);
    assert.equal(access.effectiveAccessCalculated, false);
    assert.deepEqual(access.privileges.schema.entries, [{ name: 'SELECT', grantable: true, schema: 'application' }]);
    assert.equal(access.roles.entries[0].defaultRole, true);
    assert.equal(reads.at(-1)[0].includes('ROLE_HOST'), dialect === 'mysql');
    assert.ok(reads.every(([sql]) => !/authentication_string|SHOW GRANTS|SHOW CREATE USER/i.test(sql)));
  }
});

function fakeTransport(dialect = 'mysql') {
  const state = { id: 1, ddl: 'CREATE TABLE `items` (id INT)', columns: '', held: [], writes: [], cut: false };
  const identity = { dialect, database: 'application', currentUser: 'admin@localhost',
    sqlMode: dialect === 'mariadb' ? 'NO_AUTO_CREATE_USER' : 'STRICT_TRANS_TABLES', serverUniqueId: 'fixture' };
  const db = { _schemaRenamer: {
    async _withSession(action) { return action({ connected: true }); },
    async _identity() { return { ...identity, serverId: state.id }; },
    async _read(session, sql, args) {
      if (state.cut) throw new Error('postcondition unavailable');
      if (sql.includes('FROM mysql.user')) return [args];
      if (sql.includes('FROM information_schema.TABLES')) return [['items', 'BASE TABLE']];
      if (sql.startsWith('SHOW CREATE TABLE')) return [['items', state.ddl]];
      if (sql.includes('mysql.tables_priv')) return [[state.held.join(','), state.columns]];
      assert.fail(sql);
    }
  }, async _control(session, sql) {
    state.writes.push(sql);
    state.held = sql.startsWith('GRANT') ? [...state.held, 'Select'] : state.held.filter(value => value !== 'Select');
    if (state.cutAfterWrite) state.cut = true;
    return { warningStatus: 0 };
  } };
  return { db, state, identity, lease: { db, epoch: 1, guard: () => true } };
}
const input = { account: { user: 'analyst', host: 'localhost' }, table: 'items', action: 'grant' };

test('one exact SELECT grant can be verified, but old direct privileges or table definitions block it', async () => {
  const env = fakeTransport('mariadb');
  const plan = await grant.previewTableGrant(env.lease, input);
  assert.equal(plan.sql, "GRANT SELECT ON `application`.`items` TO 'analyst'@'localhost'");
  assert.deepEqual(env.state.writes, []);
  env.state.ddl += ' COMMENT=\'new\'';
  await assert.rejects(grant.applyTableGrant(env.lease, plan), /changed after review/);
  assert.deepEqual(env.state.writes, []);
  const fresh = await grant.previewTableGrant(env.lease, input);
  assert.equal((await grant.applyTableGrant(env.lease, fresh)).state, 'verified');
  assert.deepEqual(env.state.held, ['Select']);
  const revoke = await grant.previewTableGrant(env.lease, { ...input, action: 'revoke' });
  assert.equal(revoke.sql, "REVOKE SELECT ON `application`.`items` FROM 'analyst'@'localhost'");
  assert.equal((await grant.applyTableGrant(env.lease, revoke)).state, 'verified');
  assert.deepEqual(env.state.held, []);
  env.state.columns = 'Select';
  await assert.rejects(grant.previewTableGrant(env.lease, input), /Column grants/);
  env.state.columns = '';
  env.identity.sqlMode = '';
  await assert.rejects(grant.previewTableGrant(env.lease, input), /prevents implicit account creation/);
});

test('grant write losing its readback is uncertain and never submits a second statement', async () => {
  const env = fakeTransport();
  const plan = await grant.previewTableGrant(env.lease, input);
  env.state.cutAfterWrite = true;
  const outcome = await grant.applyTableGrant(env.lease, plan);
  assert.equal(outcome.state, 'uncertain');
  assert.equal(outcome.automaticRetry, false);
  assert.equal(env.state.writes.length, 1);
});

test('admin controller requires approval, guards stale routes and keeps private review immutable', async () => {
  const env = fakeTransport();
  const fake = () => ({ dispose() {} });
  let changed;
  const service = registerDatabaseAdmin({}, {
    workspace: { isTrusted: true, registerTextDocumentContentProvider: fake }, commands: { registerCommand: fake }
  }, { database: { withDatabaseAdmin: task => task(env.lease), onDidChangeDatabase(handler) { changed = handler; return fake(); } } });
  const stale = await service.prepareTableGrant(input);
  changed();
  await assert.rejects(service.applyTableGrant({ reviewId: stale.reviewId, approved: true }), /connection changed/);
  const reviewed = await service.prepareTableGrant(input);
  reviewed.account.user = 'unreviewed';
  reviewed.sql = 'UNREVIEWED SQL';
  await assert.rejects(service.applyTableGrant({ reviewId: reviewed.reviewId }), /Approve/);
  assert.deepEqual(env.state.writes, []);
  await service.applyTableGrant({ reviewId: reviewed.reviewId, approved: true });
  assert.match(env.state.writes[0], /analyst/);
  await assert.rejects(service.applyTableGrant({ reviewId: reviewed.reviewId, approved: true }), /expired/);
  service.dispose();
});
