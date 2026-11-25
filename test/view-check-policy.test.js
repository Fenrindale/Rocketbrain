'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { canonical, create } = require('../src/db/object-editor-ddl');
const { withCheckOption, policyChange, inspectViewPolicy, checkCompiledViewPolicy, validatePolicyRecord } = require('../src/db/object-editor-view-policy');

const original = canonical({ kind:'view', schema:'sales', name:'public_rows', security:'DEFINER', definer:'owner@localhost',
  sqlMode:'', charset:'utf8mb4', collation:'utf8mb4_bin', databaseCollation:'utf8mb4_bin', algorithm:'MERGE', checkOption:'LOCAL',
  source:'SELECT id,score FROM sales.prior_view WHERE score<100' });
const changed = canonical(withCheckOption(original, 'CASCADED'));
const evidence = { policy:'LOCAL', filter:'score>0', type:'YES' };

function catalog(options = {}) {
  const { policy, filter, type } = { ...evidence, ...options };
  return async (sql, values) => {
    if (sql.includes('information_schema.VIEWS')) {
      assert.match(sql, /BINARY TABLE_SCHEMA=BINARY \? AND BINARY TABLE_NAME=BINARY \?/);
      if (values[1] === 'public_rows') return [[original.source, policy, type, 'DEFINER', 'owner@localhost', 'utf8mb4', 'utf8mb4_bin']];
      if (values[1] === 'prior_view') return [['SELECT id,score FROM sales.inventory WHERE ' + filter, 'NONE', 'YES', 'DEFINER', 'owner@localhost', 'utf8mb4', 'utf8mb4_bin']];
      if (values[1] === 'compiled') return [[original.source, 'CASCADED', 'YES', 'DEFINER', 'owner@localhost', 'utf8mb4', 'utf8mb4_bin']];
    }
    if (sql.includes('FROM information_schema.TABLES')) return [[values[1] === 'prior_view' ? 'VIEW' : 'BASE TABLE']];
    if (sql.startsWith('SHOW CREATE VIEW')) return [['prior_view', 'CREATE VIEW prior_view AS SELECT id,score FROM sales.inventory WHERE ' + filter]];
    if (sql.startsWith('SHOW CREATE TABLE')) return [['inventory', 'CREATE TABLE inventory (id INT PRIMARY KEY, score INT)']];
    if (sql.includes('FROM information_schema.TRIGGERS')) return options.fence ? [['inventory']] : [];
    assert.fail('Unexpected database statement ' + sql);
  };
}

test('typed check editing retains the relation and generates one exact ALTER VIEW suffix', () => {
  assert.deepEqual(policyChange(original, changed), { from:'LOCAL', to:'CASCADED' });
  assert.equal(policyChange(original, original), null);
  assert.match(create(changed, { alter:true }), / WITH CASCADED CHECK OPTION$/);
  assert.doesNotMatch(create(canonical(withCheckOption(original, 'NONE')), { alter:true }), /CHECK OPTION/);
  assert.throws(() => withCheckOption(original, 'CASCADED; DROP TABLE inventory'), /Choose NONE/);
  assert.throws(() => withCheckOption({ kind:'procedure' }, 'LOCAL'), /existing view/);
  assert.throws(() => canonical(original, original.source + ' WITH LOCAL CHECK OPTION'), /without subqueries or executable suffixes/);
});

test('the observed exact chain changes fingerprint as the underlying predicate changes', async () => {
  const before = await inspectViewPolicy(catalog(), original, changed);
  assert.equal(before.relations, 2);
  const after = await inspectViewPolicy(catalog({ filter:'score>1' }), original, changed);
  assert.notEqual(after.fingerprint, before.fingerprint);
  await assert.rejects(inspectViewPolicy(catalog({ type:'NO' }), original, changed), /observed updatable view/);
  await assert.rejects(inspectViewPolicy(catalog({ fence:true }), original, changed), /recovery fence/);
  const another = canonical(changed, 'SELECT id,score FROM sales.inventory');
  await assert.rejects(inspectViewPolicy(catalog(), original, another), /preserving its observed input relation/);
  await checkCompiledViewPolicy(catalog(), 'sales', 'compiled', 'CASCADED');
  await assert.rejects(checkCompiledViewPolicy(catalog(), 'sales', 'compiled', 'LOCAL'), /did not retain/);
});

test('a durable view policy change needs its exact before and after policy evidence', () => {
  const before = { definition:original }, after = { definition:changed };
  assert.doesNotThrow(() => validatePolicyRecord({ original:before, replacement:before }));
  assert.throws(() => validatePolicyRecord({ original:before, replacement:after }), /durable view CHECK OPTION review changed/);
  const viewPolicy = { from:'LOCAL', to:'CASCADED', relations:2, fingerprint:'a'.repeat(64) };
  assert.doesNotThrow(() => validatePolicyRecord({ original:before, replacement:after, viewPolicy }));
  assert.throws(() => validatePolicyRecord({ original:before, replacement:after, viewPolicy:{ ...viewPolicy, to:'NONE' } }), /review changed/);
});
