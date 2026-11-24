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
