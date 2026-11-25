'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const generated = require('../src/db/schema-generated-column');
const designer = require('../src/db/schema-designer');
const D = require('../src/db/schema-designer-ddl');
const schema = require('../src/db/schema-diff');
const recovery = require('../src/db/schema-recovery');
const { fixture } = require('./helpers/schema-diff-fixture');

function editable(dialect = 'mysql') {
  const current = fixture({ dialect }), source = current.tables[0];
  return { current, source, draft: designer.draft(source, current.server) };
}
const field = (name, generationMode, generationExpression, extras = {}) => ({
  name, type: 'DECIMAL(24,6)', defaultKind: 'none', defaultValue: '', nullable: true, autoIncrement: false,
  charset: '', collation: '', comment: '', srsId: '', generationMode, generationExpression, ...extras
});
const snapshot = (value, table) => schema.normalizeSnapshot({ ...value, tables: [table] }, { verifyFingerprint: false });

test('designer compiles exact generated storage and round-trips the supported numeric expression', () => {
  for (const dialect of ['mysql', 'mariadb']) {
    const { current, draft } = editable(dialect);
    draft.columns.push(field('calc', 'stored', 'id + (2 * 3)'), field('view', 'virtual', '-id * 1.25'));
    const table = designer.tableFromDraft(draft, current);
    const sql = D.render(table, current);
    assert.match(sql, /GENERATED ALWAYS AS \(\(`id` \+ \(2 \* 3\)\)\) (?:STORED|PERSISTENT)/u);
    assert.match(sql, dialect === 'mysql' ? /\) STORED/u : /\) PERSISTENT/u);
    assert.match(sql, /\) VIRTUAL/u);
    assert.deepEqual(designer.draft(table, current.server).columns.slice(-2).map(column => [column.generationMode, column.generationExpression]), [
      ['stored', '(`id` + (2 * 3))'], ['virtual', '((-`id`) * 1.25)']
    ]);
    const other = { ...table, columns: table.columns.map(column => column.name === 'calc' ? { ...column,
      generationExpression: '(((`id`) + ((2*3))))' } : column) };
    assert.deepEqual(recovery.shape(table), recovery.shape(other));
  }
});

test('dynamic calls, forward references, defaults, key roles and unknown numeric modes fail closed', () => {
  for (const expression of ['NOW()', 'id / 2', 'id;DROP TABLE q', 'future + 1', 'self * 2', '2 * 3', 'id + /* note */ 2']) {
    const { current, draft } = editable();
    draft.columns.push(field('self', 'virtual', expression), field('future', 'none', ''));
    assert.throws(() => designer.tableFromDraft(draft, current), { code: 'ROCKETBRAIN_GENERATED_COLUMN' }, expression);
  }
  const { current, draft } = editable();
  draft.columns.push(field('virtual_amount', 'virtual', 'id * 2'));
  const child = draft.columns.at(-1);
  child.defaultKind = 'literal';
  assert.throws(() => designer.tableFromDraft(draft, current), /without.*default|cannot have a default/iu);
  child.defaultKind = 'none';
  draft.indexes.push({ name: 'idx', unique: true, primaryKey: false, type: 'BTREE', comment: '',
    columns: [{ name: 'virtual_amount', ordinal: 1, prefixLength: null, collation: 'A' }] });
  assert.throws(() => designer.tableFromDraft(draft, current), /non-unique ascending BTREE/u);
  draft.indexes.at(-1).unique = false;
  assert.match(D.render(designer.tableFromDraft(draft, current), current), /KEY `idx` \(`virtual_amount`\)/u);
  draft.indexes.at(-1).columns[0].collation = 'D';
  assert.throws(() => designer.tableFromDraft(draft, current), /non-unique ascending BTREE/u);
  assert.equal(generated.mode({ extra: 'PERSISTENT GENERATED', generationExpression: 'id * 2' }), 'stored');
});

