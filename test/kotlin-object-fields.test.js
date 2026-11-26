'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createKotlinFieldInspector } = require('../src/java/debug-kotlin-fields');
const { KOTLIN_FIELD_BUILD, KOTLIN_LOCAL_WRITE_BUILD, KOTLIN_FIELD_VALUES_BUILD } = require('../src/java/debug-runtime');
const { JavaDebugAdapter } = require('../src/java/debug-adapter');

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

test('Kotlin field client preserves literal String text and only edits an exact selected array index', async () => {
  const state={state:'stopped',threadId:1,stopVersion:2,appliedVersion:0,debugBuild:KOTLIN_FIELD_VALUES_BUILD};
  const token='9dd8cc72-05ce-46ac-9514-9157c04582da', owner='fixture.KotlinOwner';
  const text='   확인  ', preview=JSON.stringify(text);
  const tracked=[];
  const session={id:'field-client',type:'rocketbrain-java',async customRequest(command,args) {
    if (command==='stackTrace') return {stackFrames:[{id:11,name:'paused'}]};
    tracked.push(args);
    if (args.action==='receivers') return {receivers:[{name:'target',owner}]};
    if (args.action==='fields') return {fields:[
      {name:'message',type:'String',kind:'text',value:'null',boxed:false,writable:true,boxSources:[]},
      {name:'counts',type:'IntArray',kind:'array',value:'length 70',elementType:'Int',length:70,boxed:false,writable:true,boxSources:[]}
    ]};
    if (args.action==='page') return {pageId:token,receiver:'target',name:'counts',start:64,length:70,elementType:'Int',
      items:Array.from({length:6},(_,offset)=>({index:64+offset,value:String(offset)}))};
    if (args.action==='prepare' && args.name==='message') {
      assert.equal(args.input,text);
      return {reviewId:token,owner,receiver:'target',name:'message',type:'String',before:'null',after:preview};
    }
    if (args.action==='prepare') {
      assert.deepEqual([args.pageId,args.index,args.input],[token,65,'8']);
      return {reviewId:token,owner,receiver:'target',name:'counts',type:'Int',index:65,before:'1',after:'8'};
    }
    if (args.action==='apply') return {state:'applied',receiver:'target',name:'counts',index:65,value:'8'};
  }};
  const inspector=createKotlinFieldInspector({debug:{activeDebugSession:session}},{getState:()=>state,ensureTrusted(){}});
  const fields=await inspector.inspectFields(await inspector.list(),'target');
  await assert.rejects(inspector.prepare(fields,'message','x'.repeat(2049)),/at most 2048/u);
  assert.equal((await inspector.prepare(fields,'message',text)).after,preview);
  await assert.rejects(inspector.prepare(fields,'counts','8'),/writable Kotlin field/u);
  await assert.rejects(inspector.inspectArray(fields,'counts',70),/valid element offset/u);
  const page=await inspector.inspectArray(fields,'counts',64);
  assert.equal(tracked.at(-1).count,32);
  await assert.rejects(inspector.prepareElement({...page},65,'8'),/Inspect this paused Kotlin object/u);
  await assert.rejects(inspector.prepareElement(page,63,'8'),/editable Kotlin array element/u);
  const review=await inspector.prepareElement(page,65,'8');
  assert.deepEqual(await inspector.apply(review),{state:'applied',receiver:'target',name:'counts',index:65,value:'8'});
  state.stopVersion++;
  await assert.rejects(inspector.prepareElement(page,65,'8'),/paused Kotlin frame changed/u);
});

test('native Java transport grants Kotlin field values only on the original verified local attach packet', () => {
  const received=[];
  const transport=Object.assign(Object.create(JavaDebugAdapter.prototype),{verifiedFieldPort:50321,
    socket:{write(){}},observeRequest:value=>received.push(value)});
  const attach=(hostName,port)=>transport.handleMessage({type:'request',command:'attach',
    arguments:{hostName,port,rocketbrainLocalKotlinFieldValues:true}});
  attach('127.0.0.1',50321);
  attach('127.0.0.1',50321);
  assert.equal(received[0].arguments.rocketbrainLocalKotlinFieldValues,true);
  assert.equal(received[1].arguments.rocketbrainLocalKotlinFieldValues,undefined);
  transport.verifiedFieldPort=50321;
  attach('127.0.0.1',50322);
  assert.equal(received.at(-1).arguments.rocketbrainLocalKotlinFieldValues,undefined);
  transport.verifiedFieldPort=50321;
  attach('debug.example.invalid',50321);
  assert.equal(received.at(-1).arguments.rocketbrainLocalKotlinFieldValues,undefined);
});
