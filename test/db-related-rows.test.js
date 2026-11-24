'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { relatedRows } = require('../src/db/related-rows');

function catalog() {
  const columns = pairs => pairs.map(([name, type]) => ({ name, type }));
  const parent = { name:'groups', kind:'table', columns:columns([['tenant','int'],['key','varchar(40)']]) };
  const child = { name:'items', kind:'table', columns:columns([['ref_id','bigint'],['ref','varchar(40)'],['tenant','int']]), foreignKeys:[{
    name:'group_fk', referencedSchema:'demo', referencedTable:'groups',
    columns:[{ordinal:2, name:'ref', referencedColumn:'key'}, {ordinal:1, name:'tenant', referencedColumn:'tenant'}]
  }] };
  return { database:'demo', coverage:{tables:'loaded', columns:'loaded', foreignKeys:'loaded'}, tables:[parent,child] };
}

test('Plans include the ordered composite columns and preserve exact bound values in both directions', () => {
  const meta = catalog();
  const reference = "O'Reilly\\_%";
  const options = relatedRows(meta,'items',['ref','tenant','ref_id'],[reference,3,'9223372036854775807']);
  assert.equal(options.length,1);
  assert.equal(options[0].direction,'referenced');
  assert.equal(options[0].table,'groups');
  assert.deepEqual(options[0].columns,[['tenant','tenant'],['ref','key']]);
  assert.deepEqual(options[0].filters, [
    {column:'tenant',operator:'eq',value:{kind:'value',text:'3'}},
    {column:'key',operator:'eq',value:{kind:'value',text:reference}}
  ]);
  const [reverse] = relatedRows(meta,'groups',['tenant','key'],[3,reference]);
  assert.equal(reverse.direction,'referencing');
  assert.equal(reverse.filters[1].column,'ref');
  assert.notEqual(reverse.key,options[0].key);
});

test('A NULL component, missing metadata or an unavailable target cannot be followed', () => {
  const meta = catalog();
  assert.deepEqual(relatedRows(meta,'items',['ref','tenant'],[null,3]),[]);
  assert.deepEqual(relatedRows(meta,'items',['ref','tenant'],['ref',9007199254740992]),[]);
  assert.throws(()=>relatedRows(meta,'items',['ref','ref'],['bad','bad']),/base-table preview/);
  meta.tables[1].foreignKeys[0].referencedSchema='unobserved';
  assert.deepEqual(relatedRows(meta,'items',['ref','tenant'],['ref',3]),[]);
  meta.coverage.foreignKeys='unavailable';
  assert.throws(()=>relatedRows(meta,'items',['ref','tenant'],['ref',3]),/visible foreign keys/);
});

test('A changed FK column contract has a distinct choice identity', () => {
  const meta = catalog();
  const [old] = relatedRows(meta,'items',['ref','tenant'],['ref',3]);
  meta.tables[0].columns[1].type='varchar(41)';
  const [changed] = relatedRows(meta,'items',['ref','tenant'],['ref',3]);
  assert.notEqual(old.key,changed.key);
});
