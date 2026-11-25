'use strict';

const test=require('node:test'),assert=require('node:assert/strict');
const {definerInventory,plan}=require('../src/db/database-account-access');

const identity={dialect:'mysql',database:'app',currentUser:'administrator@127.0.0.1'};
const target={user:'deploy',host:'Db.Local'};
const full=['Y','Y','Y','Y','Y',0];
const revision='a'.repeat(64);

test('definer inventory requires direct complete visibility and refuses partial revokes or unavailable catalogs',async()=>{
  for(const actor of [[],[['Y','Y','Y','N','Y',0]],[['Y','Y','Y','Y','Y',1]]]){
    let queries=0;
    await assert.rejects(definerInventory(async()=>{queries++;return actor;},identity,target),/direct global SELECT/);
    assert.equal(queries,1);
  }
  await assert.rejects(definerInventory(async sql=>{
    if(sql.includes('mysql.user'))return [full];
    throw Error('not visible');
  },identity,target),/complete views definer inventory/);
});

test('definer inventory binds the exact account and distinguishes invoker objects, scoped triggers and disabled events',async()=>{
  const statements=[];
  const inventory=await definerInventory(async (sql,params)=>{
    if(sql.includes('mysql.user'))return [full];
    statements.push([sql,params]);
    if(sql.includes('information_schema.VIEWS'))return [['some_schema','summary',revision,'INVOKER']];
    if(sql.includes('information_schema.ROUTINES'))return [['app','summary',revision,'FUNCTION','DEFINER']];
    if(sql.includes('information_schema.TRIGGERS'))return [['app','write_summary',revision,'app','data','AFTER','INSERT']];
    return [['app','flush_summary',revision,'DISABLED']];
  },identity,target);
  assert.equal(statements.length,4);
  assert.ok(statements.every(([sql,params])=>sql.includes('LIMIT 129')&&
     JSON.stringify(params)===JSON.stringify(['deploy','deploy','deploy','Db.Local'])));
  assert.deepEqual(inventory.map(item=>[item.kind,item.schema,item.name,item.security]),[
    ['view','some_schema','summary','INVOKER'],['routine','app','summary','DEFINER'],
    ['trigger','app','write_summary','DEFINER'],['event','app','flush_summary','DEFINER']
  ]);
  assert.equal(inventory[3].status,'DISABLED');
});

test('bounded inventory and opaque fingerprints keep unsupported or oversized reviews closed',async()=>{
  for(const [rows,message] of [[Array.from({length:129},(_,i)=>['app','view_'+i,revision,'DEFINER']),/exceeds 128/],
      [[['app','unobservable',null,'DEFINER']],/inventory is incomplete/]]){
    await assert.rejects(definerInventory(async sql=>sql.includes('mysql.user')?[full]:rows,identity,target),message);
  }
  assert.throws(()=>plan({}, {account:target,locked:'yes'}),/lock or unlock action/);
  assert.throws(()=>plan({}, {account:target,locked:true,sql:'ignored'}),/lock or unlock action/);
});
