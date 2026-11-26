'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { inspectPreparedTemplate, validatePreparedTemplate, supportsPreparedCteUpdate } = require('../src/db/schema-prepared-template');

const mysql = { dialect: 'mysql', version: '8.4.13' };
const maria = { dialect: 'mariadb', version: '12.3.4-MariaDB' };
const sql = 'WITH source_rows AS (SELECT p.tenant AS grp, p.id AS item, p.val AS data FROM lookup.physical AS p WHERE p.tenant=?) ' +
  'UPDATE app.target AS t INNER JOIN source_rows AS s ON t.tenant=s.grp AND t.id=s.item SET t.amount=s.data+? WHERE t.id=?';
const parse = (text = sql, server = mysql) => inspectPreparedTemplate(text, 'app', '', server);
const columns = (...names) => names.map(name => ({ name, type: 'INT', nullable: false }));
const unique = (...names) => ({ unique: true, type: 'BTREE', columns: names.map(name => ({ name, prefixLength: null })) });

function tables() {
  return [
    { schema: 'app', name: 'target', kind: 'table', engine: 'InnoDB', columns: columns('tenant', 'id', 'amount'), indexes: [unique('id')] },
    { schema: 'lookup', name: 'physical', kind: 'table', engine: 'InnoDB', columns: columns('tenant', 'id', 'val'), indexes: [unique('id', 'tenant')] }
  ];
}

test('a single direct CTE projects a physical composite key with a bound filter and resolves independently on both engines', () => {
  const template = parse();
  assert.deepEqual(template, parse(sql, maria));
  assert.deepEqual(template.ast.cte, {
    name: 'source_rows',
    from: { table: { schema: 'lookup', table: 'physical' }, alias: 'p' },
    projections: [{ column: 'tenant', output: 'grp' }, { column: 'id', output: 'item' }, { column: 'val', output: 'data' }],
    filter: { column: 'tenant', value: { kind: 'parameter' } }
  });
  assert.equal(template.placeholders, 3);
  assert.equal(template.returnsRows, false);
  assert.deepEqual(template.ast.readTargets, [{ schema: 'app', table: 'target' }, { schema: 'lookup', table: 'physical' }]);
  assert.deepEqual(template.ast.writeTargets, [{ schema: 'app', table: 'target' }]);
  for (const server of [mysql, maria]) validatePreparedTemplate(template, { database: 'app', tables: tables(), server });
  assert.equal(parse(sql.replace(' WHERE p.tenant=?', '')).ast.cte.filter, null);
  assert.deepEqual(parse(sql.replace('p.tenant=?', 'p.tenant=-5')).ast.cte.filter.value, { kind: 'integer', value: '-5' });
});

test('CTE support requires observed compatible dialect and version in both analysis and saved template validation', () => {
  for (const server of [null, { dialect: 'mariadb', version: '11.4.8-MariaDB' }, { dialect: 'mariadb', version: '12.2.9-MariaDB' },
    { dialect: 'mysql', version: '8.0.45' }, { dialect: 'mysql', version: '12.3.4-MariaDB' }, { dialect: 'mariadb', version: '12.3.4' },
    { dialect: 'mysql', version: '8.4.13 arbitrary' }]) {
    assert.equal(supportsPreparedCteUpdate(server), false);
    assert.throws(() => parse(sql, server), /requires observed MySQL 8.4\+ or MariaDB 12.3\+/u);
    assert.throws(() => validatePreparedTemplate(parse(), { database: 'app', tables: tables(), server }), /requires observed/u);
  }
  assert.equal(supportsPreparedCteUpdate({ dialect: 'mariadb', version: '5.5.5-12.3.4-MariaDB' }), true);
  const changed = structuredClone(parse());
  changed.ast.cte.projections[0].column = 'id';
  assert.throws(() => validatePreparedTemplate(changed, { database: 'app', tables: tables(), server: mysql }), /template changed/u);
});

test('the CTE refuses multiple or recursive aliases, opaque projections, unqualified physical tables, cross-writes and additional statements', () => {
  const variants = [
    sql.replace('WITH ', 'WITH RECURSIVE '), sql.replace(') UPDATE ', '), second AS (SELECT 1) UPDATE '),
    sql.replace('p.tenant AS grp', '*'), sql.replace('p.tenant AS grp', 'ABS(p.tenant) AS grp'),
    sql.replace('p.id AS item', 'q.id AS item'), sql.replace('p.id AS item', 'p.id AS GRP'),
    sql.replace('lookup.physical', 'physical'), sql.replace('app.target', 'target'),
    sql.replace('JOIN source_rows', 'JOIN other'), sql.replace('INNER JOIN', 'LEFT JOIN'),
    sql.replace('SET t.amount=', 'SET s.data='), sql.replace('p.tenant=?', 'p.tenant=? OR p.id=?'),
    sql.replace('AS p WHERE', 'AS p GROUP BY p.tenant WHERE'),
    sql.replace('UPDATE app.target', 'DELETE FROM app.target'), sql + '; UPDATE app.target SET amount=0'
  ];
  for (const text of variants) assert.throws(() => parse(text), { code: 'ROCKETBRAIN_PROGRAM' });
});

test('metadata proof follows aliases back to unique ordinary read columns and refuses duplicate lineage or stale facts', () => {
  const variants = [
    [sql.replace('p.id AS item', 'p.tenant AS item'), tables(), /unique lookup key/u],
    [sql.replace('s.item', 's.absent'), tables(), /exact CTE output column/u],
    [sql.replace('s.data+?', 's.val+?'), tables(), /exact CTE output column/u],
    [sql.replace('p.tenant=?', 'p.unknown=?'), tables(), /ordinary integer/u],
    [sql.replace('p.val AS data', 'p.absent AS data'), tables(), /ordinary integer/u]
  ];
  const stale = tables();
  stale[1].indexes[0].unique = false;
  variants.push([sql, stale, /unique lookup key/u]);
  const signedness = tables();
  signedness[1].columns.find(column => column.name === 'id').type = 'INT UNSIGNED';
  variants.push([sql, signedness, /matching integer/u]);
  for (const [text, observed, expected] of variants) {
    assert.throws(() => validatePreparedTemplate(parse(text), { database: 'app', tables: observed, server: mysql }), expected);
  }
});
