'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { executeFederatedSelect, parseFederatedSelect } = require('../src/db/federated-select');

const common = 'SELECT l.id AS left_id, l.label AS left_name, r.label AS right_name FROM source1.first AS l';
const join = ' JOIN source2.second AS r ON r.id = l.id';
const outer = common + ' LEFT' + join;
const inner = common + ' INNER' + join;
const large = '9007199254740995';

function fixture(leftRows, rightRows) {
  const requests = [];
  const sources = [leftRows, rightRows].map((rows, index) => ({
    catalog: async () => ({ database: index ? 'second_db' : 'first_db', tables: [{
      name: index ? 'second' : 'first', kind: 'table', columns: [
        { name: 'id', type: 'bigint unsigned' }, { name: 'label', type: 'varchar(24)' }, { name: 'other', type: 'int' }
      ] }] }),
    read: async (sql, values, maxRows) => {
      requests[index] = { sql, values, maxRows };
      return { rows, columns:['id','label'], fields:[{type:8},{type:253}] };
    }
  }));
  return { sources, requests };
}

test('federated INNER JOIN pushes projection and typed predicates to each source', async () => {
  const { requests, sources } = fixture([[large, 'first']], [[large, 'second'], ['9007199254740994', 'different']]);
  const query = parseFederatedSelect(inner + " WHERE l.id >= 9007199254740990 AND r.label = 'O''Brien';");
  const result = await executeFederatedSelect(query, sources);
  assert.deepEqual(result.rows, [[large, 'first', 'second']]);
  assert.deepEqual(result.inputs.map(item => item.sentValues), [1, 1]);
  assert.deepEqual(requests, [
    { sql: 'SELECT `id`, `label` FROM `first_db`.`first` WHERE `id` >= CAST(? AS DECIMAL(65,0)) LIMIT 2001', values: ['9007199254740990'], maxRows: 2001 },
    { sql: 'SELECT `id`, `label` FROM `second_db`.`second` WHERE `label` = ? LIMIT 2001', values: ["O'Brien"], maxRows: 2001 }
  ]);
  assert.equal(result.crossServerSnapshot, false);
});

test('federated LEFT JOIN multiplies matches, preserves unmatched rows and never joins NULL keys', async () => {
  const { sources } = fixture([[large, 'left'], [null, 'null'], [3, 'other']], [[large, 'right'], [large, 'duplicate'], [null, 'wrong']]);
  const result = await executeFederatedSelect(parseFederatedSelect(outer), sources);
  assert.deepEqual(result.rows, [[large, 'left', 'right'], [large, 'left', 'duplicate'], [null, 'null', null], [3, 'other', null]]);
  const limited = await executeFederatedSelect(parseFederatedSelect(outer + ' LIMIT 2'), sources);
  assert.deepEqual(limited.rows, result.rows.slice(0, 2));
});

test('federated SELECT rejects an ambiguous outer predicate, arbitrary expressions and unsupported key types', async () => {
  assert.throws(() => parseFederatedSelect(outer + ' WHERE r.label IS NULL'), /null extension/);
  assert.throws(() => parseFederatedSelect(inner + '; SELECT 1'), /one supported SELECT/);
  assert.throws(() => parseFederatedSelect(inner + ' WHERE l.id \'=\' 1'), /comparison/);
  assert.throws(() => parseFederatedSelect(inner.replace('r.id = l.id', 'r.label = l.label') + ' ORDER BY l.id'), /one supported SELECT/);
  const { sources } = fixture([], []);
  await assert.rejects(executeFederatedSelect(parseFederatedSelect(inner.replace('r.id = l.id', 'r.label = l.label')), sources), /integer columns/);
  const tooMany = fixture(Array.from({ length: 2001 }, () => [2, 'left']), []);
  await assert.rejects(executeFederatedSelect(parseFederatedSelect(inner), tooMany.sources), /read limit/);
});
