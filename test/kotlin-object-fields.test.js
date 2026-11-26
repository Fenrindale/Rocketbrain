'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createKotlinFieldInspector } = require('../src/java/debug-kotlin-fields');
const { KOTLIN_FIELD_BUILD, KOTLIN_LOCAL_WRITE_BUILD } = require('../src/java/debug-runtime');

function fixture() {
  const commands = [];
  const state = {state:'stopped',threadId:9,stopVersion:2,appliedVersion:0,debugBuild:KOTLIN_FIELD_BUILD};
  const token = '9dd8cc72-05ce-46ac-9514-9157c04582da';
  const owner = 'example.Count';
  const session = {id:'focus',type:'rocketbrain-java',async customRequest(command,args) {
    commands.push({command,args});
    if (command === 'stackTrace') return {stackFrames:[{id:3,name:'top'},{id:7,name:'selected'}]};
    assert.equal(command,'rocketbrain/kotlinObjectFields');
    if (args.action === 'receivers') return {receivers:[{name:'item',owner}]};
    if (args.action === 'fields') return {fields:[
      {name:'amount',type:'Int',value:'4',writable:true,boxed:false,boxSources:[]},
      {name:'caption',type:'Int (boxed)',value:'null',writable:true,boxed:true,boxSources:['boxed']}
    ]};
    if (args.action === 'prepare') {
      assert.equal(args.receiver,'item');
      return {reviewId:token,receiver:'item',owner,name:'amount',type:'Int',before:'4',after:'8'};
    }
    if (args.action === 'apply') return {state:'applied',receiver:'item',name:'amount',value:'8'};
    if (args.action === 'cancel') return {state:'cancelled'};
    throw Error('Unexpected request');
  }};
  const vscode = {debug:{activeDebugSession:session,activeStackItem:{session,frameId:7,threadId:9}}};
  const inspector = createKotlinFieldInspector(vscode,{getState:()=>state,ensureTrusted:()=>{}});
  return {commands,inspector,state,vscode};
}

test('object field review is bound to the focused paused Kotlin frame and consumed once', async () => {
  const {commands,inspector} = fixture();
  const observed = await inspector.list();
  assert.equal(observed.frame,'selected');
  const fields = await inspector.inspectFields(observed,'item');
  assert.deepEqual(fields.fields[1].boxSources,['boxed']);
  await assert.rejects(inspector.prepare(fields,'caption','unknown'),/matching primitive literal or boxed local/u);
  const review = await inspector.prepare(fields,'amount','8');
  assert.deepEqual(await inspector.apply(review),{state:'applied',receiver:'item',name:'amount',value:'8'});
  await assert.rejects(inspector.apply(review),/Inspect this paused Kotlin object/u);
  assert.deepEqual(commands.map(({args})=>args.frameId),[undefined,7,7,7,7]);
});

test('old adapter, unapproved report, focus change and a new stop cannot mutate an object field', async () => {
  const {commands,inspector,state,vscode} = fixture();
  state.debugBuild = KOTLIN_LOCAL_WRITE_BUILD;
  await assert.rejects(inspector.list(),/Update the Rocketbrain Java debugger/u);
  state.debugBuild = KOTLIN_FIELD_BUILD;
  const report = await inspector.list();
  await assert.rejects(inspector.inspectFields({...report},'item'),/Inspect this paused Kotlin object/u);
  const fields = await inspector.inspectFields(report,'item');
  const review = await inspector.prepare(fields,'amount','8');
  vscode.debug.activeStackItem.frameId = 3;
  await assert.rejects(inspector.apply(review),/frame changed/u);
  vscode.debug.activeStackItem.frameId = 7;
  state.stopVersion++;
  await assert.rejects(inspector.apply(review),/frame changed/u);
  await inspector.cancel(review);
  assert.deepEqual(commands.map(({args})=>args.action),[undefined,'receivers','fields','prepare','cancel']);
});
