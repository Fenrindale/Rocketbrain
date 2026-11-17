'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { TableEditor, typedCell, columnKind, columnDefinition, equalRows, normalizedCreate } = require('../src/db/grid');
const column = (kind, type, extra = {}) => ({ name: 'value', kind, type, nullable: true, ...extra });
test('typed grid edits retain exact decimal/bigint, NULL vs JSON null and bytes without JS numeric conversion', () => {
  assert.equal(typedCell({ kind: 'value', text: '18446744073709551615' }, column('integer', 'bigint unsigned')).parameter, '18446744073709551615');
  assert.equal(typedCell('1234567890123456.12345678', column('decimal', 'decimal(24,8)')).parameter, '1234567890123456.12345678');
  assert.equal(typedCell({ kind: 'null' }, column('json', 'json')).parameter, null);
  assert.equal(typedCell({ kind: 'value', text: 'null' }, column('json', 'json')).parameter, 'null');
  assert.deepEqual(typedCell('0x00CAFEff', column('binary', 'blob')).parameter, Buffer.from([0, 202, 254, 255]));
  assert.deepEqual(typedCell('0x', column('binary', 'blob')).parameter, Buffer.alloc(0));
});
test('typed edit validation rejects overflow, precision loss, malformed bytes/JSON, forbidden NULL and ambiguous input', () => {
  for (const [value, definition] of [
    ['18446744073709551616', column('integer', 'bigint unsigned')], ['-1', column('integer', 'bigint unsigned')],
    ['128', column('integer', 'tinyint')], ['0.000000001', column('decimal', 'decimal(24,8)')],
    ['12345678901234567.00000000', column('decimal', 'decimal(24,8)')], ['0xabc', column('binary', 'blob')],
    ['{bad}', column('json', 'json')], [null, column('text', 'varchar(20)', { nullable: false })],
    [123, column('integer', 'int')], ['Infinity', column('float', 'double')], ['x'.repeat(128 * 1024 + 1), column('text', 'longtext')],
  ]) assert.throws(() => typedCell(value, definition), { code: 'ROCKETBRAIN_GRID_VALUE' });
});
test('generated, auto-increment and primary-key columns expose separate update/insert capabilities', () => {
  assert.deepEqual(columnDefinition(['id', 'bigint', 'NO', null, 'PRI', 'auto_increment', '']), {
    name: 'id', type: 'bigint', kind: 'integer', nullable: false, defaultValue: null, primaryKey: true, generated: false, autoIncrement: true, editable: false, insertable: false, required: false,
    extra: 'auto_increment', generationExpression: '', charset: null, collation: null,
  });
  const pk = columnDefinition(['id', 'bigint', 'NO', null, 'PRI', '', '']);
  assert.equal(pk.editable, false); assert.equal(pk.insertable, true); assert.equal(pk.required, true);
  const generated = columnDefinition(['computed', 'int', 'YES', null, '', 'STORED GENERATED', 'length(label)']);
  assert.equal(generated.editable, false); assert.equal(generated.insertable, false);
  assert.equal(columnKind('geometry'), 'unsupported');
});
test('catalog fingerprint ignores only the live AUTO_INCREMENT counter while keeping generated expressions and quoted defaults exact', () => {
  const a = "CREATE TABLE t (id bigint AUTO_INCREMENT, label varchar(30) DEFAULT 'AUTO_INCREMENT=8') ENGINE=InnoDB AUTO_INCREMENT=3";
  const b = "CREATE TABLE t (id bigint AUTO_INCREMENT, label varchar(30) DEFAULT 'AUTO_INCREMENT=8') ENGINE=InnoDB AUTO_INCREMENT=99";
  assert.equal(normalizedCreate(a), normalizedCreate(b));
  assert.notEqual(normalizedCreate(a), normalizedCreate(b.replace("'AUTO_INCREMENT=8'", "'AUTO_INCREMENT=9'")));
  assert.notEqual(normalizedCreate('CREATE TABLE t(x int AS(length(label)))'), normalizedCreate('CREATE TABLE t(x int AS(length(label)+1))'));
});
test('review generates SQL from private metadata/snapshot, rejects forged identities, duplicate rows and read-only columns', () => {
  const state = { id: 's', readOnly: false, connectionId: 7 };
  const editor = new TableEditor({ _options: { database: 'app' }, _session: id => { assert.equal(id, 's'); return state; } });
  const model = { modelId: 'm', sessionId: 's', connectionId: 7, canEdit: true, created: Date.now(), definition: { name: 't', columns: [
    { name: 'id', kind: 'integer', type: 'bigint', primaryKey: true, editable: false, insertable: true, nullable: false, required: true },
    { name: 'label', kind: 'text', type: 'varchar(40)', editable: true, insertable: true, nullable: true },
  ] }, rows: new Map([['row', ['9007199254740993', 'old']]]) };
  editor.models.set('m', model);
  const hostile = "'; DELETE FROM t; --";
  const reviewed = editor.reviewChangeSet({ sessionId: 's', modelId: 'm', updates: [{ rowId: 'row', values: { label: hostile } }], table: 'untrusted_table', sql: 'DROP TABLE app' });
  assert.equal(reviewed.statements.length, 1); assert.ok(!reviewed.statements[0].sql.includes(hostile));
  assert.deepEqual(reviewed.statements[0].parameters, [hostile, '9007199254740993']);
  assert.ok(reviewed.statements[0].sql.includes('UPDATE ' + String.fromCharCode(96) + 'app'));
  assert.throws(() => editor.reviewChangeSet({ sessionId: 's', modelId: 'm', updates: [{ rowId: 'forged', values: { label: 'x' } }] }), { code: 'ROCKETBRAIN_GRID_ROW' });
  assert.throws(() => editor.reviewChangeSet({ sessionId: 's', modelId: 'm', updates: [{ rowId: 'row', values: { id: '3' } }] }), { code: 'ROCKETBRAIN_GRID_COLUMN' });
  assert.throws(() => editor.reviewChangeSet({ sessionId: 's', modelId: 'm', deletes: ['row', 'row'] }), { code: 'ROCKETBRAIN_GRID_ROW' });
  state.readOnly = true;
  assert.throws(() => editor.reviewChangeSet({ sessionId: 's', modelId: 'm', deletes: ['row'] }), { code: 'ROCKETBRAIN_READ_ONLY' });
  assert.equal(equalRows([null, '0x00', '1'], [null, '0x00', 1]), false);
});
test('host-retained snapshot survives hours while released and ordinary snapshots expire; reviews can be renewed', t => {
  const now = 1700000000000;
  t.mock.method(Date, 'now', () => now);
  const state = { id: 's', readOnly: false, connectionId: 7, connected: true, needsReconnect: false };
  const editor = new TableEditor({ _options: { database: 'app' }, _session: () => state });
  const model = id => ({ modelId: id, sessionId: 's', connectionId: 7, canEdit: true, created: now, definition: { name: 't', columns: [
    { name: 'id', kind: 'integer', type: 'int', primaryKey: true, editable: false, insertable: true, nullable: false, required: true },
    { name: 'label', kind: 'text', type: 'varchar(40)', editable: true, insertable: true, nullable: true },
  ] }, rows: new Map([['row', [1, 'original']]]) });
  editor.models.set('kept', model('kept')); editor.models.set('ordinary', model('ordinary'));
  assert.deepEqual(editor.retainTableSnapshot({ sessionId: 's', modelId: 'kept' }), { sessionId: 's', modelId: 'kept', retained: true });
  const changes = { sessionId: 's', modelId: 'kept', updates: [{ rowId: 'row', values: { label: 'draft' } }] };
  const first = editor.reviewChangeSet(changes);
  Date.now.mock.mockImplementation(() => now + 3 * 60 * 60 * 1000);
  editor._prune();
  assert.equal(editor.models.has('kept'), true); assert.equal(editor.models.has('ordinary'), false);
  assert.equal(editor.reviews.has(first.reviewId), false);
  const second = editor.reviewChangeSet(changes);
  assert.ok(second.reviewId); assert.notEqual(second.reviewId, first.reviewId);
  assert.equal(editor.releaseTableSnapshot({ sessionId: 'other', modelId: 'kept' }), false);
  assert.equal(editor.models.has('kept'), true);
  assert.equal(editor.releaseTableSnapshot({ sessionId: 's', modelId: 'kept' }), true);
  assert.equal(editor.models.has('kept'), false);
});
test('retention is connection-bound, bounded and cannot prevent invalidation or capacity eviction of ordinary models', t => {
  const now = 1700000000000;
  t.mock.method(Date, 'now', () => now);
  const state = { id: 's', connectionId: 7, connected: true, needsReconnect: false };
  const editor = new TableEditor({ _session: () => state });
  for (let i = 0; i < 17; i++) editor.models.set(String(i), { modelId: String(i), sessionId: 's', connectionId: 7, created: now });
  for (let i = 0; i < 16; i++) editor.retainTableSnapshot({ sessionId: 's', modelId: String(i) });
  assert.doesNotThrow(() => editor.retainTableSnapshot({ sessionId: 's', modelId: '0' }));
  assert.throws(() => editor.retainTableSnapshot({ sessionId: 's', modelId: '16' }), { code: 'ROCKETBRAIN_GRID_RETENTION_LIMIT' });
  for (let i = 17; i < 60; i++) editor.models.set(String(i), { modelId: String(i), sessionId: 's', connectionId: 7, created: now });
  editor._prune(); assert.equal(editor.models.size, 40);
  for (let i = 0; i < 16; i++) assert.equal(editor.models.has(String(i)), true);
  state.connectionId = 8;
  assert.throws(() => editor.retainTableSnapshot({ sessionId: 's', modelId: '0' }), { code: 'ROCKETBRAIN_GRID_STALE' });
  assert.equal(editor.releaseTableSnapshot({ sessionId: 's', modelId: '0' }), false);
  editor.invalidate('s'); assert.equal(editor.models.size, 0);
  editor.db._session = () => { throw new Error('closed'); };
  assert.equal(editor.releaseTableSnapshot({ sessionId: 's', modelId: '0' }), false);
});
