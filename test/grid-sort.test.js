'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { browseQuery } = require('../src/db/grid');
const { observeSortCollations, sortOptions } = require('../src/db/grid-sort');
const { createResultSorts } = require('../src/db/result-sorts');

const columns = [
  { name: 'pk', kind: 'text', type: 'varchar(20)', charset: 'utf8mb4', collation: 'utf8mb4_bin', primaryKey: true, nullable: false },
  { name: 'label', kind: 'text', type: 'varchar(80)', charset: 'utf8mb4', collation: 'utf8mb4_bin', nullable: true },
  { name: 'amount', kind: 'decimal', type: 'decimal(14,4)', nullable: true },
  { name: 'odd`blob', kind: 'binary', type: 'longblob', nullable: true },
  { name: 'flag', kind: 'binary', type: 'varbinary(100)', nullable: true },
  { name: 'data', kind: 'json', type: 'json', nullable: true },
  { name: 'shape', kind: 'unsupported', type: 'geography', nullable: true }
];
const definition = { name: 'fixture', columns };
const collations = { utf8mb4: ['utf8mb4_bin', 'utf8mb4_general_ci'], latin1: ['latin1_general_ci'] };
const options = sortOptions(columns, collations);

test('advanced ordering compiles verified NULLs, collation and expression with raw primary key ties', () => {
  const sort = [{ column: 'pk', direction: 'desc', nulls: 'last', collation: 'utf8mb4_general_ci', expression: 'LOWER(pk)' },
    { column: 'amount', direction: 'asc', nulls: 'first', expression: 'ABS(amount)*2+3' }];
  const plan = browseQuery(definition, { sort, page: 1, pageSize: 25 }, 'app', false, collations);
  assert.deepEqual(plan.query.sort, sort);
  assert.deepEqual(plan.order, [...sort, { column: 'pk', direction: 'asc' }]);
  assert.ok(plan.sql.endsWith('ORDER BY ((LOWER(`pk`) COLLATE utf8mb4_general_ci) IS NULL) ASC,(LOWER(`pk`) COLLATE utf8mb4_general_ci) DESC,(((ABS(`amount`) * 2) + 3) IS NULL) DESC,((ABS(`amount`) * 2) + 3) ASC,`pk` ASC LIMIT 26 OFFSET 25'));
  const prefixes = options.columns.filter(option => option.expression).map(option => ({
    column: option.name, direction: 'asc', expression: option.expression
  }));
  assert.deepEqual(prefixes.map(rule => rule.column), ['odd`blob', 'data']);
  const bytePlan = browseQuery(definition, { sort: [...prefixes, { column: 'flag', direction: 'desc' }] }, 'app');
  assert.ok(bytePlan.sql.endsWith('ORDER BY LEFT(CAST(`odd``blob` AS BINARY),512) ASC,LEFT(CAST(`data` AS BINARY),512) ASC,`flag` DESC,`pk` ASC LIMIT 201 OFFSET 0'));
});

test('sorting recognizes only typed, bounded expressions and collation identities observed for their output charset', () => {
  for (const change of [
    { nulls: 'auto' }, { collation: 'latin1_general_ci' }, { collation: 'utf8mb4_bin;SELECT 1' },
    { expression: 'CHAR_LENGTH(label)', collation: 'utf8mb4_bin' }, { expression: 'LOWER(amount)' }, { expression: 'LOWER(label) /* note */' },
    { expression: 'pg_sleep(label)' }, { expression: '(SELECT label)' }, { expression: 'label + 10' },
    { expression: 'ABS(amount)' }, { expression: 'LOWER(shape)' }, { expression: 'JSON_TEXT(label)' },
    { expression: '('.repeat(20) + 'label' + ')'.repeat(20) }, { expression: 'B'.repeat(257) }, { sql: 'label' }
  ]) {
    assert.throws(() => browseQuery(definition, { sort: [{ column: 'label', direction: 'asc', ...change }] }, 'app', false, collations));
  }
  assert.throws(() => browseQuery(definition, { sort: [{ column: 'data', direction: 'asc' }] }, 'app'));
  assert.throws(() => browseQuery(definition, { sort: [{ column: 'shape', direction: 'asc' }] }, 'app'));
  assert.throws(() => browseQuery(definition, { sort: [{ column: 'label', direction: 'asc', collation: 'utf8mb4_bin' }] }, 'app'), /observed/);
});

test('collation options are bounded, server-observed, and tied to an exact character set', async () => {
  const reads = [];
  const result = await observeSortCollations(columns, async (sql, parameters) => {
    reads.push({ sql, parameters });
    return [['utf8mb4_bin', 'utf8mb4'], ['utf8mb4_bin', 'utf8mb4'], ['forged name', 'utf8mb4'], ['latin1_bin', 'latin1']];
  });
  assert.deepEqual(reads[0].parameters, ['utf8mb4']);
  assert.match(reads[0].sql, /CHARACTER_SET_NAME IN \(\?\)/);
  assert.deepEqual(Object.entries(result), [['utf8mb4', ['utf8mb4_bin']]]);
  assert.deepEqual(Object.entries(await observeSortCollations(columns, async () => { throw Error('unavailable'); })), []);
  assert.deepEqual(Object.entries(await observeSortCollations(columns, async () => Array(2049).fill(['utf8mb4_bin', 'utf8mb4']))), []);
});

test('persisted sort order is scoped by connection and table and revalidated against all referenced metadata', async () => {
  let stored;
  const memento = { get: () => stored, async update(key, value) { stored = structuredClone(value); } };
  const sorts = createResultSorts(memento);
  const named = [{ column: 'amount', direction: 'desc', nulls: 'last', expression: 'ABS(amount)' },
    { column: 'label', direction: 'asc', collation: 'utf8mb4_bin' }];
  await Promise.all([sorts.save('connectionA.table', 'Team default', named, columns, options),
    sorts.save('connectionB.table', 'Team default', [named[1]], columns, options)]);
  const reopened = createResultSorts(memento);
  assert.deepEqual(reopened.list('connectionA.table', columns, options), [{ name: 'Team default', sort: named, applicable: true }]);
  assert.deepEqual(reopened.list('connectionB.table', columns, options)[0].sort, [named[1]]);
  const changed = columns.map(column => column.name === 'amount' ? { ...column, type: 'decimal(20,4)' } : column);
  assert.deepEqual(reopened.list('connectionA.table', changed, options), [{ name: 'Team default', sort: undefined, applicable: false }]);
  assert.equal(reopened.list('connectionA.table', columns, { collations: {} })[0].applicable, false);
  await reopened.remove('connectionA.table', 'TEAM DEFAULT');
  assert.deepEqual(reopened.list('connectionA.table', columns, options), []);
  assert.equal(reopened.list('connectionB.table', columns, options).length, 1);
});
