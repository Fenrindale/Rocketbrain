'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const schema = require('../src/db/schema-diff');
const designer = require('../src/db/schema-designer');
const ddl = require('../src/db/schema-designer-ddl');
const recovery = require('../src/db/schema-recovery');
const { supportsExpressionParts } = require('../src/db/schema-functional-index');
const { fixture } = require('./helpers/schema-diff-fixture');

const part = (name, expression) => ({ name, prefixLength: null, collation: 'A', ...(expression!==undefined&&{expression}) });
const index = (...columns) => ({ name: 'idx_arithmetic', unique: false, primaryKey: false, type: 'BTREE', comment: '', columns });
const signature = /KEY `idx_arithmetic` \(`id`,\s*\(`id` \* 2\)\)/u;

test('an arithmetic key is structurally captured, rendered, and planned in reviewed create and rebuild', () => {
  const current = fixture({ dialect: 'mysql' }), draft = designer.draft(current.tables[0], current.server);
  draft.indexes.push(index(part('id'), part(null, 'id * 2')));
  const table = designer.tableFromDraft(draft, current), sql = ddl.render(table, current);
  assert.match(sql, signature);
  const desired = schema.normalizeSnapshot({ ...current, tables: [{ ...table, createSql: sql }] }, { verifyFingerprint: false });
  const observed = desired.tables[0].indexes.find(key => key.name === 'idx_arithmetic');
  assert.deepEqual(observed.columns[1], { name: null, ordinal: 2, prefixLength: null, collation: 'A', expression: 'id * 2' });
  const before = schema.normalizeSnapshot({ ...current, tables: [] }, { verifyFingerprint: false });
  const create = schema.compareSnapshots(before, desired).changes.find(change => change.kind === 'create-table');
  assert.equal(create.selectable, true);
  const add = schema.compareSnapshots(current, desired).changes.find(change => change.kind === 'add-index');
  assert.equal(add.selectable, false);
  const rebuilt = recovery.makePlan(current, desired, { tables: [table.name], operationId: '8'.repeat(32) }).steps[0];
  assert.match(rebuilt.createSql, signature);
  assert.doesNotMatch(rebuilt.copySql, /idx_arithmetic|\* 2/u);
});

test('unsupported, ambiguous, and opaque index parts cannot become deployable SQL', () => {
  const current = fixture({ dialect: 'mysql' }), draft = designer.draft(current.tables[0], current.server);
  const unsafe = ['id', 'RAND()', 'id / 2', 'id*(SELECT 1)', 'id+1;DROP TABLE x', 'missing+1', '2*3'];
  for (const expression of unsafe) {
    const candidate = structuredClone(draft);
    candidate.indexes.push(index(part(null, expression)));
    assert.throws(() => designer.tableFromDraft(candidate, current), { code: 'ROCKETBRAIN_FUNCTIONAL_INDEX' }, expression);
  }
  for (const input of [
    { ...index(part(null, 'id * 2')), unique: true },
    index(part(null, 'id * 2'), part(null, 'id * 3')),
    index({ ...part(null, 'id * 2'), prefixLength: 3 }),
    index(part('id', 'id * 2'))
  ]) {
    const candidate = structuredClone(draft);
    candidate.indexes.push(input);
    assert.throws(() => designer.tableFromDraft(candidate, current), { code: 'ROCKETBRAIN_FUNCTIONAL_INDEX' });
  }
  const maria = fixture({ dialect: 'mariadb' });
  const remote = designer.draft(maria.tables[0], maria.server);
  remote.indexes.push(index(part(null, 'id * 2')));
  assert.throws(() => designer.tableFromDraft(remote, maria), /MySQL 8\.0\.13/);
  assert.equal(supportsExpressionParts({ dialect: 'mysql', version: '8.0.12' }), false);
  assert.equal(supportsExpressionParts({ dialect: 'mysql', version: '8.0.13' }), true);
});

test('a compound expression index cannot stand in for the ordinary child key of a foreign key', () => {
  const current = fixture({ dialect: 'mysql' }), draft = designer.draft(current.tables[0], current.server);
  const field = { ...draft.columns[0], name: 'parent_id' };
  draft.columns.push(field);
  draft.indexes.push(index(part('parent_id'), part(null, 'id * 2')));
  draft.foreignKeys.push({
    name: 'fk_parent', referencedSchema: current.database, referencedTable: draft.name,
    onDelete: 'RESTRICT', onUpdate: 'RESTRICT',
    columns: [{ name: 'parent_id', referencedColumn: 'id' }]
  });
  assert.throws(() => designer.tableFromDraft(draft, current), /Add an explicit child index/);
  draft.indexes.push({ ...index(part('parent_id')), name: 'idx_parent' });
  const sql = ddl.render(designer.tableFromDraft(draft, current), current);
  assert.match(sql, /KEY `idx_parent` \(`parent_id`\)/u);
  assert.match(sql, /FOREIGN KEY \(`parent_id`\)/u);
});
