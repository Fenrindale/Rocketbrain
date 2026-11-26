'use strict';

const assert=require('node:assert/strict');

const assignment='rocketbrain/setKotlinLocal';
const cases=[['amount','Int','42','123','123','42'],
  ['large','Long','9007199254740993','9007199254741001','9007199254741001L','9007199254740993L'],
  ['enabled','Boolean','true','false','false','true']];

async function assertKotlinLocalChanges(send,frameId) {
  const command=(action,args={})=>send(assignment,{action,frameId,...args});
  const observe=name=>send('evaluate',{frameId,expression:name,context:'watch'}).then(result=>result.result);
  const list=await command('list');
  assert.ok(!list.locals.some(row=>['boxed','caption','numbers','trap'].includes(row.name)));
  for(const [name,type] of cases)assert.ok(list.locals.some(row=>row.name===name&&row.type===type));
  await assert.rejects(command('prepare',{name:'amount',literal:'1 + 2'}),/Kotlin Int literal/u);
  await assert.rejects(command('prepare',{name:'amount',literal:'2147483648'}),/outside the Kotlin local/u);
  await assert.rejects(command('prepare',{name:'boxed',literal:'6'}),/visible Kotlin Int, Long or Boolean/u);
  const cancelled=await command('prepare',{name:'amount',literal:'301'});
  assert.equal(await observe('amount'),'42');
  await command('cancel',{reviewId:cancelled.reviewId});
  await assert.rejects(command('apply',{reviewId:cancelled.reviewId}),/same Kotlin frame suspended/u);

  const changed=[];
  for(const [name,type,before,after,literal,restore] of cases){
    const review=await command('prepare',{name,literal});
    assert.deepEqual([review.name,review.type,review.before,review.after],[name,type,before,after]);
    assert.equal(await observe(name),before);
    await assert.rejects(command('apply',{reviewId:'another-review'}),/same Kotlin frame suspended/u);
    assert.deepEqual(await command('apply',{reviewId:review.reviewId}),{state:'applied',name,value:after});
    assert.equal(await observe(name),after);
    await assert.rejects(command('apply',{reviewId:review.reviewId}),/same Kotlin frame suspended/u);
    const reset=await command('prepare',{name,literal:restore});
    assert.deepEqual([reset.before,reset.after],[after,before]);
    await command('apply',{reviewId:reset.reviewId});
    assert.equal(await observe(name),before);
    changed.push({name,type,before,after,restored:true});
  }
  const stale=await command('prepare',{name:'amount',literal:'299'});
  return {changed,reviewOnlyUnchanged:true,invalidAndUnapprovedRefused:true,cancelledRefused:true,staleId:stale.reviewId};
}

module.exports={assignment,assertKotlinLocalChanges};
