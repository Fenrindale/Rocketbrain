'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createConsoleDraftStore } = require('../src/db/console-drafts');

function memento() {
  const items = new Map();
  return {
    get: key => structuredClone(items.get(key)),
    keys: () => [...items.keys()],
    async update(key, value) {
      if (value === undefined) items.delete(key);
      else items.set(key, structuredClone(value));
    }
  };
}

test('drafts preserve exact unsaved SQL, unicode cursor offsets and immutable review revisions across activation', async () => {
  const state = memento(), first = createConsoleDraftStore(state, () => true);
  const text = "SELECT '봄';\r\n-- 未保存\r\n";
  const saved = await first.write({ title: 'My\nSQL', text, anchor: 8, active: 2 });
  assert.equal(saved.title, 'My SQL');
  const resumed = createConsoleDraftStore(state, () => true);
  assert.deepEqual(resumed.get(saved.id), saved);
  assert.deepEqual(resumed.list(), [{ id:saved.id, title:'My SQL', revision:saved.revision, savedAt:saved.savedAt, bytes:Buffer.byteLength(text) }]);
  assert.equal((await resumed.write(saved, saved.id)).revision, saved.revision);
  const next = await resumed.write({ ...saved, text: text + 'SELECT 2;' }, saved.id);
  assert.notEqual(next.revision, saved.revision);
  await assert.rejects(resumed.remove(saved.id, saved.revision), /draft changed/);
  await resumed.remove(saved.id, next.revision);
  assert.deepEqual(resumed.list(), []);
});

test('the trusted workspace and storage bounds are enforced without replacing a prior good snapshot', async () => {
  const state = memento();
  let trusted = true;
  const api = createConsoleDraftStore(state, () => trusted);
  const input = { title:'Large SQL', text:'가'.repeat(40960), anchor:0, active:0 };
  const first = await api.write(input);
  await assert.rejects(api.write({ ...input, text:'가'.repeat(50000) }, first.id), /128 KiB/);
  await assert.rejects(api.write({ ...input, anchor:-1 }, first.id), /selection/);
  assert.deepEqual(api.get(first.id), first);
  for (let index = 0; index < 7; index++) await api.write(input);
  await assert.rejects(api.write(input), /drafts are full/);
  assert.equal(api.list().length, 8);
  trusted = false;
  await assert.rejects(api.write(input), /trusted workspace/);
  assert.throws(api.list, /trusted workspace/);
  assert.throws(() => api.get(first.id), /trusted workspace/);
  await assert.rejects(api.remove(first.id,first.revision), /trusted workspace/);
});

test('explicit checkpoints preserve eight independent revisions and do not track automatic edits as history', async () => {
  const state=memento(), first=createConsoleDraftStore(state,()=>true);
  const source={title:'SQL history',text:'SELECT 0',anchor:1,active:4};
  const known=await first.write(source);
  assert.deepEqual(first.history(known.id),[]);
  const revisions=[];
  for (let index=0;index<10;index++) {
    const current=await first.write({...source,text:'SELECT '+index},known.id,{pin:true});
    revisions.unshift(current.revision);
    assert.equal((await first.write(current,known.id,{pin:true})).revision,current.revision);
  }
  const newest=await first.write({...source,text:'SELECT 99'},known.id);
  const resumed=createConsoleDraftStore(state,()=>true);
  assert.equal(resumed.get(known.id).text,'SELECT 99');
  assert.deepEqual(resumed.history(known.id).map(item=>item.revision),revisions.slice(0,8));
  assert.equal(resumed.getCheckpoint(known.id,revisions[0]).text,'SELECT 9');
  assert.throws(()=>resumed.getCheckpoint(known.id,revisions.at(-1)),/unavailable/);
  await resumed.remove(known.id,newest.revision);
  assert.throws(()=>resumed.history(known.id),/unavailable/);
});
