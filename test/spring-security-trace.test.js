'use strict';

const http=require('node:http');
const assert=require('node:assert/strict');
const test=require('node:test');
const { ObserverClient }=require('../src/jpa/observer-client');
const { normalizeSecurityTrace }=require('../src/spring/security-trace');
const { registerSecurityTrace,renderSecurityTrace }=require('../src/spring/security-trace-vscode');

const short='org.springframework.security.web.authentication.www.BasicAuthenticationFilter';
const last='org.springframework.security.web.access.intercept.AuthorizationFilter';
const sample={id:3,startedAt:'2026-11-26T01:40:02.321Z',durationMs:5,method:'GET',status:401,completed:true,
  coverage:'observed',selectedChain:2,matches:[{index:1,chainType:'fixture.Chain',matcherType:'fixture.Matcher',matched:false},
    {index:2,chainType:'fixture.Chain',matcherType:'fixture.AnyMatcher',matched:true}],configured:[short,last],entered:[short],authorizationDecision:'unobserved'};
const report={state:'ready',enabled:true,hooks:['proxy','standard-execution','authorization'],dropped:1,traces:[sample]};

test('trace projection retains ordered filter evidence and discards request values',()=>{
  const data=structuredClone(report);
  data.traces[0].request={path:'secret-path',headers:{authorization:'secret-token'}};
  data.traces[0].matches[0].matcherText='secret-path';
  const clean=normalizeSecurityTrace(data);
  assert.deepEqual(clean,report);
  assert.doesNotMatch(JSON.stringify(clean),/secret-path|secret-token/);
  const html=renderSecurityTrace(clean);
  assert.match(html,/401/);
  assert.match(html,/Did not match[\s\S]*Matched and selected/);
  assert.match(html,/BasicAuthenticationFilter[\s\S]*Entered[\s\S]*AuthorizationFilter[\s\S]*Execution stopped earlier/);
  assert.match(html,/default-src 'none'/);
  assert.doesNotMatch(html,/<script/);
  for(const change of [value=>value.traces[0].entered=[last],value=>value.traces[0].selectedChain=1,
    value=>value.traces[0].matches[0].matched=true,value=>value.traces[0].configured[0]='https://example.invalid/private',
    value=>value.traces[0].method='GET_PRIVATE_TOKEN',value=>value.traces=Array.from({length:33},()=>sample)]){
    const malformed=structuredClone(report);change(malformed);
    assert.throws(()=>normalizeSecurityTrace(malformed),/Unsupported/);
  }
  assert.deepEqual(normalizeSecurityTrace({enabled:false,state:'disabled',dropped:0,hooks:[],traces:[]}),
    {enabled:false,state:'disabled',dropped:0,hooks:[],traces:[]});
});

test('observer uses one authenticated GET for a trace; the native view rejects stale responses',async()=>{
  const token='1'.repeat(40),requests=[];
  const host=http.createServer((request,response)=>{
    requests.push([request.method,request.url,request.headers.authorization]);
    response.setHeader('Content-Type','application/json');response.end(JSON.stringify(report));
  });
  await new Promise(resolve=>host.listen(0,'127.0.0.1',resolve));
  const client=new ObserverClient({url:'http://127.0.0.1:'+host.address().port,token});
  let panel,open,stale=false;
  const vscode={ViewColumn:{Beside:2},window:{createWebviewPanel(_id,title,_column,options){
    assert.equal(title,'Spring Security Filter Trace');
    assert.deepEqual(options,{enableScripts:false,localResourceRoots:[],enableCommandUris:false});
    return panel={webview:{},reveal(){},onDidDispose(fn){this.disposeEvent=fn;},dispose(){this.disposeEvent();panel=undefined;}};
  }}};
  const view=registerSecurityTrace(vscode,{command(_id,fn){open=fn;},target:()=>({client,assertCurrent(){if(stale)throw Error('Reconnected');}})});
  try{
    assert.equal((await open()).view,'rocketbrain.spring.securityTrace');
    assert.deepEqual(requests,[['GET','/security-trace','Bearer '+token]]);
    assert.match(panel.webview.html,/Authorization decision unavailable/);
    view.close();assert.equal(panel,undefined);
    stale=true;
    await assert.rejects(open,/Reconnected/);
    assert.equal(panel,undefined);
  }finally{view.close();client.dispose();await new Promise(resolve=>host.close(resolve));}
});
