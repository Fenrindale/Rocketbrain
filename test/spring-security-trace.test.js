'use strict';

const http=require('node:http');
const assert=require('node:assert/strict');
const test=require('node:test');
const { ObserverClient }=require('../src/jpa/observer-client');
const { normalizeSecurityTrace }=require('../src/spring/security-trace');
const { registerSecurityTrace,renderSecurityTrace,renderAuthenticationDecisions }=require('../src/spring/security-trace-vscode');

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
  const view=registerSecurityTrace(vscode,{command(id,fn){if(id==='rocketbrain.spring.securityTrace')open=fn;},
    target:()=>({client,assertCurrent(){if(stale)throw Error('Reconnected');}})});
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

test('method decisions keep phase, source and allowlisted roles separate from request authorization',()=>{
  const event={phase:'after',manager:'fixture.Policy',delegateManager:null,owner:'fixture.Service',method:'read',
    parameterTypes:['java.lang.String','byte[]'],decision:'denied',decisionSource:'framework-result',
    roleSources:['role-hierarchy'],checkedRoles:['ROLE_FIXTURE_VIEWER'],matchedRoles:[]};
  const data={...structuredClone(report),methodTraceEnabled:true,roleDisclosureEnabled:true,
    hooks:[...report.hooks,'method-before','method-after','method-roles']};
  data.traces[0].methodCoverage='observed';
  data.traces[0].methodDecisions=[{...event,principal:'private-principal',argument:'private-argument',expression:'private-expression'}];
  const normalized=normalizeSecurityTrace(data);
  assert.deepEqual(normalized.traces[0].methodDecisions,[event]);
  assert.equal(normalized.traces[0].authorizationDecision,'unobserved');
  assert.doesNotMatch(JSON.stringify(normalized),/private-principal|private-argument|private-expression/);
  const html=renderSecurityTrace(normalized);
  assert.match(html,/Method authorization[\s\S]*fixture\.Service\.read[\s\S]*After invocation[\s\S]*denied[\s\S]*Spring role hierarchy · Compared ROLE_FIXTURE_VIEWER/);
  assert.doesNotMatch(html,/<script/);
  const malformed=[
    value=>value.roleDisclosureEnabled=false,
    value=>value.traces[0].methodCoverage='disabled',
    value=>value.traces[0].methodDecisions=Array.from({length:9},()=>event),
    value=>value.traces[0].methodDecisions[0].matchedRoles=['ROLE_PRIVATE'],
    value=>value.traces[0].methodDecisions[0].decisionSource='no-result',
    value=>value.traces[0].methodDecisions[0].checkedRoles=['<img>'],
    value=>value.traces[0].methodDecisions[0].roleSources=[],
    value=>value.hooks=value.hooks.filter(hook=>hook!=='method-after')
  ];
  for(const corrupt of malformed){
    const invalid=structuredClone(data);
    corrupt(invalid);
    assert.throws(()=>normalizeSecurityTrace(invalid),/Unsupported/);
  }
  const redacted=structuredClone(data);
  redacted.roleDisclosureEnabled=false;
  redacted.traces[0].methodDecisions[0].checkedRoles=[];
  const redactedDisplay=renderSecurityTrace(normalizeSecurityTrace(redacted));
  assert.match(redactedDisplay,/Role labels hidden/);
  assert.doesNotMatch(redactedDisplay,/ROLE_FIXTURE_VIEWER/);
  const waiting=structuredClone(data);
  waiting.traces[0].methodCoverage='unavailable';
  waiting.traces[0].methodDecisions=[];
  waiting.hooks=report.hooks;
  assert.match(renderSecurityTrace(normalizeSecurityTrace(waiting)),/Supported method interceptors are unavailable/);
});

test('authentication reports only bounded provider provenance and preserves partial parent outcomes',()=>{
  const data=structuredClone(report), trace=data.traces[0];
  data.authenticationProviderTraceEnabled=true;
  data.hooks.push('authentication-provider-manager');
  trace.authenticationCoverage='observed';
  trace.authenticationManagers=[{index:1,managerId:'manager-1',managerType:'fixture.ProviderManager',
    outcome:'returned',selectedProvider:2,delegated:false,parentType:null,complete:true,principal:'private-input',
    providers:[{index:1,providerType:'fixture.First',outcome:'rejected',exceptionMessage:'private-rejection'},
      {index:2,providerType:'fixture.Second',outcome:'returned',result:{credentials:'private-result'}}]}];
  const clean=normalizeSecurityTrace(data);
  assert.doesNotMatch(JSON.stringify(clean),/private-/);
  assert.match(renderAuthenticationDecisions(clean),/fixture\.First[\s\S]*Raised an authentication rejection[\s\S]*fixture\.Second[\s\S]*Returned by manager/);
  assert.doesNotMatch(renderAuthenticationDecisions(clean),/<script|private-/);
  for(const change of [
    value=>value.authenticationProviderTraceEnabled=false,
    value=>value.hooks.pop(),
    value=>value.traces[0].authenticationCoverage='unobserved',
    value=>value.traces[0].authenticationManagers=Array(7).fill(trace.authenticationManagers[0]),
    value=>value.traces[0].authenticationManagers[0].providers=Array(13).fill(trace.authenticationManagers[0].providers[0]),
    value=>value.traces[0].authenticationManagers[0].providers[0].providerType='<script>',
    value=>value.traces[0].authenticationManagers[0].selectedProvider=1,
    value=>value.traces[0].authenticationManagers[0].parentType='fixture.Parent',
    value=>value.traces[0].authenticationManagers[0].outcome='rejected'
  ]){
    const malformed=structuredClone(data);
    change(malformed);
    assert.throws(()=>normalizeSecurityTrace(malformed),/Unsupported/);
  }
  trace.authenticationCoverage='partial';
  Object.assign(trace.authenticationManagers[0],{delegated:true,parentType:'fixture.Parent',complete:false,selectedProvider:null,providers:[]});
  assert.match(renderAuthenticationDecisions(normalizeSecurityTrace(data)),/Partial authentication evidence[\s\S]*Delegated to fixture\.Parent/);
  data.hooks.pop();
  trace.authenticationCoverage='unavailable';
  trace.authenticationManagers=[];
  assert.match(renderAuthenticationDecisions(normalizeSecurityTrace(data)),/Waiting for a supported Servlet ProviderManager/);
  assert.match(renderAuthenticationDecisions(report),/authenticationProviderTrace/);
});
