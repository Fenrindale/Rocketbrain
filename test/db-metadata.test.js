'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readMetadata } = require('../src/db/metadata');
const { completeSql } = require('../src/db/completion');
test('metadata model preserves composite identities and reports unavailable areas separately from absence', async () => {
  const calls = [];
  const query = async (sql, values) => {
    calls.push(values);
    if (sql.includes('information_schema.TABLES')) return { rows: [['t', 'BASE TABLE', 'InnoDB', 'utf8mb4_bin', '']] };
    if (sql.includes('information_schema.COLUMNS')) return { rows: [['t', 'id', 'bigint unsigned', 'NO', null, 'PRI', '', 1, '', null, null]] };
    if (sql.includes('information_schema.STATISTICS')) return { rows: [['t', 'PRIMARY', 0, 1, 'id', null, 'BTREE', 'A'], ['t', 'composite', 0, 1, 'id', null, 'BTREE', 'A'], ['t', 'composite', 0, 2, 'name', null, 'BTREE', 'A']] };
    if (sql.includes('information_schema.ROUTINES')) throw Object.assign(new Error('Routine access denied'), { code: 'ER_ACCESS_DENIED_ERROR' });
    return { rows: [] };
  };
  const catalog = await readMetadata(query, "db'name", 7);
  assert.equal(catalog.revision, 7); assert.equal(catalog.tables[0].indexes[1].columns.length, 2);
  assert.equal(catalog.tables[0].columns[0].nullable, false);
  assert.equal(catalog.coverage.routines, 'unavailable'); assert.equal(catalog.complete, false);
  assert.equal(catalog.coverage.triggers, 'loaded'); assert.equal(catalog.warnings[0].area, 'routines');
  assert.ok(calls.every(values => values.length === 1 && values[0] === "db'name"));
});
test('metadata completion resolves a flat SELECT alias and escapes identifiers', () => {
  const schema = [{ name: 'people', columns: [{ name: 'id', type: 'bigint' }, { name: 'name', type: 'varchar(100)' }] }, { name: 'order', columns: [{ name: 'select', type: 'int' }] }];
  const source = 'SELECT p.na FROM people AS p';
  const items = completeSql(source, source.indexOf('na') + 2, schema);
  assert.deepEqual(items.map(item => item.label), ['name']);
  assert.equal(items[0].insertText, String.fromCharCode(96) + 'name' + String.fromCharCode(96));
  assert.ok(completeSql('SELECT * FROM ord', 17, schema).some(item => item.label === 'order'));
  assert.deepEqual(completeSql('SELECT unknown.', 15, schema), []);
});
test('completion declines CTE/nested alias binding instead of inventing references', () => {
  const schema = [{ name: 'people', columns: [{ name: 'id', type: 'int' }] }];
  const source = 'WITH p AS (SELECT * FROM people) SELECT p.';
  assert.deepEqual(completeSql(source, source.length, schema), []);
});
test('completion does not suggest names inside literals, comments or an unfinished quote', () => {
  const schema = [{ name: 'people', columns: [{ name: 'id', type: 'int' }] }];
  for (const source of ["SELECT 'people.'", "SELECT 'people.", 'SELECT 1 -- people.', 'SELECT 1 /* people.']) {
    const offset = source.endsWith("'") ? source.length - 1 : source.length;
    assert.deepEqual(completeSql(source, offset, schema), [], source);
  }
});
