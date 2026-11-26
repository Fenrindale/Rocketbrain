'use strict';

const assert = require('node:assert/strict');
const fieldRequest = 'rocketbrain/kotlinObjectFields';

function assertObservedFields(fields) {
  const selected = new Map(fields.map(field=>[field.name,field]));
  for (const [name,type,value,writable] of [
    ['count','Int','4',true], ['isOpen','Boolean','true',true], ['exact','Long','9007199254740993',true],
    ['nullable','Int (boxed)','null',true], ['storedBox','Int (boxed)','7',false],
    ['constant','Int','13',false], ['guarded','Int','11',false]
  ]) {
    const row = selected.get(name);
    assert.deepEqual([row?.type,row?.value,row?.writable],[type,value,writable],name);
  }
  assert.ok(selected.get('nullable').boxSources.includes('replacementBox'));
  assert.ok(selected.get('nullable').boxSources.includes('boxed'));
  for (const name of ['computed','delegated','delegated$delegate','global','side']) assert.ok(!selected.has(name),name);
}

async function assertKotlinFields(send, frameId, changeOriginal) {
  const request = (action, args = {}) => send(fieldRequest,{action,frameId,...args});
  const list = (receiver = 'target') => request('fields',{receiver}).then(response=>response.fields);
  const prepare = (name,input) => request('prepare',{receiver:'target',name,input});
  const apply = review => request('apply',{reviewId:review.reviewId});
  const observed = await request('receivers');
  assert.ok(observed.receivers.some(row=>row.name==='target'&&row.owner==='coroutinesfixture.WatchObject'));
  assert.ok(observed.receivers.some(row=>row.name==='other'&&row.owner==='coroutinesfixture.WatchObject'));
  assert.ok(!observed.receivers.some(row=>['boxed','captions','absentList','trap'].includes(row.name)));
  assertObservedFields(await list());
  for (const [name,input] of [['constant','44'],['storedBox','boxed'],['guarded','44'],['computed','44'],['global','44']]) {
    await assert.rejects(prepare(name,input),/writable Kotlin scalar field/u);
  }
  await assert.rejects(prepare('count','target.mutate()'),/Kotlin Int literal/u);
  await assert.rejects(prepare('nullable','amount'),/exact boxed Kotlin field type/u);
  await assert.rejects(prepare('nullable','null'),/exact boxed Kotlin field type/u);
  const cancelled = await prepare('count','21');
  await request('cancel',{reviewId:cancelled.reviewId});
  await assert.rejects(apply(cancelled),/same Kotlin frame suspended/u);

  const changedByDebugger = await prepare('count','33');
  await changeOriginal();
  await assert.rejects(apply(changedByDebugger),/object field changed/u);
  assert.equal((await list()).find(row=>row.name==='count').value,'34');
  await apply(await prepare('count','4'));

  const changes = [];
  for (const [name,input,before,after] of [['count','59','4','59'],['isOpen','false','true','false'],
    ['exact','9007199254741035L','9007199254740993','9007199254741035'],['nullable','replacementBox','null','113']]) {
    const review = await prepare(name,input);
    assert.deepEqual([review.receiver,review.owner,review.name,review.before,review.after],
      ['target','coroutinesfixture.WatchObject',name,before,after]);
    assert.equal((await list()).find(row=>row.name===name).value,before);
    assert.deepEqual(await apply(review),{state:'applied',receiver:'target',name,value:after});
    assert.equal((await list()).find(row=>row.name===name).value,after);
    assert.equal((await list('other')).find(row=>row.name===name).value,before);
    await assert.rejects(apply(review),/same Kotlin frame suspended/u);
    changes.push({name,before,after});
  }
  const stale = await prepare('count','39');
  return {changes,readOnlyRefused:true,changedOriginalRefused:true,otherInstanceUnchanged:true,oneUseAndCancelledRefused:true,staleId:stale.reviewId};
}

function assertFieldsResumed(output) {
  assert.ok(output.includes('Rocketbrain Kotlin Fields|59|false|9007199254741035|113|4|0'),output);
  return {count:59,directBoolean:false,exactLong:'9007199254741035',boxed:113,otherInstanceCount:4,sideEffects:0};
}

module.exports = {fieldRequest,assertObservedFields,assertKotlinFields,assertFieldsResumed};
