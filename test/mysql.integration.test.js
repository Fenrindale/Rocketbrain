'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const mysql = require('mysql2/promise');
const { MysqlService } = require('../src/db/mysql');

// Opt-in only: the fixture launcher owns its disposable datadir and teardown.
// No saved production connection or user credential store is read.
const configFile = process.env.ROCKETBRAIN_TEST_MYSQL_CONFIG || process.env.ROCKETBRAIN_MYSQL_TEST_CONFIG;
const config = process.env.ROCKETBRAIN_TEST_MYSQL_JSON ? JSON.parse(process.env.ROCKETBRAIN_TEST_MYSQL_JSON)
  : configFile ? JSON.parse(fs.readFileSync(configFile, 'utf8')) : null;
const live = (name, fn) => test(name.replace('LIVE MariaDB:', 'LIVE MySQL/MariaDB:'), { skip: !config && 'Run integration-db.js or integration-mysql.js with --test test/mysql.integration.test.js.' }, fn);
async function actualState(service) {
  if (process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE === 'mysql') {
    // MySQL has no MariaDB @@in_transaction variable. Independently inspect
    // the public server OK packet on this same real connection.
    const [header] = await service._sessions.get('default').connection.promise().query('DO 0');
    return { autocommit: Boolean(header.serverStatus & 2), active: Boolean(header.serverStatus & 1) };
  }
  const row = (await service.query('SELECT @@autocommit,@@in_transaction')).rows[0];
  return { autocommit: row[0] === '1', active: row[1] === '1' };
}
async function withDatabase(fn) {
  const service = new MysqlService(config);
  const observer = await mysql.createConnection({ ...config, supportBigNumbers: true, bigNumberStrings: true });
  try { await fn(service, observer); } finally { await service.dispose(); await observer.end(); }
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

live('LIVE MariaDB: read-only is enforced by the server and persistent console ids are isolated', () => withDatabase(async service => {
  await service.openSession('a'); await service.openSession('b');
  const first = await service.query('SELECT CONNECTION_ID(), VERSION()', { sessionId: 'a' });
  const second = await service.query('SELECT CONNECTION_ID()', { sessionId: 'a' });
  assert.equal(first.rows[0][0], second.rows[0][0]);
  if (process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE === 'mysql') assert.doesNotMatch(first.rows[0][1], /MariaDB/i);
  else assert.match(first.rows[0][1], /MariaDB/i);
  assert.notEqual(service.getSessionState('a').connectionId, service.getSessionState('b').connectionId);
  // Intentionally bypass our policy to prove server enforcement independently.
  const connection = service._sessions.get('a').connection.promise();
  await assert.rejects(connection.query("UPDATE transaction_probe SET value_text='forbidden' WHERE id=1"), error => error.code === 'ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION');
  assert.equal(service.getSessionState('a').readOnly, true);
}));

live('LIVE MariaDB: temporary tables and bound user variables persist only in their owning console', () => withDatabase(async service => {
  await service.openSession('a'); await service.openSession('b');
  await service.setReadOnly(false, { sessionId: 'a' });
  await service.query('CREATE TEMPORARY TABLE rb_console_temp (id int PRIMARY KEY, label varchar(100))', { sessionId: 'a' });
  const hostile = "'; DROP TABLE people; --";
  const insert = await service.query('INSERT INTO rb_console_temp VALUES (?,?)', { sessionId: 'a', values: [7, hostile] });
  assert.equal(insert.affectedRows, 1);
  await service.query('SET @rb_console_probe=?', { sessionId: 'a', values: [hostile] });
  assert.deepEqual((await service.query('SELECT label,@rb_console_probe FROM rb_console_temp', { sessionId: 'a' })).rows, [[hostile, hostile]]);
  await assert.rejects(service.query('SELECT * FROM rb_console_temp', { sessionId: 'b' }), { code: 'ER_NO_SUCH_TABLE' });
  assert.deepEqual((await service.query('SELECT COUNT(*) FROM people')).rows, [['3']]);
}));

live('LIVE MariaDB: begin/rollback/commit visibility matches an independent server connection', () => withDatabase(async (service, observer) => {
  await service.setReadOnly(false);
  await observer.execute('UPDATE transaction_probe SET value_text=?, version=0 WHERE id=1', ['original']);
  try {
    assert.equal((await service.begin()).inTransaction, true);
    await service.query('UPDATE transaction_probe SET value_text=?,version=version+1 WHERE id=?', { values: ['pending', 1] });
    assert.deepEqual((await service.query('SELECT value_text FROM transaction_probe WHERE id=1')).rows, [['pending']]);
    assert.equal((await observer.query('SELECT value_text FROM transaction_probe WHERE id=1'))[0][0].value_text, 'original');
    assert.equal((await service.rollback()).inTransaction, false);
    assert.equal((await observer.query('SELECT value_text FROM transaction_probe WHERE id=1'))[0][0].value_text, 'original');
    await service.begin();
    await service.query('UPDATE transaction_probe SET value_text=? WHERE id=1', { values: ['committed'] });
    await service.commit();
    assert.equal((await observer.query('SELECT value_text FROM transaction_probe WHERE id=1'))[0][0].value_text, 'committed');
    assert.deepEqual(await actualState(service), { autocommit: true, active: false });
    assert.equal(service.getSessionState().inTransaction, false);
  } finally { await service.rollback(); await observer.execute('UPDATE transaction_probe SET value_text=?,version=0 WHERE id=1', ['original']); }
}));

live('LIVE MariaDB: manual autocommit state and metadata isolation preserve the console transaction', () => withDatabase(async service => {
  await service.setReadOnly(false);
  assert.equal((await service.setAutocommit(false)).autocommit, false);
  const read = await service.query('SELECT value_text FROM transaction_probe WHERE id=1');
  assert.equal(read.state.inTransaction, true);
  const schema = await service.schema();
  assert.ok(schema.some(table => table.name === 'people'));
  assert.equal(service.getSessionState().inTransaction, true);
  await assert.rejects(service.setAutocommit(true), /implicitly commit/);
  await service.rollback();
  assert.equal((await service.setAutocommit(true)).autocommit, true);
}));

live('LIVE MariaDB: failed DDL implicitly commits and state is reconciled against the server', () => withDatabase(async (service, observer) => {
  await service.setReadOnly(false); await service.begin();
  try {
    await service.query('UPDATE transaction_probe SET value_text=? WHERE id=1', { values: ['implicit'] });
    await assert.rejects(service.query('CREATE TABLE transaction_probe (id int)'), { code: 'ER_TABLE_EXISTS_ERROR' });
    assert.equal(service.getSessionState().inTransaction, false);
    assert.equal((await actualState(service)).active, false);
    assert.equal((await observer.query('SELECT value_text FROM transaction_probe WHERE id=1'))[0][0].value_text, 'implicit');
  } finally { await service.rollback(); await observer.execute('UPDATE transaction_probe SET value_text=? WHERE id=1', ['original']); }
}));

live('LIVE MariaDB: metadata includes actual views, precision, composite indexes, foreign keys, routines and triggers', () => withDatabase(async service => {
  const catalog = await service.metadata();
  assert.equal(catalog.database, config.database); assert.equal(catalog.visibility, 'current-account');
  const people = catalog.tables.find(table => table.name === 'people');
  assert.ok(people); assert.ok(people.columns.find(column => column.name === 'amount').type.startsWith('decimal(24,8)'));
  assert.equal(people.columns.find(column => column.name === 'id').primaryKey, true);
  assert.ok(people.indexes.some(index => index.name === 'ix_people_status_name' && index.columns.length === 2));
  assert.ok(people.foreignKeys.some(fk => fk.referencedTable === 'departments'));
  assert.ok(catalog.tables.find(table => table.name === 'memberships').indexes.some(index => index.primaryKey && index.columns.length === 2));
  assert.ok(catalog.views.some(view => view.name === 'active_people'));
  assert.ok(catalog.routines.some(routine => routine.name === 'fixture_people_count'));
  assert.ok(catalog.triggers.some(trigger => trigger.name === 'people_after_update'));
  assert.equal(catalog.coverage.columns, 'loaded');
}));

live('LIVE MariaDB: exact decimal/bigint, null, binary and datetime values survive binary parameter execution', () => withDatabase(async service => {
  const result = await service.query('SELECT id,amount,payload,created_at,email FROM people WHERE id=?', { values: ['9007199254740993'] });
  assert.equal(result.rows[0][0], '9007199254740993');
  assert.equal(result.rows[0][1], '0.00000000');
  assert.equal(result.rows[0][2], '0x000a0d');
  assert.match(result.rows[0][3], /^2026-11-12 01:02:03/);
  const large = await service.query('SELECT amount,email FROM people WHERE id=?', { values: [1] });
  assert.equal(large.rows[0][0], '1234567890123456.12345678');
  assert.deepEqual((await service.query('SELECT email FROM people WHERE id=2')).rows, [[null]]);
}));

live('LIVE MariaDB: nonfatal SQL error preserves connection; server disconnect requires explicit reconnect', () => withDatabase(async (service, observer) => {
  const before = await service.query('SELECT CONNECTION_ID()');
  await assert.rejects(service.query('SELECT missing_column FROM people'), { code: 'ER_BAD_FIELD_ERROR' });
  assert.equal((await service.query('SELECT CONNECTION_ID()')).rows[0][0], before.rows[0][0]);
  const id = service.getSessionState().connectionId; assert.ok(Number.isInteger(id));
  await observer.query('KILL CONNECTION ' + id);
  for (let i = 0; i < 100 && service.getSessionState().connected; i++) await pause(5);
  assert.equal(service.getSessionState().needsReconnect, true);
  await assert.rejects(service.query('SELECT 1'), { code: 'ROCKETBRAIN_RECONNECT_REQUIRED' });
  await service.reconnect();
  assert.notEqual((await service.query('SELECT CONNECTION_ID()')).rows[0][0], id);
}));

live('LIVE MariaDB: cancellation and timeout return promptly, lose the session and never silently rerun', () => withDatabase(async service => {
  await service.openSession('cancel');
  const id = service.getSessionState('cancel').connectionId;
  const pending = service.query('SELECT SLEEP(0.5)', { sessionId: 'cancel' });
  const rejected = assert.rejects(pending, { code: 'ROCKETBRAIN_CANCELLED' });
  await pause(30); await service.cancel('cancel'); await rejected;
  assert.equal(service.getSessionState('cancel').needsReconnect, true);
  await service.reconnect('cancel');
  assert.notEqual(service.getSessionState('cancel').connectionId, id);
  await service.setReadOnly(false);
  await assert.rejects(service.query('UPDATE transaction_probe SET version=version+1 WHERE id=2 AND SLEEP(0.5)=0', { timeoutMs: 30 }), { code: 'ROCKETBRAIN_TIMEOUT' });
  assert.equal(service.getSessionState().outcomeUnknown, true);
  await assert.rejects(service.query('SELECT 1'), { code: 'ROCKETBRAIN_RECONNECT_REQUIRED' });
  // The remote write outcome is deliberately not guessed after transport loss.
  await pause(550);
}));

live('LIVE MariaDB: row limit during a manual transaction exposes lost-session and outcome-unknown state', () => withDatabase(async service => {
  await service.setReadOnly(false); await service.begin();
  const result = await service.query('SELECT id FROM people ORDER BY id', { maxRows: 1 });
  assert.equal(result.rows.length, 1); assert.equal(result.truncated, true);
  assert.equal(result.state.inTransaction, null);
  assert.equal(result.state.transactionState, 'unknown'); assert.equal(result.state.needsReconnect, true);
  assert.equal(result.state.outcomeUnknown, true);
  await assert.rejects(service.commit(), { code: 'ROCKETBRAIN_RECONNECT_REQUIRED' });
}));
