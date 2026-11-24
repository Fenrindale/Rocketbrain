'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const mysql = require('mysql2/promise');

async function runDatabaseAdminChecks(api, vscode, checks) {
  const runtime = JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG));
  const config = JSON.parse(fs.readFileSync(runtime.dbConfigPath));
  const owner = JSON.parse(fs.readFileSync(path.join(path.dirname(runtime.dbConfigPath), 'owner.json')));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(owner.kind));
  assert.equal(config.host, '127.0.0.1');
  assert.equal(runtime.dbEngine, process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE);
  const url = new URL('/probe/testing-state', runtime.baseUrl);
  assert.equal(url.hostname, '127.0.0.1');
  const springIsolation = { people: 2, departments: 1, rolledBackNames: 0 };
  const verifySpring = async () => {
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), springIsolation);
  };

  const tools = api.dbAdmin;
  assert.ok(tools);
  const actor = await mysql.createConnection(config);
  const table = 'rb_acl_test_' + randomBytes(5).toString('hex');
  let created = false, guest;
  try {
    await verifySpring();
    await api.connectMysql(config);
    const commands = await vscode.commands.getCommands(true);
    for (const id of ['systemCatalog', 'inspectAccess', 'reviewTableGrant']) assert.ok(commands.includes('rocketbrain.db.' + id));
    const catalog = await tools.listSystemSchemas();
    const [actual] = await actor.query("SELECT LOWER(SCHEMA_NAME) AS name FROM information_schema.SCHEMATA WHERE LOWER(SCHEMA_NAME) IN ('information_schema','performance_schema','mysql','sys') ORDER BY LOWER(SCHEMA_NAME)");
    assert.deepEqual(catalog.schemas.filter(schema => schema.visibility === 'visible').map(schema => schema.name).sort(),
      actual.map(row => row.name));
    const [[identity]] = await actor.query('SELECT VERSION() AS version,@@performance_schema AS instrumentation');
    assert.equal(catalog.version, identity.version);
    assert.equal(catalog.dialect, runtime.dbEngine);
    assert.equal(catalog.performanceInstrumentation, Number(identity.instrumentation) ? 'enabled' : 'disabled');
    const page = await tools.listSystemObjects({ schema: 'information_schema', search: 'TABLES' });
    const exact = page.objects.find(item => item.name === 'TABLES');
    assert.ok(exact);
    const definition = await tools.inspectSystemObject({ schema: 'information_schema', name: exact.name });
    const [columns] = await actor.query("SELECT COLUMN_NAME AS name,ORDINAL_POSITION AS ordinal FROM information_schema.COLUMNS WHERE LOWER(TABLE_SCHEMA)='information_schema' AND TABLE_NAME='TABLES' ORDER BY ORDINAL_POSITION");
    assert.deepEqual(definition.columns.map(column => [column.name, column.ordinal]), columns.map(column => [column.name, Number(column.ordinal)]));
    assert.equal(definition.rowDataIncluded, false);
    await assert.rejects(tools.inspectSystemObject({ schema: config.database, name: 'TABLES' }), /observed system schema/);
    const access = await tools.inspectAccess();
    assert.equal(access.selected.user, config.user);
    assert.equal(access.credentialsIncluded, false);
    assert.equal(access.effectiveAccessCalculated, false);
    assert.ok(access.privileges.schema.entries.some(item => item.schema === config.database && item.name === 'SELECT'));
    assert.equal(JSON.stringify(access).includes(config.password), false);
    checks.push('Native read-only system schemas and columns match the actual account-visible INFORMATION_SCHEMA metadata and instrumentation state.');
    checks.push('Native access inspection distinguishes direct grants and roles without returning credential-bearing grant statements.');

    const grantCoverage = { tested: false };
    const descriptor = process.env.ROCKETBRAIN_DBADMIN_TEST_CONFIG;
    if (descriptor) {
      const data = JSON.parse(fs.readFileSync(descriptor));
      assert.equal(path.dirname(descriptor), path.dirname(runtime.dbConfigPath));
      assert.equal(data.format, 'RocketbrainOwnedDatabaseAdminFixture');
      assert.equal(data.version, 1);
      assert.equal(data.owner, owner.id);
      assert.equal(data.sourceConfigPath, runtime.dbConfigPath);
      assert.equal(data.engine, runtime.dbEngine);
      assert.ok(data.admin.user.startsWith('rb_acl_writer_') && data.guest.user.startsWith('rb_acl_guest_'));
      for (const value of [data.admin, data.guest]) {
        assert.equal(value.port, config.port); assert.equal(value.host, config.host); assert.equal(value.database, config.database);
      }
      await actor.query('CREATE TABLE `' + table + '` (id INT PRIMARY KEY) ENGINE=InnoDB');
      created = true;
      await actor.query('INSERT INTO `' + table + '` VALUES (1)');
      await api.connectMysql(data.admin);
      const list = await tools.listAccounts();
      assert.equal(list.visibility, 'observed');
      const selected = list.entries.find(account => account.user === data.guest.user && account.host === data.guest.host);
      assert.ok(selected);
      const guestAccess = await tools.inspectAccess(selected);
      assert.ok(guestAccess.roles.entries.some(role => role.user === data.role));
      const { database: _, ...login } = data.guest;
      guest = await mysql.createConnection(login);
      const read = () => guest.query('SELECT id FROM `' + config.database + '`.`' + table + '`');
      const insufficient = error => ['ER_TABLEACCESS_DENIED_ERROR', 'ER_DBACCESS_DENIED_ERROR'].includes(error.code);
      await assert.rejects(read(), insufficient);

      const stale = await tools.prepareTableGrant({ account: selected, table, action: 'grant' });
      await actor.query('ALTER TABLE `' + table + '` ADD COLUMN late_review INT');
      await assert.rejects(tools.applyTableGrant({ reviewId: stale.reviewId, approved: true }), /changed after review/);
      await assert.rejects(read(), insufficient);
      const plan = await tools.prepareTableGrant({ account: selected, table, action: 'grant' });
      await assert.rejects(tools.applyTableGrant({ reviewId: plan.reviewId }), /Approve/);
      assert.equal((await tools.applyTableGrant({ reviewId: plan.reviewId, approved: true })).state, 'verified');
      assert.equal((await read())[0][0].id, 1);
      const revoke = await tools.prepareTableGrant({ account: selected, table, action: 'revoke' });
      assert.equal((await tools.applyTableGrant({ reviewId: revoke.reviewId, approved: true })).state, 'verified');
      await assert.rejects(read(), insufficient);
      assert.deepEqual((await tools.inspectAccess(selected)).roles, guestAccess.roles);
      Object.assign(grantCoverage, { tested: true, exactGrantAndRevoke: true, actualTargetReadChanged: true,
        staleDefinitionRefused: true, explicitApproval: true, roleAssignmentsUnchanged: true });
      checks.push('A least-scope owned test administrator granted and revoked one table SELECT for an explicitly chosen existing account. Direct privileges were verified, an intervening DDL change blocked approval, and role assignments stayed unchanged.');
    }
    await verifySpring();
    return { visibleSchemas: catalog.schemas.filter(schema => schema.visibility === 'visible').map(schema => schema.name),
      instrumentation: catalog.performanceInstrumentation, systemColumns: definition.columns.length,
      directAccountAccess: true, roleCoverage: access.roles.visibility, grantCoverage, springIsolation };
  } finally {
    try { await api.disconnectMysql(); }
    finally {
      try { if (created) await actor.query('DROP TABLE `' + table + '`'); }
      finally { await Promise.allSettled([actor.end(), ...(guest ? [guest.end()] : [])]); }
    }
  }
}

module.exports = { runDatabaseAdminChecks };
