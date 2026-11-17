'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { MysqlService } = require('../src/db/mysql');
const file = process.env.ROCKETBRAIN_TEST_MYSQL_CONFIG || process.env.ROCKETBRAIN_MYSQL_TEST_CONFIG;
const config = process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE === 'mysql' && file ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
const live = (name, fn) => test(name, { skip: !config && 'Use scripts/integration-mysql.js run --test test/mysql.server.integration.test.js.' }, fn);
async function run(fn) { const service = new MysqlService(config); try { await fn(service); } finally { await service.dispose(); } }
live('LIVE Oracle MySQL: version, persistent sessions, server readonly and actual transaction flags', () => run(async service => {
  const first = await service.query('SELECT VERSION(),CONNECTION_ID()');
  assert.match(first.rows[0][0], /^8\.4\.13/);
  assert.equal((await service.query('SELECT CONNECTION_ID()')).rows[0][0], first.rows[0][1]);
  await assert.rejects(service._sessions.get('default').connection.promise().query("UPDATE transaction_probe SET value_text='forbidden' WHERE id=1"), { code: 'ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION' });
  assert.equal((await service.begin()).inTransaction, true);
  await service.rollback();
  await service.setReadOnly(false); await service.setAutocommit(false);
  assert.equal((await service.query('SELECT * FROM transaction_probe')).state.inTransaction, true);
  await service.rollback(); await service.setAutocommit(true);
  assert.equal(service.getSessionState().inTransaction, false);
}));
live('LIVE Oracle MySQL: metadata, exact JSON/decimal/binary/bigint prepared results and failed DDL state', () => run(async service => {
  const catalog = await service.metadata(); assert.ok(catalog.tables.some(table => table.name === 'people'));
  const row = (await service.query('SELECT id,amount,details,payload FROM people WHERE id=?', { values: ['9007199254740993'] })).rows[0];
  assert.equal(row[0], '9007199254740993'); assert.equal(row[1], '0.00000000');
  assert.deepEqual(JSON.parse(row[2]), { text: 'a,b' }); assert.equal(row[3], '0x000a0d');
  await service.setReadOnly(false); await service.begin();
  await assert.rejects(service.query('CREATE TABLE transaction_probe (id int)'), { code: 'ER_TABLE_EXISTS_ERROR' });
  assert.equal(service.getSessionState().inTransaction, false);
}));
