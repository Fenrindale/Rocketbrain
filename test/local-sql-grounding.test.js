'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { relationshipOptions, projectGrounding, compileGroundedQuery, prepareGroundedRequest } = require('../src/db/local-sql-grounding');
const { explanationHtml } = require('../src/db/explain-plan-view');

const column = (name, type = 'int') => ({ name, type });
const key = (table, name, pairs) => ({ name, referencedTable: table, referencedSchema: 'work', columns:
  pairs.map(([column, target], index) => ({ name: column, referencedColumn: target, ordinal: index + 1 })) });
const table = (name, columns, foreignKeys = []) => ({ name, kind: 'table', engine: 'InnoDB', columns, foreignKeys });
const catalog = { database: 'work', dialect: 'mariadb', serverVersion: '11.4', sqlMode: ['STRICT_TRANS_TABLES'],
  semanticContextObserved: true, coverage: { tables: 'loaded', columns: 'loaded', foreignKeys: 'loaded' }, tables: [
    table('orders', [column('account'), column('ord'), column('total'), column('unselected')],
      [key('accounts', 'composite', [['account', 'acct'], ['ord', 'branch']])]),
    table('accounts', [column('acct'), column('branch'), column('location'), { ...column('virtual'), extra: 'VIRTUAL GENERATED' }],
      [key('regions', 'location', [['location', 'code']])]),
    table('regions', [column('code'), { ...column('name', "enum('fixture-value')"), defaultValue: 'fixture-value' }]),
    { ...table('redirected', [column('id')]), kind: 'view' } ] };
const [first, second] = relationshipOptions(catalog);
const choices = { root: 'orders', edgeIds: [first.id, second.id], selections: [
  { table: 'orders', columns: ['total'] }, { table: 'accounts', columns: ['acct'] }, { table: 'regions', columns: ['name'] }
] };
const plan = { columns: ['regions.name'], measures: [{ column: 'orders.total', function: 'SUM' }],
  sort: [{ key: 'SUM(orders.total)', direction: 'DESC' }], limit: 25, explanation: 'Totals by region' };

test('full composite and chained keys are compiled rather than inferred from model SQL', () => {
  const scope = projectGrounding(catalog, choices);
  const result = compileGroundedQuery(scope, plan);
  assert.equal(result.sql, ['SELECT t3.`name` AS c1, SUM(t1.`total`) AS m1', 'FROM `work`.`orders` AS t1',
    'INNER JOIN `work`.`accounts` AS t2 ON t1.`account` = t2.`acct` AND t1.`ord` = t2.`branch`',
    'INNER JOIN `work`.`regions` AS t3 ON t2.`location` = t3.`code`', 'GROUP BY t3.`name`', 'ORDER BY m1 DESC', 'LIMIT 25'].join('\n'));
  assert.equal(result.execution, 'not-run');
  const backward = projectGrounding(catalog, { ...choices, root: 'regions', edgeIds: [second.id, first.id] });
  assert.match(compileGroundedQuery(backward, plan).sql, /t3\.`account` = t2\.`acct` AND t3\.`ord` = t2\.`branch`/);
  assert.throws(() => projectGrounding(catalog, { ...choices, root: 'regions' }), /connected route/);
  assert.throws(() => projectGrounding(catalog, { ...choices, edgeIds: [first.id, first.id] }), /distinct/);
});

test('hidden rows, other objects, defaults, and the prior explanation stay out of refinement payloads', () => {
  const scope = projectGrounding(catalog, choices);
  const endpoint = 'http://127.0.0.1:3000/v1/chat/completions';
  const previous = { sql: 'SELECT fixture-sentinel', plan: { ...plan, explanation: 'fixture-sentinel' } };
  const request = prepareGroundedRequest({ endpoint, model: 'fixture', context: scope, input: 'Reverse the order', previous });
  assert.deepEqual(request.preview.previousPlan.sort, plan.sort);
  for (const omitted of ['fixture-value', 'unselected', 'redirected', 'fixture-sentinel', 'composite']) {
    assert.ok(!JSON.stringify(request.preview).includes(omitted));
  }
  assert.throws(() => prepareGroundedRequest({ endpoint: endpoint.replace('127.0.0.1','example.invalid'), model: 'fixture', context: scope, input: 'test' }), /loopback/);
});

test('raw SQL, unsupported aggregate types, unavailable or generated columns and extra plan fields are rejected', () => {
  const scope = projectGrounding(catalog, choices);
  for (const invalid of [{ ...plan, join: 'OR TRUE' }, { ...plan, limit: 501 }, { ...plan, columns: ['orders.unselected'] },
    { ...plan, measures: [{ column: 'regions.name', function: 'SUM' }] }, { ...plan, columns: ['accounts.virtual'] },
    { ...plan, sort: [{ key: 'orders.total', direction: 'ASC' }] }, { ...plan, columns: [], measures: [] },
    { ...plan, explanation: '<text>\n' }]) assert.throws(() => compileGroundedQuery(scope, invalid));
  assert.throws(() => projectGrounding(catalog, { ...choices, selections: [choices.selections[0],
    { table: 'accounts', columns: ['virtual'] }, choices.selections[2]] }), /observed ordinary/);
});

test('exact schema changes alter the plan binding, unselected fields and enumeration literal types are not shared', () => {
  const scope = projectGrounding(catalog, choices);
  const changed = structuredClone(catalog);
  changed.tables[0].columns.find(item => item.name === 'total').type = 'bigint';
  assert.notEqual(projectGrounding(changed, choices).fingerprint, scope.fingerprint);
  changed.tables[0].columns.find(item => item.name === 'total').type = 'int';
  changed.tables[0].columns.find(item => item.name === 'unselected').type = 'bigint';
  assert.equal(projectGrounding(changed, choices).fingerprint, scope.fingerprint);
  changed.tables[0].foreignKeys[0].columns[1].ordinal = 3;
  assert.throws(() => projectGrounding(changed, choices), /reviewed key/);
  assert.throws(() => relationshipOptions({ ...catalog, coverage: { ...catalog.coverage, foreignKeys: 'unavailable' } }), /live MySQL or MariaDB/);
});

test('the plan viewer preserves normal tree and JSON controls without offering an unavailable second database capture', () => {
  const report = { engine: 'mysql', database: 'work', version: '8.4.13', nodes: [], rootIds: [], warnings: [], raw: '{}' };
  assert.match(explanationHtml(report, { nonce: 'test' }), /data-view="raw-tree"/);
  const html = explanationHtml(report, { nonce: 'test', allowTreeCapture: false });
  assert.doesNotMatch(html, /data-view="raw-tree"/);
  assert.match(html, /data-view="raw"/);
  assert.match(html, /data-view="table"/);
});
