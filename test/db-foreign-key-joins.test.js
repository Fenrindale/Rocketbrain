'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { foreignKeyJoins } = require('../src/db/foreign-key-joins');

function catalog() {
  return {
    database: 'fixture',
    coverage: { tables: 'loaded', columns: 'loaded', foreignKeys: 'loaded' },
    tables: [
      {
        name: 'employees', kind: 'table',
        columns: ['department_id', 'tenant_id', 'manager_id', 'id'].map(name => ({ name, type: 'int' })),
        foreignKeys: [
          { name: 'department_fk', referencedSchema: 'fixture', referencedTable: 'departments', columns: [
            { name: 'tenant_id', referencedColumn: 'tenant_id', ordinal: 2 },
            { name: 'department_id', referencedColumn: 'id', ordinal: 1 }
          ] },
          { name: 'manager_fk', referencedSchema: 'fixture', referencedTable: 'employees',
            columns: [{ name: 'manager_id', referencedColumn: 'id', ordinal: 1 }] }
        ]
      },
      { name: 'departments', kind: 'table', columns: ['id', 'tenant_id'].map(name => ({ name, type: 'int' })) }
    ]
  };
}

function complete(sql, snapshot = catalog()) {
  const offset = sql.indexOf('|');
  assert.ok(offset >= 0);
  const text = sql.replace('|', '');
  return foreignKeyJoins(text, offset, snapshot)
    .map(item => ({ ...item, inserted: text.slice(0, item.start) + item.insertText + text.slice(item.end) }));
}

test('JOIN completion builds a composite ON predicate in constraint order and adds the exact database', () => {
  const [result] = complete('SELECT * FROM employees emp LEFT OUTER JOIN dep| WHERE emp.id = 1;');
  assert.equal(result.label, 'departments via department_fk (emp)');
  assert.equal(result.inserted, 'SELECT * FROM employees emp LEFT OUTER JOIN `fixture`.`departments` ON ' +
    '`emp`.`department_id` = `departments`.`id` AND `emp`.`tenant_id` = `departments`.`tenant_id` WHERE emp.id = 1;');
  const inbound = complete('SELECT * FROM departments d INNER JOIN emp|')[0];
  assert.match(inbound.insertText, /`employees`\.`department_id` = `d`\.`id`/);
});

test('self-join completion gives the target a unique alias for each distinct direction', () => {
  const items = complete('SELECT * FROM employees JOIN emp|');
  assert.equal(items.length, 2);
  assert.ok(items.some(item => item.insertText.endsWith('AS `rb_join` ON `employees`.`manager_id` = `rb_join`.`id`')));
  assert.ok(items.some(item => item.insertText.endsWith('AS `rb_join` ON `rb_join`.`manager_id` = `employees`.`id`')));
});

test('FK JOIN generation stays out of comments, unrelated clauses and unobserved schemas', () => {
  for (const sql of [
    'SELECT * FROM employees CROSS JOIN |',
    'SELECT * FROM employees NATURAL LEFT JOIN |',
    'SELECT * FROM employees WHERE id = 1 JOIN |',
    'SELECT * FROM employees JOIN /*comment*/ |',
    'SELECT * FROM \x27JOIN |\x27',
    'USE other; SELECT * FROM employees JOIN |',
    'SELECT * FROM unknown_table JOIN |',
    'SELECT * FROM employees JOIN dep|artments'
  ]) assert.deepEqual(complete(sql), [], sql);
  const partial = catalog();
  partial.coverage.foreignKeys = 'unavailable';
  assert.deepEqual(complete('SELECT * FROM employees JOIN |', partial), []);
  const foreign = catalog();
  foreign.tables[0].foreignKeys[0].referencedSchema = 'other';
  assert.deepEqual(complete('SELECT * FROM employees JOIN dep|', foreign), []);
});

test('scoped JOIN maps explicit CTE and derived output names and leaves adjacent SQL untouched', () => {
  const source = 'SELECT 7;\nWITH seeds(key1,key2) AS (SELECT e.department_id,e.tenant_id FROM employees e), ' +
    'step AS (SELECT s.key1 AS ref,s.key2 FROM seeds s) SELECT COUNT(*) FROM ' +
    '(SELECT ref,key2 FROM step) y LEFT JOIN dep| WHERE y.key2=1;\nSELECT 8;';
  const [proposal] = complete(source);
  assert.equal(proposal.start, source.indexOf('dep|'));
  assert.equal(proposal.end, source.indexOf('|'));
  assert.ok(proposal.inserted.includes(' ON `y`.`ref` = `departments`.`id` AND `y`.`key2` = `departments`.`tenant_id` WHERE y.key2=1;'));
  assert.ok(proposal.inserted.startsWith('SELECT 7;\nWITH'));
  assert.ok(proposal.inserted.endsWith(';\nSELECT 8;'));
  const [nested] = complete('SELECT d.id FROM departments d WHERE EXISTS(SELECT e.id FROM employees e JOIN dep| WHERE e.department_id=d.id);');
  assert.match(nested.insertText, /`e`\.`department_id`/);
  assert.ok(nested.inserted.endsWith(' WHERE e.department_id=d.id);'));
});

