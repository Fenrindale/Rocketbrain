'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { randomBytes } = require('node:crypto');
const { setTimeout: pause } = require('node:timers/promises');
const { startPostgreSqlFixture } = require('./helpers/postgresql-fixture');

async function verifyPostgreSql(api, { fixture, jar, onOpen }) {
  const suffix = randomBytes(5).toString('hex'), driverClass = 'org.postgresql.Driver';
  let profile, wrongProfile;
  try {
    const plan = await api.prepare({ name: 'PostgreSQL JDBC ' + suffix, jar, driverClass, postgresql: fixture.route });
    profile = await api.save(plan.id, true);
    assert.deepEqual(profile.postgresql, fixture.route);
    const catalog = await api.open(profile.id, fixture.auth);
    assert.equal(catalog.connection.product, 'PostgreSQL');
    assert.equal(catalog.connection.catalog, fixture.route.database);
    assert.equal(catalog.connection.schema, 'pilot');
    assert.ok(catalog.objects.some(item => item.kind === 'MATERIALIZED VIEW' && item.name === 'cached_events'));
    assert.ok(catalog.objects.some(item => item.kind === 'VIEW' && item.name === 'active_events'));
    assert.ok(catalog.objects.every(item => item.schema === 'pilot'));
    for (const value of [fixture.auth.password, 'jdbc:postgresql://']) assert.ok(!JSON.stringify(api.list()).includes(value));
    await onOpen?.();

    const index = catalog.objects.findIndex(row => row.name === 'events');
    const columns = await api.describe(index);
    assert.deepEqual(columns.columns.map(column => column.name), ['id', 'amount', 'bytes', 'properties', 'notes', '이름']);
    assert.equal(columns.columns[1].scale, 6);
    assert.equal(columns.columns[0].nullable, false);
    const report = await api.query(`WITH target AS (SELECT * FROM events) SELECT id, amount, bytes,
      properties #>> '{message}' AS msg, properties ? 'message' AS present, notes, "이름",
      $text$syntax; fixture$text$ AS literal FROM target ORDER BY id`, { maxRows: 1 });
    assert.equal(report.truncated, true);
    assert.deepEqual(report.rows[0], ['9007199254740994', '1234567890.123450', '0x000aff', 'semi;colon', 't', '{a,b}', '한글', 'syntax; fixture']);
    assert.equal(report.columns[1].typeName, 'numeric');
    assert.deepEqual((await api.query('SHOW transaction_read_only')).rows, [['on']]);
    await assert.rejects(api.query('SELECT 1; SELECT 2'), /one PostgreSQL statement/);
    await assert.rejects(api.query(`SELECT "set_config"/* comment */('transaction_read_only','off',false)`), /control/);
    await assert.rejects(api.query('SELECT pilot.test_guard()'), /SQLSTATE 25006/);
    assert.equal((await fixture.query('SELECT count(*) FROM pilot.guard_write;')).trim(), '0');

    const controller = new AbortController(), marker = 'rb_pg_cancel_' + suffix;
    const pending = api.query(`SELECT /*${marker}*/ pg_sleep(8)`, { signal: controller.signal });
    pending.catch(() => {});
    try {
      let seen = false;
      const deadline = Date.now() + 6000;
      while (!seen && Date.now() < deadline) {
        seen = (await fixture.query(`SELECT count(*) FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND query LIKE '%${marker}%';`)).trim() === '1';
        if (!seen) await pause(100);
      }
      assert.equal(seen, true);
      controller.abort();
      await assert.rejects(pending, /cancelled/i);
    } finally { controller.abort(); await pending.catch(() => {}); }

    const denied = await api.prepare({ name: 'Unavailable schema ' + suffix, jar, driverClass,
      postgresql: { ...fixture.route, schema: 'nonexistent' } });
    wrongProfile = await api.save(denied.id, true);
    await assert.rejects(api.open(wrongProfile.id, fixture.auth), /does not match the approved profile/);
    return { server: fixture.version, driver: catalog.connection.driverVersion, scopedCatalog: true,
      typedValues: true, postgresSql: true, verifiedServerReadOnly: true, writeRejectedByServer: true,
      cancelledLiveStatement: true, wrongSchemaRejected: true, nativeEditor: Boolean(onOpen) };
  } finally {
    api.close();
    if (wrongProfile) await api.remove(wrongProfile.id);
    if (profile) await api.remove(profile.id);
  }
}

async function runPostgreSqlChecks(api, vscode, checks) {
  const bin = process.env.ROCKETBRAIN_POSTGRES_TEST_BIN, jar = process.env.ROCKETBRAIN_POSTGRES_TEST_JAR;
  assert.ok(bin && jar);
  const fixture = await startPostgreSqlFixture(bin);
  try {
    const result = await verifyPostgreSql(api.jdbc, { fixture, jar, async onOpen() {
      const uri = await vscode.commands.executeCommand('rocketbrain.jdbc.newQuery');
      assert.equal(vscode.window.activeTextEditor.document.uri.toString(), uri);
      const output = await vscode.commands.executeCommand('rocketbrain.jdbc.run');
      assert.deepEqual(output.rows, [['1']]);
      assert.equal(vscode.window.activeTextEditor.document.uri.scheme, 'rocketbrain-jdbc-output');
    } });
    checks.push('real PostgreSQL scoped typed catalog, native syntax, enforced read-only semantics and cancellation');
    return { ...result, cleaned: true };
  } finally {
    await fixture.close();
    await assert.rejects(fs.stat(fixture.folder), { code: 'ENOENT' });
  }
}

module.exports = { verifyPostgreSql, runPostgreSqlChecks };
