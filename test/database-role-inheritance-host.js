'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const mysql = require('mysql2/promise');
const { MysqlService } = require('../src/db/mysql');
const { readContext, readRows, inspectRoleInheritance } = require('../src/db/database-admin-metadata');
const { jdbcReadback } = require('./java-source-analysis-host');

async function verify(inspect, connect, onReport) {
  const runtime = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const dir = path.dirname(runtime.dbConfigPath);
  const owner = JSON.parse(await fs.readFile(path.join(dir, 'owner.json'), 'utf8'));
  const config = JSON.parse(await fs.readFile(runtime.dbConfigPath, 'utf8'));
  const descriptor = process.env.ROCKETBRAIN_DBADMIN_TEST_CONFIG;
  assert.equal(path.relative(path.dirname(descriptor), dir), '');
  const data = JSON.parse(await fs.readFile(descriptor, 'utf8'));
  assert.equal(data.format, 'RocketbrainOwnedDatabaseAdminFixture');
  assert.equal(data.owner, owner.id);
  assert.equal(data.engine, runtime.dbEngine);
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(owner.kind));
  for (const profile of [config, data.admin, data.guest]) {
    assert.equal(profile.host, '127.0.0.1');
    assert.equal(profile.database, 'rocketbrain_fixture');
    assert.equal(profile.port, config.port);
  }
  const { root, middle, leaf, table } = data.nested;
  for (const item of [root, middle, leaf, table]) assert.match(item, /^rb_acl_[a-z]+_[a-f0-9]{10}$/);
  const { database: _database, ...guest } = data.guest;
  const selected = { user: guest.user, host: guest.host };
  const jdbc = await jdbcReadback();
  await connect(data.admin);
  const report = await inspect(selected);
  assert.equal(report.visibility, 'observed', JSON.stringify(report.unresolved));
  assert.deepEqual(report.roles.map(r => [r.identity.user, r.depth]), [[root, 1], [middle, 2], [leaf, 3]]);
  assert.deepEqual(report.roles[2].path.map(r => r.user), [guest.user, root, middle, leaf]);
  assert.equal(report.edges.find(edge => edge.role.user === leaf).adminOption, true);
  assert.equal(report.credentialsIncluded, false);
  assert.equal(report.effectiveAccessCalculated, false);
  assert.ok(!JSON.stringify(report).includes(guest.password));
  const grants = report.roles[2].privileges.table;
  assert.equal(grants.visibility, 'observed');
  assert.deepEqual(grants.entries.find(entry => entry.table === table),
    { name: 'SELECT', grantable: false, schema: config.database, table });
  await onReport?.(selected, data.nested);
  const login = await mysql.createConnection(guest);
  try {
    const query = 'SELECT id FROM rocketbrain_fixture.' + table;
    await assert.rejects(login.query(query), /denied/i);
    await login.query('SET ROLE ' + (runtime.dbEngine === 'mysql' ? "'" + root + "'@'%'" : '`' + root + '`'));
    assert.deepEqual((await login.query(query))[0], [{ id: 17 }]);
  } finally { await login.end(); }
  assert.deepEqual(await jdbcReadback(), jdbc);
  return { engine: runtime.dbEngine, version: report.version, jdbc, exactDepth: 3, adminOption: true,
    leafGrantObserved: true, disabledRoleDenied: true, enabledRoleRead: true, credentialsOmitted: true };
}

async function verifyNativeRoleInheritance(api, vscode, checks) {
  try {
    const report = await verify(account => api.dbAdmin.inspectRoleInheritance(account), config => api.connectMysql(config), async (account, names) => {
      assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.db.inspectRoleInheritance'));
      const view = await api.dbAdmin.openRoleInheritance(account);
      const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(view.documentUri));
      assert.match(document.getText(), /Inherited role/);
      assert.ok(document.getText().includes(names.leaf) && document.getText().includes(names.table));
      assert.match(document.getText(), /Positive grants visible to this connection/);
      assert.equal(document.uri.scheme, 'rocketbrain-db-admin');
      assert.equal(document.isDirty, false);
    });
    checks.push('Read the exact three-level role chain and observed leaf privilege in the native administrator document, then verified access with the actual guest role enabled.');
    return { ...report, nativeRoleDocument: true };
  } finally { await api.disconnectMysql(); }
}

async function verifyBackendRoleInheritance() {
  let db;
  try {
    return await verify(async account => {
      const read = (sql, values) => readRows(db, sql, values);
      return inspectRoleInheritance(read, await readContext(read), account);
    }, config => { db = new MysqlService(config); });
  } finally { await db?.dispose(); }
}

if (require.main === module) verifyBackendRoleInheritance().then(result => console.log(JSON.stringify(result)),
  error => { console.error(error.stack); process.exitCode = 1; });

module.exports = { verifyNativeRoleInheritance, verifyBackendRoleInheritance };
