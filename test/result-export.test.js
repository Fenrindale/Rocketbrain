'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createResultExport } = require('../src/db/result-export');
const { inspectXlsx, sheetToImport } = require('../src/db/grid-xlsx');

const field = (type, characterSet = 45) => ({ type, characterSet });
const mixed = {
  columns: ['id', 'amount', 'literal', 'raw', 'bits', 'when_at', 'options', 'flag', 'unset', 'empty'],
  fields: [field(8), field(246), field(253), field(252, 63), field(16), field(12), field(245), field(1), field(6), field(253)],
  rows: [['18446744073709551615', '1234567890123456.12345678', "=1+1\\한글'\r\n_x0041_", '0x00cafe', '0x0f',
    '2025-11-16 12:00:00.000001', '{"exact":9007199254740993}', 1, null, '']],
  truncated: true,
  browse: { page: 1, pageSize: 500, hasNext: true }
};

test('typed JSON preserves duplicate headings, raw JSON numerics, binary hex, exact decimals, SQL NULL and signed zero', () => {
  const result = { ...mixed, columns: ['id', 'amount', 'id', ...mixed.columns.slice(3)] };
  const { data, extension } = createResultExport(result, 'json');
  assert.equal(extension, 'json');
  const json = JSON.parse(data.toString('utf8'));
  assert.deepEqual(json.rows, mixed.rows);
  assert.equal(json.columns[0].name, json.columns[2].name);
  assert.deepEqual(json.columns.map(column => column.kind), ['integer', 'decimal', 'text', 'binary-hex', 'bit', 'temporal',
    'json-text', 'integer', 'null', 'text']);
  assert.deepEqual([json.page, json.pageSize, json.hasNext, json.truncated], [2, 500, true, true]);
  const exact = JSON.parse(createResultExport({ columns: ['x'], rows: [[-0]] }, 'json').data.toString());
  assert.ok(Object.is(exact.rows[0][0], -0));
});

test('Excel export creates a readable no-formula workbook with complete literal and exact values', async () => {
  const { data, extension } = createResultExport(mixed, 'xlsx');
  assert.equal(extension, 'xlsx');
  const workbook = await inspectXlsx(data);
  const sheet = sheetToImport(workbook, { sheetId: workbook.sheets[0].id, blankPolicy: 'null' });
  assert.deepEqual(sheet.headers, mixed.columns);
  assert.equal(sheet.formulaCount, 0);
  assert.deepEqual(sheet.rows[0], mixed.rows[0].map(value => value === null ? '' : String(value)));
  assert.deepEqual(sheet.nulls[0], [false, false, false, false, false, false, false, false, true, false]);
  const over = { columns: ['text'], rows: [['a'.repeat(32768)]] };
  assert.throws(() => createResultExport(over, 'xlsx'), /Excel text cell limit/);
  assert.equal(JSON.parse(createResultExport(over, 'json').data.toString()).rows[0][0].length, 32768);
});

test('INSERT quotes identifiers, preserves literals without SQL-mode-dependent escaping and rejects uncertain mappings', () => {
  const names = ['id', 'amount', 'te`xt', ...mixed.columns.slice(3)];
  const { data } = createResultExport(mixed, 'insert', { schema: 'my schema', table: 'ta`ble', columns: names });
  const sql = data.toString('utf8');
  assert.match(sql, /captured result rows \(table page 2\)/);
  assert.match(sql, /preview may omit rows/);
  assert.ok(sql.includes("INSERT INTO `my schema`.`ta``ble` (`id`, `amount`, `te``xt`"));
  assert.ok(sql.includes("VALUES (18446744073709551615, 1234567890123456.12345678, CONVERT(X'"));
  assert.ok(sql.includes("X'00cafe', b'1111'"));
  assert.ok(sql.includes("1, NULL, CONVERT(X'' USING utf8mb4))"));
  assert.ok(!sql.includes(mixed.rows[0][2]));
  const make = (value, type) => ({ columns: ['value'], rows: [[value]], fields: [field(type)] });
  assert.throws(() => createResultExport(make('1; DROP TABLE other', 8), 'insert', { table: 'target' }), /lossless INSERT/);
  assert.throws(() => createResultExport(make('{"x":1}', 255), 'insert', { table: 'target' }), /lossless INSERT/);
  assert.throws(() => createResultExport(mixed, 'insert', { table: 'foo.bar' }), /separately/);
  assert.throws(() => createResultExport({ columns: ['column'], rows: [[12]] }, 'insert', { table: 'target' }), /metadata/);
  assert.throws(() => createResultExport(mixed, 'insert', { table: 'target', columns: names.map(() => 'd') }), /one unique/);
});
