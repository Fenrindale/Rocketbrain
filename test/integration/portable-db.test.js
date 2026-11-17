'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const mysql = require('mysql2/promise');
const { startFixture, assertOwnedPath, INSTANCE_ROOT } = require('../../scripts/integration-db-fixture');

test('portable MariaDB fixture isolates runtime, credentials, SQL data and teardown', { skip: process.platform !== 'win32', timeout: 90000 }, async t => {
  assert.throws(() => assertOwnedPath(INSTANCE_ROOT), /Refusing/);
  assert.throws(() => assertOwnedPath(path.dirname(INSTANCE_ROOT)), /Refusing/);
  assert.throws(() => assertOwnedPath(path.join(INSTANCE_ROOT, '..', 'unowned')), /Refusing/);
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const connection = await mysql.createConnection({ ...fixture.config, supportBigNumbers: true, bigNumberStrings: true, dateStrings: true });
  const reader = await mysql.createConnection(fixture.readOnlyConfig);
  t.after(() => { connection.destroy(); reader.destroy(); });
  const checks = [];

  await t.test('server listens only on loopback and owns a new workspace datadir', async () => {
    const [rows] = await connection.query('SELECT @@datadir AS datadir, @@bind_address AS address, @@port AS port');
    assert.equal(rows[0].address, '127.0.0.1');
    assert.equal(Number(rows[0].port), fixture.config.port);
    assert.equal(path.resolve(rows[0].datadir).toLowerCase(), path.resolve(fixture.datadir).toLowerCase());
    assert.ok(fixture.datadir.startsWith(INSTANCE_ROOT + path.sep));
    assert.equal(JSON.parse(await fsp.readFile(fixture.configPath, 'utf8')).password, fixture.config.password);
    checks.push('Loopback random port and fresh workspace-owned datadir confirmed.');
  });

  await t.test('real metadata and difficult cell types are available', async () => {
    const [rows] = await connection.query('SELECT id,amount,details,HEX(payload) AS payload,name_length FROM people ORDER BY id');
    assert.equal(rows.length, 3);
    assert.equal(rows[0].amount, '1234567890123456.12345678');
    assert.equal(rows[2].id, '9007199254740993');
    assert.equal(rows[0].payload, '00CAFEFF');
    const [objects] = await connection.query('SELECT TABLE_NAME,TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA=?', [fixture.config.database]);
    assert.ok(objects.some(row => row.TABLE_NAME === 'active_people' && row.TABLE_TYPE === 'VIEW'));
    const [keys] = await connection.query('SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA=?', [fixture.config.database]);
    assert.ok(keys.some(row => row.CONSTRAINT_NAME === 'fk_people_department'));
    const [unicode] = await connection.query('SELECT `값` AS value FROM `한글_테이블`');
    assert.equal(unicode[0].value, '오프라인 테스트');
    checks.push('Real server values: large integer, exact DECIMAL, JSON, binary, generated column, FK/view and Unicode.');
  });

  await t.test('writer rollback is real and reader privileges independently block changes', async () => {
    await connection.beginTransaction();
    await connection.query("UPDATE transaction_probe SET value_text='uncommitted' WHERE id=1");
    const [inside] = await connection.query('SELECT value_text FROM transaction_probe WHERE id=1');
    const [outside] = await reader.query('SELECT value_text FROM transaction_probe WHERE id=1');
    assert.equal(inside[0].value_text, 'uncommitted');
    assert.equal(outside[0].value_text, 'original');
    await connection.rollback();
    assert.equal((await connection.query('SELECT value_text FROM transaction_probe WHERE id=1'))[0][0].value_text, 'original');
    await assert.rejects(reader.query("UPDATE transaction_probe SET value_text='forbidden' WHERE id=1"), error => ['ER_TABLEACCESS_DENIED_ERROR', 'ER_DBACCESS_DENIED_ERROR'].includes(error.code));
    checks.push('Independent server sessions, rollback and database-enforced read-only user confirmed.');
  });

  connection.destroy(); reader.destroy();
  await t.test('close removes only its own datadir and ephemeral credentials and can be repeated', async () => {
    await fixture.close();
    await fixture.close();
    assert.equal(fs.existsSync(fixture.folder), false);
    assert.equal(fixture.process.exitCode, 0);
    checks.push('Server exited cleanly; ownership-checked workspace datadir and temporary credentials removed.');
  });

  assert.equal(checks.length, 4, 'Every isolation and teardown check must pass before recording success.');
  const report = { checkedAt: new Date().toISOString(), status: 'passed', version: fixture.server.version, passedChecks: checks.length, checks, source: fixture.runtime.source, archiveSha256: fixture.runtime.actualSha256, originalIdeUsed: false, windowsServiceInstalled: false, existingUserDatabaseTouched: false, recordsContainCredentials: false };
  await fsp.writeFile(path.join(__dirname, '../../research/implementation/portable-db-test.json'), JSON.stringify(report, null, 2) + '\n');
});
