'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { sqlJoinFixes } = require('../src/db/sql-join-fixes');

const names = ['children','parents'];
const column = name => ({name,type:'bigint unsigned',nullable:false});
const tables = names.map(name => ({schema:'fixture',name,kind:'table',columns:['id','tenant','parent'].map(column)}));
const catalog = { database:'fixture',dialect:'mysql',sqlMode:['STRICT_TRANS_TABLES'],tables,
  coverage:{ tables:'loaded',columns:'loaded',foreignKeys:'loaded' } };
const edge = { kind:'physical',name:'parent_fk',child:{schema:'fixture',table:'children'},parent:{schema:'fixture',table:'parents'},
  parts:[{ordinal:1,column:'tenant',parentColumn:'tenant'},{ordinal:2,column:'parent',parentColumn:'id'}] };

function candidates(sql, observe=async()=>({tables,edges:[edge]})) {
  const offset=sql.indexOf('|');
  return sqlJoinFixes(sql.replace('|',''),offset,catalog,observe);
}

test('an incomplete ON gets the exact live composite predicate in either direction without replacing aliases', async () => {
  const direct=await candidates('SELECT 1;\nSELECT c.id FROM children c LEFT JOIN parents p ON| WHERE c.id=2;', async request=>{
    assert.deepEqual(request.endpoints,[edge.child,edge.parent]);
    return {tables,edges:[edge]};
  });
  assert.equal(direct.length,1);
  assert.equal(direct[0].title,'Complete JOIN using parent_fk');
  assert.equal(direct[0].start,'SELECT 1;\nSELECT c.id FROM children c LEFT JOIN parents p ON'.length);
  assert.equal(direct[0].replacement,' `c`.`tenant` = `p`.`tenant` AND `c`.`parent` = `p`.`id`');
  const reverse=await candidates('SELECT p.id FROM parents p INNER JOIN children c|;');
  assert.equal(reverse[0].replacement,' ON `p`.`tenant` = `c`.`tenant` AND `p`.`id` = `c`.`parent`');
});

test('does not overwrite a user predicate or accept split, unrelated, or obsolete candidate edges', async () => {
  for (const sql of [
    'SELECT c.id FROM children c JOIN parents p ON| c.tenant = p.tenant',
    'SELECT c.id FROM children c NATURAL JOIN parents p|',
    'SELECT c.id FROM children c JOIN parents p /* retained comment */ |',
    'SELECT c.id FROM children c JOIN children copy|',
    'SELECT c.id FROM children c LEFT JOIN parents p WHERE c.id=|3',
    'UPDATE children c JOIN parents p| SET c.parent=1',
    'SELECT bad.id FROM children c JOIN parents p|'
  ]) assert.deepEqual(await candidates(sql),[],sql);
  const source='SELECT c.id FROM children c JOIN parents p|';
  assert.deepEqual(await candidates(source,async()=>({tables,edges:[]})),[]);
  assert.deepEqual(await candidates(source,async()=>({tables,edges:[{...edge,parts:[{...edge.parts[0],ordinal:2}]}]})),[]);
  assert.deepEqual(await candidates(source,async()=>{throw Error('missing metadata');}),[]);
});
