'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { inspectPreparedTemplate, validatePreparedTemplate } = require('../src/db/schema-prepared-template');

const sql = 'UPDATE app.target AS t INNER JOIN ref.lookup AS l ON t.group_id=l.tenant AND l.item=t.id ' +
  'SET t.amount=l.delta+? WHERE t.id=?';
const columns = (...names) => names.map(name => ({ name, type: 'int(11)', nullable: false }));
const key = (...names) => ({ unique: true, type: 'BTREE', columns: names.map(name => ({ name, prefixLength: null })) });

function tables() {
  return [
    { schema: 'app', name: 'target', kind: 'table', engine: 'InnoDB', columns: columns('id', 'amount', 'group_id'), indexes: [key('id')] },
    { schema: 'ref', name: 'lookup', kind: 'table', engine: 'InnoDB', columns: columns('item', 'tenant', 'delta'), indexes: [key('item', 'tenant')] }
  ];
}

test('finite prepared UPDATE JOIN binds both physical reads, preserves composite equality order and writes the first table', () => {
  const template = inspectPreparedTemplate(sql, 'app');
  assert.equal(template.ast.format, 'RocketbrainPreparedJoinUpdate');
  assert.equal(template.placeholders, 2);
  assert.equal(template.returnsRows, false);
  assert.deepEqual(template.ast.keys, [{ target: 'group_id', lookup: 'tenant' }, { target: 'id', lookup: 'item' }]);
  assert.deepEqual(template.ast.readTargets, [{ schema: 'app', table: 'target' }, { schema: 'ref', table: 'lookup' }]);
  assert.deepEqual(template.ast.writeTargets, [{ schema: 'app', table: 'target' }]);
  validatePreparedTemplate(template, { database: 'app', tables: tables() });
  const changed = structuredClone(template);
  changed.ast.writeTargets = [{ schema: 'ref', table: 'lookup' }];
  assert.throws(() => validatePreparedTemplate(changed, { database: 'app', tables: tables() }), /template changed/);
  assert.doesNotThrow(() => validatePreparedTemplate(inspectPreparedTemplate('UPDATE target SET amount=? WHERE id=?', 'app'),
    { database: 'app', tables: tables() }));
});

test('prepared JOIN rejects implicit cross-table targets, nonportable constructs and unproven metadata', () => {
  for (const proposed of [
    sql.replace('INNER JOIN', 'LEFT JOIN'), sql.replace('t.amount=', 'l.delta='),
    sql.replace('t.id=?', 'l.item=?'), sql.replace('l.item=t.id', 'l.tenant=t.id'),
    sql.replace('l.delta+?', 'ABS(l.delta)+?'), sql.replace('l.delta+?', 'l.delta+? , t.id=?'),
    sql.replace('l.delta+?', 'l.delta+@extra'), sql + ' UNION SELECT 1', sql + '; SELECT 1',
    sql.replace('ref.lookup', 'app.target'), 'WITH t AS (SELECT 1) ' + sql,
  ]) assert.throws(() => inspectPreparedTemplate(proposed, 'app'), /UPDATE JOIN|first table|distinct columns|one statically/u, proposed);
  const template = inspectPreparedTemplate(sql, 'app');
  const cases = [
    (target, lookup) => { lookup.indexes[0].unique = false; },
    (target, lookup) => { lookup.indexes[0].columns[0].prefixLength = 2; },
    (target, lookup) => { lookup.indexes[0].columns.push({ name: 'delta' }); },
    (target, lookup) => { lookup.columns[0].nullable = true; },
    (target, lookup) => { lookup.columns[0].type = 'int unsigned'; },
    (target, lookup) => { lookup.kind = 'view'; },
    target => { target.columns[1].generationExpression = 'id+1'; },
    target => { target.indexes.push(key('amount')); },
    target => { target.columns[0].type = 'varchar(50)'; },
    target => { target.columns[2].name = 'old_group_id'; },
  ];
  for (const mutate of cases) {
    const current = tables();
    mutate(...current);
    assert.throws(() => validatePreparedTemplate(template, { database: 'app', tables: current }),
      /unique lookup|matching integer|ordinary integer|unindexed|InnoDB base/u);
  }
});
