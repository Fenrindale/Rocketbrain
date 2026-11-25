'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { compareDatasets, selectDatasetChanges } = require('../src/db/dataset-comparison');
const { ResultsView } = require('../src/results');

const columns = [
  { name: 'tenant', kind: 'text', type: 'varchar(20)', primaryKey: true },
  { name: 'id', kind: 'integer', type: 'bigint unsigned', primaryKey: true },
  { name: 'amount', kind: 'decimal', type: 'decimal(30,8)', editable: true, nullable: true },
  { name: 'payload', kind: 'binary', type: 'blob', editable: true, nullable: true },
  { name: 'note', kind: 'text', type: 'varchar(50)', editable: true, nullable: true }
];
const target = {
  columns: columns.map(column => column.name),
  rows: [['w', '9007199254740993', '9007199254.12345678', '0xCAFE', 'NULL'],
    ['w', '20', '7.10000000', '0x00ff', ''], ['old', '20', null, null, null]],
  edit: { columns, canEdit: true, modelId: 'target-model', rowIds: ['row-a', 'row-b', 'row-c'] },
  browse: { page: 1, hasPrevious: true, hasNext: false }
};
const source = {
  columns: ['ident', 'bucket', 'data', 'price', 'remark'],
  fields: [{ type: 8 }, { type: 253 }, { type: 252, characterSet: 63 }, { type: 246 }, { type: 253 }],
  rows: [['9007199254740993', 'w', '0x00ff', '9007199254.12345679', null],
    ['020', 'w', '0x00FF', '7.10', ''], ['20', 'new', '0x', '1', '']]
};
const map = [1, 0, 3, 2, 4].map((source, target) => ({ target, source, key: target < 2 }));

test('exact typed dataset comparison maps composite keys by ordinal and preserves capture provenance', () => {
  const compared = compareDatasets(target, source, map);
  assert.deepEqual(compared.report.summary, { equal: 1, changed: 1, targetOnly: 1, sourceOnly: 1 });
  assert.deepEqual(compared.report.target, { rows: 3, partial: true, page: 2 });
  assert.deepEqual(compared.report.source, { rows: 3, partial: false });
  assert.deepEqual(compared.report.rows.map(row => row.state), ['changed', 'target-only', 'source-only']);
  assert.deepEqual(compared.report.rows[0].key, ['w', '9007199254740993']);
  assert.deepEqual(compared.report.rows[0].fields.map(({ target, source }) => [target, source]), [
    ['9007199254.12345678', '9007199254.12345679'], ['0xCAFE', '0x00ff'], ['NULL', null]
  ]);
  assert.equal(compared.report.stageableRows, 1);
  assert.deepEqual(selectDatasetChanges(compared, [0]), {
    deletes: [], inserts: [], updates: [{ rowId: 'row-a', values: {
      amount: { kind: 'value', text: '9007199254.12345679' }, payload: { kind: 'value', text: '0x00ff' }, note: { kind: 'null' }
    } }]
  });
  assert.throws(() => selectDatasetChanges(compared, [1]), /eligible rows/);
  assert.throws(() => selectDatasetChanges(compared, [0, 0]), /distinct eligible/);
});

test('comparison rejects key collisions, NULL keys and unsafe coercions before reconciliation', () => {
  const duplicate = { ...source, rows: [...source.rows, ['00020', 'w', '0x00ff', '7.100', '']] };
  assert.throws(() => compareDatasets(target, duplicate, map), /source key is duplicated/);
  assert.throws(() => compareDatasets(target, { ...source, rows: [[null, 'w', '0x00', '9', '']] }, map), /source key contains SQL NULL/);
  const asText = { ...source, fields: source.fields.map((field, index) => index === 3 ? { type: 253 } : field) };
  assert.throws(() => compareDatasets(target, asText, map), /Incompatible captured column types/);
  const protectedColumn = { ...target, edit: { ...target.edit, columns: columns.map(column =>
    column.name === 'amount' ? { ...column, editable: false } : column) } };
  assert.equal(compareDatasets(protectedColumn, source, map).report.stageableRows, 0);
  const customKey = map.map(pair => ({ ...pair, key: pair.target === 1 }));
  assert.equal(compareDatasets({ ...target, rows: target.rows.slice(0, 1) }, { ...source, rows: source.rows.slice(0, 1) }, customKey).report.stageableRows, 0);
});

test('only a current captured pair can stage a bounded reviewed selection with the destination model', async () => {
  const calls = [], view = new ResultsView({ workspace: {} }, {}, { datasetAction: async (id, input) => {
    input.assertFresh();
    calls.push({ id, changes: input.changes });
  } });
  const a = view.begin('SELECT * FROM target', 'fixture', { readOnly: false });
  const b = view.begin('SELECT * FROM source', 'fixture');
  view.finish(a, target);
  view.finish(b, source);
  let comparison = view.compareDatasets(a, b, map);
  view.finish(b, { ...source });
  const input = { reviewId: comparison.reviewId, rows: [0], modelId: 'target-model', draftRevision: 0 };
  await assert.rejects(view.stageDatasetComparison(a, input), /changed.*Compare again/);
  comparison = view.compareDatasets(a, b, map);
  await view.stageDatasetComparison(a, { ...input, reviewId: comparison.reviewId });
  assert.deepEqual(calls, [{ id: a, changes: selectDatasetChanges(compareDatasets(target, source, map), [0]) }]);
  await assert.rejects(view.stageDatasetComparison(a, { ...input, reviewId: comparison.reviewId }), /Compare the current/);
});

test('complete table captures support selected membership changes with physical integer primary keys', () => {
  const meta = [{ name:'id',kind:'integer',type:'bigint unsigned',primaryKey:true,required:true,insertable:true },
    { name:'label',kind:'text',type:'varchar(40)',editable:true,insertable:true,nullable:true },
    { name:'derived',kind:'integer',type:'int',insertable:false }];
  const captured = (table,rows) => ({ columns:meta.map(item=>item.name), rows,
    browse:{ page:0,hasPrevious:false,hasNext:false,filters:[] },
    edit:{ table,columns:meta,rowIds:rows.map((_,index)=>table+index),canEdit:true,insertable:true } });
  const destination = captured('destination', [['1','original','9'],['2','remove','4']]);
  const origin = captured('origin', [['1',null,'9'],['3','added','5']]);
  const mapping = [0,1,2].map(index=>({source:index,target:index,key:index===0}));
  const result = compareDatasets(destination,origin,mapping);
  assert.equal(result.report.oneSidedChanges,true);
  assert.deepEqual(result.report.rows.map(row=>row.operation),['update','delete','insert']);
  assert.deepEqual(selectDatasetChanges(result,[0,1,2]), {
    updates:[{rowId:'destination0',values:{label:{kind:'null'}}}], deletes:['destination1'],
    inserts:[{values:{id:{kind:'value',text:'3'},label:{kind:'value',text:'added'}}}]
  });
  for (const incomplete of [{...origin,browse:{...origin.browse,hasNext:true}},
      {...origin,browse:{...origin.browse,filters:[{column:'label'}]}},
      {...origin,edit:undefined,fields:[{type:8},{type:253},{type:3}]}]) {
    const comparison = compareDatasets(destination,incomplete,mapping);
    assert.equal(comparison.report.oneSidedChanges,false);
    assert.deepEqual(comparison.report.rows.map(row=>row.operation),['update',undefined,undefined]);
  }
  const incompatible = { ...origin,edit:{...origin.edit,columns:[{...meta[0],type:'bigint'},...meta.slice(1)]} };
  assert.equal(compareDatasets(destination,incompatible,mapping).report.oneSidedChanges,false);
});