test('JOIN suppresses dangling or ambiguous names, mixed lineage, and context-changing statement prefixes', () => {
  for (const sql of [
    'SELECT q.id FROM employees e JOIN dep|',
    'SELECT id FROM employees e JOIN dep|',
    'SELECT * FROM (SELECT * FROM employees e JOIN dep|) x',
    'SELECT q.id FROM employees q, (SELECT id FROM employees) q JOIN dep|',
    'SELECT * FROM employees AS JOIN dep|',
    'SELECT * FROM employees, JOIN dep|',
    'WITH x(a,b) AS (SELECT department_id+1,tenant_id FROM employees) SELECT * FROM x JOIN dep|',
    'WITH x(a,b) AS (SELECT department_id,tenant_id FROM employees UNION ALL SELECT id,tenant_id FROM departments) SELECT * FROM x JOIN dep|',
    'WITH x AS (SELECT department_id AS a,department_id AS b,tenant_id FROM employees) SELECT * FROM x JOIN dep|',
    'SET sql_mode=1; SELECT * FROM employees JOIN dep|',
    'SELECT * FROM employees JOIN dep| JOIN departments z ON 1=1'
  ]) assert.deepEqual(complete(sql), [], sql);
  const [sameLineage] = complete('WITH s(a,b) AS (SELECT department_id,tenant_id FROM employees UNION ALL ' +
    'SELECT department_id,tenant_id FROM employees) SELECT COUNT(*) FROM s JOIN dep|');
  assert.ok(sameLineage?.insertText);
});

test('scoped graph completion discovers exact remote origin and target identities and does not return stale evidence', async () => {
  const { scopedForeignKeyJoins } = require('../src/db/foreign-key-joins');
  const local = catalog();
  const remote = { schema: 'remote', ...local.tables[1] };
  const edge = { name: 'remote_department', kind: 'physical',
    child: { schema: 'fixture', table: 'employees' }, parent: { schema: 'remote', table: 'departments' },
    parts: [{ column: 'department_id', parentColumn: 'id', ordinal: 1 }, { column: 'tenant_id', parentColumn: 'tenant_id', ordinal: 2 }] };
  const calls = [];
  const observe = async request => {
    calls.push(request);
    return request.includeEdges === false ? { tables: [remote], edges: [] } :
      { tables: [{ schema: 'fixture', ...local.tables[0] }, remote], edges: [edge] };
  };
  const source = 'SELECT COUNT(*) FROM remote.departments d INNER JOIN fixture.emp';
  const [result] = await scopedForeignKeyJoins(source, source.length, local, {}, observe);
  assert.deepEqual(calls, [
    { endpoints: [{ schema: 'remote', table: 'departments' }], includeEdges: false },
    { endpoints: [{ schema: 'remote', table: 'departments' }] }
  ]);
  assert.equal(source.slice(result.start, result.end), 'fixture.emp');
  assert.ok(result.insertText.endsWith('`employees`.`department_id` = `d`.`id` AND `employees`.`tenant_id` = `d`.`tenant_id`'));
  let current = true;
  assert.deepEqual(await scopedForeignKeyJoins(source, source.length, local, {}, async request => {
    current = false;
    return observe(request);
  }, () => current), []);
  const statement = 'SELECT COUNT(*) FROM employees e JOIN remote.dep';
  const [outbound] = await scopedForeignKeyJoins(statement, statement.length, local, {}, observe);
  assert.ok(outbound.insertText.startsWith('`remote`.`departments`'));
});

test('configured relationship is labelled separately and may use keys visible through CTEs', async () => {
  const { scopedForeignKeyJoins } = require('../src/db/foreign-key-joins');
  const local = catalog();
  const sql = 'WITH a(k) AS (SELECT manager_id FROM employees) SELECT COUNT(*) FROM a JOIN dep';
  const edge = { kind: 'logical', name: 'Saved manager association', child: 'employees', parent: 'departments',
    pairs: [{ child: 'manager_id', parent: 'id' }] };
  const observe = async () => ({ tables: [{ schema: 'fixture', ...local.tables[0] }], edges: [] });
  const [result] = await scopedForeignKeyJoins(sql, sql.length, local, { logical: [edge] }, observe);
  assert.match(result.detail, /configured workspace relationship/);
  assert.match(result.insertText, /`a`\.`k` = `departments`\.`id`/);
  assert.deepEqual(await scopedForeignKeyJoins(sql, sql.length, local, {}, observe), []);
});

test('live graph reads exact bound schema/table identities in bounded batches', async () => {
  const { readJoinCatalog } = require('../src/db/join-catalog');
  const calls = [];
  const table = "quoted'table";
  const source = { schema: 'one', table };
  const remote = { schema: 'two', table: 'parent' };
  const graph = await readJoinCatalog(async (sql, values) => {
    calls.push({ sql, values });
    if (sql.includes('KEY_COLUMN_USAGE')) return { rows: [['one', table, 'fk', 'child', 1, 'two', 'parent', 'key'],
      ['ONE', table, 'unrelated', 'child', 1, 'x', 'x', 'x']] };
    if (sql.includes('information_schema.TABLES')) return { rows: [['one', table, 'BASE TABLE'], ['two', 'parent', 'BASE TABLE']] };
    return { rows: [['one', table, 'child', 'int', 'YES', null, null], ['two', 'parent', 'key', 'int', 'NO', null, null]] };
  }, 'one', { endpoints: [source] });
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0].values, ['one', table, 'one', table]);
  assert.ok(calls.every(call => !call.sql.includes(table) && /LIMIT \d+$/.test(call.sql)));
  assert.deepEqual(graph.edges.map(({ child, parent }) => [child, parent]), [[source, remote]]);
  assert.deepEqual(graph.tables.map(table => table.columns[0].name), ['child', 'key']);
  await assert.rejects(readJoinCatalog(async () => ({ rows: [], truncated: true }), 'one', { endpoints: [source] }), /bounded/);
});
