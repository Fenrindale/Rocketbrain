'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {resolveRequest} = require('../src/http/client');
const {previewWorkflow,runWorkflow} = require('../src/http/workflow');

const first = '# @step observe\n# @capture id $.chosen.id\nGET https://example.test/source';
const second = '# @step consume\n# @derive escaped url-component "{{capture.id}}"\n' +
  'GET https://example.test/dependent?from={{escaped}}\nX-Rocketbrain-Input: {{capture.id}}';
const both = (left=first,right=second) => left+'\n###\n'+right;
const response = (body,status=200,assertions=[]) => ({body:JSON.stringify(body),status,assertions,truncated:false});

function execute(plan,send,{signal=new AbortController().signal,assertFresh=()=>{},environment={}}={}) {
  return runWorkflow(plan,{signal,assertFresh,send,prepare:(request,captureValues)=>
    resolveRequest(request,environment,()=>{ throw Error('Unexpected secret access.'); },{captureValues})
  });
}

test('ordered workflow passes a bounded captured scalar as data and returns a payload-free receipt',async()=>{
  const plan=await previewWorkflow(both(),{});
  const requests=[];
  const captured='row /é?& {{secret.unread}}';
  const report=await execute(plan,async ready=>{
    requests.push(ready);
    return ready.url.pathname==='/source'?response({chosen:{id:captured}}):response({captured});
  });
  assert.equal(report.state,'completed');
  assert.deepEqual(report.executed.map(item=>[item.name,item.captured]),[['observe',1],['consume',0]]);
  assert.equal(requests[1].url.searchParams.get('from'),captured);
  assert.equal(requests[1].headers['X-Rocketbrain-Input'],captured);
  assert.ok(!JSON.stringify(report).includes(captured));
});

test('workflow preview refuses extra origins, dynamic paths and captures before they exist',async()=>{
  await assert.rejects(previewWorkflow(both(first,second.replace('example.test','different.example.test')),{}),/single origin/);
  await assert.rejects(previewWorkflow(both(first,second.replace('/dependent?from=','/dependent/')),{}),/path fixed/);
  await assert.rejects(previewWorkflow(both(first,second.replace('capture.id','capture.future')),{}),/earlier workflow capture/);
  await assert.rejects(previewWorkflow(both(first,second.replace('@step consume','@step observe')),{}),/distinct workflow step/);
  await assert.rejects(previewWorkflow(both(first,second.replace('@step consume','@step consume\n# @capture id $.answer')),{}),/distinct workflow captures/);
});

test('workflow stops after failed assertions, redirects and invalid or unsafe captures',async()=>{
  const plan=await previewWorkflow(both(),{});
  for(const [result,reason] of [
    [response({chosen:{id:'usable'}},200,[{kind:'check',name:'rejected',passed:false}]),'response-check'],
    [response({chosen:{id:'usable'}},302),'response-check'],
    [response({chosen:{id:9007199254740992}}),'capture-invalid'],
    [response({chosen:{id:'[redacted]'}}),'capture-invalid'],
    [response({chosen:{id:null}}),'capture-invalid'],
    [{...response({chosen:{id:1}}),truncated:true},'capture-invalid']
  ]) {
    let calls=0;
    const resultSummary=await execute(plan,async()=>{calls++;return result;});
    assert.equal(calls,1);
    assert.equal(resultSummary.reason,reason);
    assert.equal(resultSummary.state,'stopped');
  }
});

test('an execution cancellation or changed context prevents further requests',async()=>{
  const plan=await previewWorkflow(both(),{});
  const controller=new AbortController();
  let calls=0;
  await assert.rejects(execute(plan,async()=>{calls++;controller.abort();return response({chosen:{id:7}});},
    {signal:controller.signal}),{name:'AbortError'});
  assert.equal(calls,1);
  let fresh=true;
  await assert.rejects(execute(plan,async()=>{fresh=false;return response({chosen:{id:5}});},
    {assertFresh(){if(!fresh)throw Error('Workflow source changed.');}}),/source changed/);
});
