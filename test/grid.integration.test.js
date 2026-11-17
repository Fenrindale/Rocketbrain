'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const mysql = require('mysql2/promise');
const { MysqlService } = require('../src/db/mysql');
const configFile = process.env.ROCKETBRAIN_TEST_MYSQL_CONFIG || process.env.ROCKETBRAIN_MYSQL_TEST_CONFIG;
let config;
if (configFile) {
  const marker = JSON.parse(fs.readFileSync(path.join(path.dirname(configFile), 'owner.json'), 'utf8'));
  if (!['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(marker.kind)) throw new Error('Grid mutation tests require a marked disposable Rocketbrain fixture.');
  config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  if (config.host !== '127.0.0.1' || config.database !== 'rocketbrain_fixture') throw new Error('Grid tests refuse a non-fixture database.');
}
const live = (name, fn) => test(name, { skip: !config && 'Use integration-db.js or integration-mysql.js run --test test/grid.integration.test.js.' }, fn);
const q = value => String.fromCharCode(96) + value + String.fromCharCode(96);
async function withGrid(fn) {
  const name = 'rb_grid_' + randomUUID().replaceAll('-', '').slice(0, 16);
  const observer = await mysql.createConnection({ ...config, supportBigNumbers: true, bigNumberStrings: true, dateStrings: true });
  const service = new MysqlService(config);
  await observer.query('CREATE TABLE ' + q(name) + ' (id BIGINT UNSIGNED PRIMARY KEY,label VARCHAR(80) NOT NULL,nullable_text TEXT NULL,payload BLOB NULL,json_value JSON NULL,exact_value DECIMAL(24,8) NOT NULL DEFAULT 0,version INT NOT NULL DEFAULT 0,computed INT GENERATED ALWAYS AS (CHAR_LENGTH(label)) STORED) ENGINE=InnoDB');
  await observer.execute('INSERT INTO ' + q(name) + ' (id,label,nullable_text,payload,json_value,exact_value) VALUES (?,?,?,?,?,?),(?,?,?,?,?,?)',
    ['1', 'Alpha', null, Buffer.from([0, 202, 254]), '{"a":1}', '1234567890123456.12345678', '9007199254740993', 'Beta', 'text', Buffer.alloc(0), null, '0.00000000']);
  try { await fn({ service, observer, name }); }
  finally { await service.dispose(); await observer.query('DROP TABLE IF EXISTS ' + q(name)); await observer.end(); }
}
const change = (preview, values, index = 0) => ({ modelId: preview.edit.modelId, updates: [{ rowId: preview.edit.rowIds[index], values }] });

live('LIVE GRID: explicit previews expose edit metadata; arbitrary SQL and readonly mode cannot apply', () => withGrid(async ({ service, name }) => {
  const preview = await service.previewTable(name, { maxRows: 1 });
  assert.equal(preview.edit.canEdit, true, preview.edit.reason);
  assert.equal(preview.rows.length, 1); assert.equal(preview.edit.hasMorePossible, true);
  assert.equal(preview.state.connected, true); assert.equal(preview.state.readOnly, true);
  assert.equal(preview.edit.columns.find(column => column.name === 'id').editable, false);
  assert.equal(preview.edit.columns.find(column => column.name === 'id').insertable, true);
  assert.equal(preview.edit.columns.find(column => column.name === 'computed').insertable, false);
  assert.equal(preview.edit.columns.find(column => column.name === 'json_value').kind, 'json');
  assert.throws(() => service.reviewChangeSet(change(preview, { label: 'no' })), { code: 'ROCKETBRAIN_READ_ONLY' });
  assert.equal((await service.query('SELECT * FROM ' + q(name))).edit, undefined);
}));

live('LIVE GRID: manual apply remains uncommitted, refreshes generated values, rollback/commit invalidate old snapshots', () => withGrid(async ({ service, observer, name }) => {
  await service.setReadOnly(false); await service.setAutocommit(false);
  let preview = await service.previewTable(name);
  let review = service.reviewChangeSet(change(preview, { label: 'Pending value' }));
  let result = await service.applyChangeSet({ reviewId: review.reviewId });
  assert.equal(result.pendingTransaction, true); assert.equal(result.committed, false);
  assert.equal(result.result.rows[0][1], 'Pending value'); assert.equal(result.result.rows[0][7], 13);
  assert.equal((await observer.query('SELECT label FROM ' + q(name) + ' WHERE id=1'))[0][0].label, 'Alpha');
  await service.rollback();
  assert.throws(() => service.reviewChangeSet(change(result.result, { label: 'stale' })), { code: 'ROCKETBRAIN_GRID_STALE' });
  preview = await service.previewTable(name);
  review = service.reviewChangeSet(change(preview, { label: 'Committed' }));
  result = await service.applyChangeSet({ reviewId: review.reviewId });
  await service.commit();
  assert.equal((await observer.query('SELECT label FROM ' + q(name) + ' WHERE id=1'))[0][0].label, 'Committed');
  assert.throws(() => service.reviewChangeSet(change(result.result, { label: 'stale' })), { code: 'ROCKETBRAIN_GRID_STALE' });
}));

live('LIVE GRID: typed NULL/JSON/blob/bigint/decimal updates and inserts survive actual MySQL/MariaDB conversion', () => withGrid(async ({ service, observer, name }) => {
  await service.setReadOnly(false);
  const preview = await service.previewTable(name);
  const review = service.reviewChangeSet({ ...change(preview, {
    nullable_text: { kind: 'null' }, payload: { kind: 'value', text: '0x0000ff' },
    json_value: { kind: 'value', text: 'null' }, exact_value: '9876543210123456.87654321',
  }), inserts: [{ values: { id: '18446744073709551614', label: 'Inserted', nullable_text: 'NULL', payload: '0x', json_value: '{"ko":"한글"}', exact_value: '0.00000001' } }] });
  const result = await service.applyChangeSet({ reviewId: review.reviewId });
  assert.equal(result.committed, true); assert.equal(result.pendingTransaction, false);
  const rows = result.result.rows;
  assert.equal(rows[0][2], null); assert.equal(rows[0][3], '0x0000ff'); assert.equal(rows[0][4], 'null');
  assert.equal(rows[0][5], '9876543210123456.87654321');
  assert.equal(rows.at(-1)[0], '18446744073709551614'); assert.equal(rows.at(-1)[2], 'NULL'); assert.equal(rows.at(-1)[3], '0x');
  assert.deepEqual(JSON.parse(rows.at(-1)[4]), { ko: '한글' });
  assert.equal(String((await observer.query('SELECT COUNT(*) AS n FROM ' + q(name)))[0][0].n), '3');
  await assert.rejects(service.applyChangeSet({ reviewId: review.reviewId }), { code: 'ROCKETBRAIN_GRID_STALE' });
}));

live('LIVE GRID: independent server update conflicts with the snapshot and savepoint preserves earlier user work', () => withGrid(async ({ service, observer, name }) => {
  await service.setReadOnly(false); await service.setAutocommit(false);
  await service.query('UPDATE transaction_probe SET value_text=? WHERE id=1', { values: ['earlier user work'] });
  const preview = await service.previewTable(name);
  const review = service.reviewChangeSet({ modelId: preview.edit.modelId, updates: [
    { rowId: preview.edit.rowIds[0], values: { label: 'Should rollback' } },
    { rowId: preview.edit.rowIds[1], values: { label: 'Conflict edit' } },
  ] });
  await observer.execute('UPDATE ' + q(name) + ' SET label=? WHERE id=?', ['Other connection', '9007199254740993']);
  await assert.rejects(service.applyChangeSet({ reviewId: review.reviewId }), { code: 'ROCKETBRAIN_GRID_CONFLICT' });
  assert.equal(service.getSessionState().inTransaction, true);
  assert.deepEqual((await service.query('SELECT value_text FROM transaction_probe WHERE id=1')).rows, [['earlier user work']]);
  assert.equal((await observer.query('SELECT label FROM ' + q(name) + ' WHERE id=1'))[0][0].label, 'Alpha');
  assert.equal((await observer.query('SELECT label FROM ' + q(name) + ' WHERE id=9007199254740993'))[0][0].label, 'Other connection');
  await service.rollback();
}));

live('LIVE GRID: later insert failure rolls back all updates from the apply and preserves earlier transaction data', () => withGrid(async ({ service, observer, name }) => {
  await service.setReadOnly(false); await service.setAutocommit(false);
  await service.query('UPDATE transaction_probe SET value_text=? WHERE id=1', { values: ['preserved'] });
  const preview = await service.previewTable(name);
  const review = service.reviewChangeSet({ ...change(preview, { label: 'Must rollback' }), inserts: [{ values: { id: '1', label: 'Duplicate' } }] });
  await assert.rejects(service.applyChangeSet({ reviewId: review.reviewId }), { code: 'ER_DUP_ENTRY' });
  assert.deepEqual((await service.query('SELECT label FROM ' + q(name) + ' WHERE id=1')).rows, [['Alpha']]);
  assert.deepEqual((await service.query('SELECT value_text FROM transaction_probe WHERE id=1')).rows, [['preserved']]);
  assert.equal((await observer.query('SELECT label FROM ' + q(name) + ' WHERE id=1'))[0][0].label, 'Alpha');
  await service.rollback();
}));

live('LIVE GRID: delete uses the private PK snapshot and a deleted server row is a conflict', () => withGrid(async ({ service, observer, name }) => {
  await service.setReadOnly(false);
  let preview = await service.previewTable(name);
  let review = service.reviewChangeSet({ modelId: preview.edit.modelId, deletes: [preview.edit.rowIds[1]] });
  let applied = await service.applyChangeSet({ reviewId: review.reviewId });
  assert.equal(applied.committed, true); assert.equal(applied.result.rows.length, 1);
  preview = applied.result;
  review = service.reviewChangeSet({ modelId: preview.edit.modelId, deletes: [preview.edit.rowIds[0]] });
  await observer.query('DELETE FROM ' + q(name) + ' WHERE id=1');
  await assert.rejects(service.applyChangeSet({ reviewId: review.reviewId }), { code: 'ROCKETBRAIN_GRID_CONFLICT' });
}));

live('LIVE GRID: schema changes racing before metadata-lock acquisition are detected before any DML', () => withGrid(async ({ service, observer, name }) => {
  await service.setReadOnly(false);
  const preview = await service.previewTable(name), review = service.reviewChangeSet(change(preview, { label: 'No write' }));
  const definition = service._editor.definition.bind(service._editor);
  let injected = false;
  service._editor.definition = async table => {
    const result = await definition(table);
    if (!injected) { injected = true; await observer.query('ALTER TABLE ' + q(name) + ' ADD extra_column int NULL'); }
    return result;
  };
  await assert.rejects(service.applyChangeSet({ reviewId: review.reviewId }), { code: 'ROCKETBRAIN_GRID_SCHEMA_CHANGED' });
  assert.equal((await observer.query('SELECT label FROM ' + q(name) + ' WHERE id=1'))[0][0].label, 'Alpha');
  assert.equal(service.getSessionState().inTransaction, false);
}));

live('LIVE GRID: trigger-bearing tables and views remain structurally readonly', () => withGrid(async ({ service, observer, name }) => {
  const trigger = name + '_trigger';
  await observer.query('CREATE TRIGGER ' + q(trigger) + ' BEFORE UPDATE ON ' + q(name) + ' FOR EACH ROW SET NEW.version=OLD.version+1');
  const preview = await service.previewTable(name);
  assert.equal(preview.edit.canEdit, false); assert.match(preview.edit.reason, /triggers/i);
  const view = await service.previewTable('active_people');
  assert.equal(view.edit.canEdit, false); assert.match(view.edit.reason, /Views/);
}));

live('LIVE GRID: refresh failure after mutation rolls back before commit and keeps the session usable', () => withGrid(async ({ service, observer, name }) => {
  await service.setReadOnly(false);
  const preview = await service.previewTable(name), review = service.reviewChangeSet(change(preview, { label: 'Must not commit' }));
  const originalPreview = service._editor._preview;
  service._editor._preview = async () => { throw Object.assign(new Error('Injected refresh failure'), { code: 'ROCKETBRAIN_TEST_REFRESH' }); };
  try { await assert.rejects(service.applyChangeSet({ reviewId: review.reviewId }), { code: 'ROCKETBRAIN_TEST_REFRESH' }); }
  finally { service._editor._preview = originalPreview; }
  assert.equal(service.getSessionState().connected, true); assert.equal(service.getSessionState().inTransaction, false);
  assert.equal((await observer.query('SELECT label FROM ' + q(name) + ' WHERE id=1'))[0][0].label, 'Alpha');
  assert.equal((await service.previewTable(name)).rows[0][1], 'Alpha');
}));
