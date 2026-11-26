'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { integer, normalizeCell, binding, acceptsCell, cellUpdateSql } = require('../src/db/sqlite-edit-values');
const { createSqliteCellEditor } = require('../src/db/sqlite-cell-editor');
const { selectSqliteEditRuntime } = require('../src/db/sqlite-edit-runtime');
const { renderCellReview } = require('../src/db/sqlite-edit-vscode');

test('SQLite cell models preserve exact decimal, Unicode, BLOB and NULL values in the reviewed wire format', () => {
  assert.equal(integer('-9223372036854775808'), '-9223372036854775808');
  assert.equal(binding(normalizeCell({ kind: 'INTEGER', value: '9223372036854775807' })), 9223372036854775807n);
  for (const value of ['9223372036854775808', '010', '1.0', '1e9', '--14']) assert.throws(() => integer(value), /integer/u);
  assert.equal(binding(normalizeCell({ kind: 'TEXT', value: '한\0글 🧪' })), '한\0글 🧪');
  assert.deepEqual(binding(normalizeCell({ kind: 'BLOB', value: '0x00FF80' })), Buffer.from([0, 255, 128]));
  assert.deepEqual(binding(normalizeCell({ kind: 'BLOB', value: '' })), Buffer.alloc(0));
  assert.throws(() => normalizeCell({ kind: 'BLOB', value: '0x0' }), /whole hexadecimal byte pairs/u);
  assert.equal(binding(normalizeCell({ kind: 'NULL', value: null })), null);
  assert.equal(Object.is(binding(normalizeCell({ kind: 'REAL', value: '-0.0' })), -0), true);
  assert.throws(() => normalizeCell({ kind: 'REAL', value: 'Infinity' }), /finite/u);
});

test('SQLite uses one shared reviewed UPDATE OR ABORT and permits only an editable typed cell', () => {
  const column = { editable: true, nullable: true, type: 'TEXT' };
  assert.equal(acceptsCell(column, { kind: 'NULL', value: null }), true);
  assert.equal(acceptsCell(column, { kind: 'TEXT', value: 'new' }), true);
  assert.equal(acceptsCell(column, { kind: 'BLOB', value: '00' }), false);
  assert.equal(acceptsCell({ ...column, editable: false }, { kind: 'TEXT', value: 'new' }), false);
  const sql = cellUpdateSql('시료;"값', 'content', 'row key');
  assert.equal(sql, 'UPDATE OR ABORT main."시료;""값" SET "content"=? WHERE "row key"=?');
  const review = { sql, fileName: 'sample.db', fileIdentity: 'file', schemaFingerprint: 'schema', rowFingerprint: 'row', keyColumn: 'row key',
    key: '9223372036854775807', column: 'content', previous: { kind: 'TEXT', value: 'before' }, replacement: { kind: 'TEXT', value: 'new\0text' } };
  const rendered = renderCellReview(review, { node: 'v22.23.5', sqlite: '3.54.1' });
  assert.ok(rendered.includes('new\\u0000text'));
  assert.ok(rendered.includes(sql + ';'));
});

test('an exact executable identity and trusted workspace are required before invoking SQLite cell editing', async t => {
  const root = await fs.realpath(os.tmpdir());
  const folder = await fs.mkdtemp(path.join(root, 'rocketbrain-sqlite-pin-test-'));
  const fake = path.join(folder, 'node.exe');
  await fs.writeFile(fake, 'fixture only');
  t.after(async () => { await fs.unlink(fake); await fs.rmdir(folder); });
  await assert.rejects(selectSqliteEditRuntime(fake), { code: 'ROCKETBRAIN_SQLITE_EDIT_RUNTIME' });
  const editor = createSqliteCellEditor({ isTrusted: () => false, currentSnapshot: () => assert.fail('No file selected before trust') });
  t.after(() => editor.dispose());
  await assert.rejects(editor.inspect({ table: 'owned', key: '1' }), { code: 'ROCKETBRAIN_SQLITE_EDIT_TRUST' });
  await assert.rejects(editor.apply('arbitrary-id', false), { code: 'ROCKETBRAIN_SQLITE_EDIT_TRUST' });
});
