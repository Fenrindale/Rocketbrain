'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {listNames,loadDetails}=require('../src/db/lazy-catalog');

test('a catalog page reads only names and types, keeps exact paging, and binds prefixes literally',async()=>{
  const calls=[];
  const rows=Array.from({length:101},(_,index)=>['test','object'+String(index).padStart(3,'0'),
    index%2?'VIEW':'BASE TABLE']);
  const out=await listNames(async(sql,values)=>{calls.push({sql,values});return rows;},{prefix:'Percent_%',after:'previous'});
  assert.equal(calls.length,1);
  assert.match(calls[0].sql,/TABLE_SCHEMA,TABLE_NAME,TABLE_TYPE FROM information_schema\.TABLES/);
  assert.deepEqual(calls[0].values,['Percent=_=%%','previous']);
  assert.equal(out.items.length,100);
  assert.equal(out.detailQueries,0);
  assert.deepEqual(out.items[99],{schema:'test',name:'object099',kind:'view'});
  assert.equal(out.next,'object099');
});

test('expansion binds the reviewed object name and loads exact column and index definitions',async()=>{
  const calls=[];
  const read=async(sql,values)=>{
    calls.push({sql,values});
    if(sql.includes('.TABLES'))return [['BASE TABLE','InnoDB']];
    if(sql.includes('.COLUMNS'))return [['id','bigint','NO',1,'PRI'],['name','varchar(32)','YES',2,'']];
    return [['PRIMARY',1,'id',0,'BTREE'],['names',1,null,1,'BTREE']];
  };
  const result=await loadDetails(read,{schema:'spring',name:'record',kind:'table'});
  assert.equal(calls.length,3);
  assert.ok(calls.every(call=>JSON.stringify(call.values)==='["spring","record"]'));
  assert.deepEqual(result.columns.map(value=>[value.name,value.nullable]),[['id',false],['name',true]]);
  assert.deepEqual(result.indexColumns.map(value=>[value.column,value.unique]),[['id',true],[null,false]]);
  assert.equal(result.rowDataIncluded,false);
  await assert.rejects(loadDetails(read,{schema:'spring',name:'record',kind:'view'}),/changed/);
  assert.equal(calls.length,4);
});