test('reviewed rebuild copies ordinary inputs and rejects changing a column between input and generated output', () => {
  const { current, source, draft } = editable();
  draft.columns.push(field('existing', 'virtual', 'id * 2'));
  const first = designer.tableFromDraft(draft, current), previous = snapshot(current, first);
  draft.columns.find(column => column.name === 'existing').generationExpression = 'id * 3';
  draft.columns.push(field('extra', 'stored', 'id + 12'));
  draft.indexes.push({ name: 'idx_generated', unique: false, primaryKey: false, type: 'BTREE', comment: '',
    columns: [{ name: 'id', ordinal: 1, prefixLength: null, collation: 'A' },
      { name: 'extra', ordinal: 2, prefixLength: null, collation: 'A' }] });
  const after = snapshot(current, designer.tableFromDraft(draft, current));
  const planned = recovery.makePlan(previous, after, { tables: [source.name], operationId: 'e'.repeat(32) }).steps[0];
  assert.deepEqual(planned.common, ['id']);
  assert.match(planned.copySql, /\(`id`\) SELECT /u);
  assert.doesNotMatch(planned.copySql, /existing|extra/u);
  assert.match(planned.createSql, /GENERATED ALWAYS AS/u);
  assert.match(planned.createSql, /KEY `idx_generated` \(`id`,\s*`extra`\)/u);
  Object.assign(draft.columns.find(column => column.name === 'existing'), { generationMode: 'none', generationExpression: '' });
  const replaced = snapshot(current, designer.tableFromDraft(draft, current));
  assert.throws(() => recovery.makePlan(previous, replaced, { tables: [source.name] }), /between stored input and generated output/u);
});

test('a trailing generated part preserves the exact ordinary foreign-key index prefix', () => {
  const { current, draft } = editable();
  const column = (name, ordinal) => ({ name, ordinal, prefixLength: null, collation: 'A' });
  draft.columns.push(field('parent_id', 'none', '', { type: 'INT' }), field('computed', 'stored', 'id * 2'));
  draft.indexes.push({ name: 'idx_composite', unique: false, primaryKey: false, type: 'BTREE', comment: '',
    columns: [column('parent_id', 1), column('computed', 2)] });
  draft.foreignKeys.push({ name: 'fk_parent', referencedSchema: current.database, referencedTable: draft.name,
    onUpdate: 'RESTRICT', onDelete: 'RESTRICT', columns: [{ name: 'parent_id', referencedColumn: 'id' }] });
  assert.match(D.render(designer.tableFromDraft(draft, current), current), /KEY \x60idx_composite\x60 \(\x60parent_id\x60,\s*\x60computed\x60\)/u);
  draft.indexes[1].columns.reverse();
  assert.throws(() => designer.tableFromDraft(draft, current), /index beginning with the foreign-key columns/u);
});

test('stored FK participation and its ordinary source inputs follow different engine action rules',()=>{
  for(const dialect of ['mysql','mariadb']){
    const {current,draft}=editable(dialect);
    draft.columns.push(field('code','none','',{type:'INT'}), field('computed','stored','code * 2',{type:'INT'}));
    const column=name=>({name,ordinal:1,prefixLength:null,collation:'A'});
    draft.indexes.push({name:'idx_calc',unique:false,primaryKey:false,type:'BTREE',comment:'',columns:[column('computed')]});
    const fk={name:'fk_computed',referencedSchema:current.database,referencedTable:draft.name,
      onUpdate:'RESTRICT',onDelete:'CASCADE',columns:[{name:'computed',referencedColumn:'id'}]};
    draft.foreignKeys.push(fk);
    assert.match(D.render(designer.tableFromDraft(draft,current),current),/FOREIGN KEY \(\x60computed\x60\).*ON DELETE CASCADE ON UPDATE RESTRICT/u);
    fk.onUpdate='CASCADE';
    assert.throws(()=>designer.tableFromDraft(draft,current),/Stored generated foreign-key columns require restrictive updates/u);
    fk.onUpdate='RESTRICT';
    draft.columns.at(-1).generationMode='virtual';
    assert.throws(()=>designer.tableFromDraft(draft,current),/stored generated child columns/u);
    draft.columns.at(-1).generationMode='stored';
    draft.indexes[1].columns.unshift(column('code'));
    fk.columns[0].name='code';
    if(dialect==='mariadb')assert.ok(designer.tableFromDraft(draft,current));
    else assert.throws(()=>designer.tableFromDraft(draft,current),/child input used by a stored generated column/u);
    fk.onDelete='RESTRICT';
    assert.ok(designer.tableFromDraft(draft,current));
    fk.referencedSchema='unreviewed';
    assert.throws(()=>designer.tableFromDraft(draft,current),/parent in the active schema/u);
  }
});
