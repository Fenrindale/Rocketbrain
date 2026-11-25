'use strict';

const assert=require('node:assert/strict');
const test=require('node:test');
const {createResultSnapshotStore}=require('../src/db/result-snapshots');

function workspace() {
  const data=new Map();
  return {keys:()=>[...data.keys()],get:key=>data.get(key),async update(key,value){
    if(value===undefined)data.delete(key);
    else data.set(key,JSON.parse(JSON.stringify(value)));
  }};
}

const source={columns:['exact','cash','bytes','null_value','unit'],rows:[['9007199254740999','15.12000000','61ff',null,-0]],
  fields:[{type:8},{type:246},{type:252,characterSet:63}],browse:{hasNext:true},sql:'private SQL',edit:{table:'internal'},sessionId:'internal'};

test('history restores exact scalar data and protocol types through a new workspace host',async()=>{
  const storage=workspace(),first=createResultSnapshotStore(storage,()=>true),receipt=await first.save('Completed',source);
  const serialized=JSON.stringify(storage.get(storage.keys()[0]));
  assert.equal(serialized.includes('private SQL'),false);
  assert.equal(serialized.includes('internal'),false);
  const second=createResultSnapshotStore(storage,()=>true);
  assert.deepEqual(second.list(),[receipt]);
  const {result}=second.get(receipt.id);
  assert.deepEqual(result.rows,source.rows);
  assert.equal(result.fields[2].characterSet,63);
  assert.equal(result.truncated,true);
  assert.equal(result.offlineCapture,true);
  assert.equal(result.edit,undefined);
  await second.remove(receipt.id);
  assert.deepEqual(second.list(),[]);
  assert.throws(()=>second.get(receipt.id),/unavailable/);
});

test('rejects unsupported types, oversized payloads, lost trust and a thirteenth snapshot',async()=>{
  const storage=workspace();
  let trusted=true;
  const history=createResultSnapshotStore(storage,()=>trusted);
  await assert.rejects(history.save('Invalid',{columns:['bad'],rows:[[{lookup:true}]]}),/unsupported cell/);
  await assert.rejects(history.save('Too big',{columns:['cell'],rows:[['대'.repeat(400000)]]}),/1 MiB/);
  for(let index=0;index<12;index++)await history.save('Small '+index,source);
  await assert.rejects(history.save('Overflow',source),/space is full/);
  trusted=false;
  assert.throws(history.list,/trusted workspace/);
  await assert.rejects(history.save('Private',source),/trusted workspace/);
});
