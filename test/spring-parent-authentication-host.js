'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const {setTimeout:delay}=require('node:timers/promises');
const {ObserverClient}=require('../src/jpa/observer-client');
const {renderAuthenticationDecisions}=require('../src/spring/security-trace-vscode');
const {startSpringSecurityFixture}=require('./helpers/spring-security-fixture');
const {verify:verifyExistingServlet}=require('./spring-authentication-provider-host');
const {verify:verifyExistingReactive}=require('./spring-reactive-security-host');
const {jdbcReadback}=require('./java-source-analysis-host');

const command='rocketbrain.spring.securityTrace.inspectAuthentication';
const title='Spring Authentication Decisions';
const delegatedPath='/custom-authentication-parent';
const opaquePath='/custom-authentication-delegated';
const privateInput='fixture-private-parent-request';
const managerType='org.springframework.security.authentication.ProviderManager';
const fixtureType=member=>'fixture.security.CustomAuthenticationFixture$'+member;
const readConfig=async()=>JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG,'utf8'));
const newest=report=>Math.max(0,...report.traces.map(trace=>trace.id));

async function until(client,test){
  let report;
  for(let end=Date.now()+7000;Date.now()<end;){
    report=await client.securityTrace();
    if(test(report))return report;
    await delay(60);
  }
  const {warnings}=await client.refresh();
  assert.fail('Expected observed Servlet parent delegation: '+JSON.stringify({report,warnings}));
}

function specialized(trace,outcome,leafOutcome,expectedEdges){
  assert.equal(trace.authenticationCoverage,'observed',JSON.stringify(trace));
  const managers=trace.authenticationManagers;
  assert.equal(managers.length,3);
  const ids=managers.map(manager=>manager.managerId);
  assert.equal(new Set(ids).size,3);
  assert.deepEqual(managers.map(manager=>[manager.managerType,manager.outcome,manager.complete,manager.delegated]),
    [[managerType,outcome,true,true],[managerType,outcome,true,true],[managerType,leafOutcome,true,false]]);
  assert.deepEqual(managers.slice(0,2).map(({parentType,selectedProvider})=>[parentType,selectedProvider]),
    [[managerType,null],[managerType,null]]);
  assert.deepEqual(managers.slice(0,2).map(manager=>manager.parentCall),expectedEdges.map(([outcome,disposition],index)=>({
    managerId:ids[index+1],childIndex:index+2,outcome,disposition
  })));
  assert.equal(managers[2].parentCall,undefined);
  assert.deepEqual(managers.map(manager=>manager.providers[0].providerType),
    ['ChildFallbackProvider','MiddleFallbackProvider','ParentLeafProvider'].map(fixtureType));
  return {ids,managers};
}

async function verify(config,{observerJar,showNative}={}){
  assert.ok(['mysql','mariadb'].includes(config.dbEngine));
  assert.equal(config.dbEngine,process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE);
  const data=await jdbcReadback();
  assert.deepEqual(data,{people:2,departments:1,rolledBackNames:0});
  const fixture=await startSpringSecurityFixture(config,{authenticationProviderTrace:true,customAuthentication:true,
    parentAuthentication:true,observerJar});
  const client=new ObserverClient({...fixture.observer,timeoutMs:10000});
  const request=(route,account,password)=>fetch(fixture.baseUrl+route+'?private='+privateInput,{
    signal:AbortSignal.timeout(14000),redirect:'manual',headers:{'X-Private':privateInput,
      ...(account?{Authorization:fixture.auth(account,password)}:{})}
  });
  const counters=async()=>{
    const response=await request('/custom-authentication/parent-counters');
    assert.equal(response.status,200);
    return response.json();
  };
  const after=(report,cut)=>report.traces.filter(trace=>trace.id>cut&&trace.authenticationManagers.length);
  async function one(path,account,status){
    const cutoff=newest(await client.securityTrace());
    const response=await request(path,account);
    assert.equal(response.status,status,path);
    if(response.ok)assert.deepEqual(await response.json(),{people:2});
    else await response.arrayBuffer();
    const current=await until(client,report=>after(report,cutoff).length===1);
    return after(current,cutoff)[0];
  }
  try{
    assert.deepEqual(await counters(),{child:0,middle:0,leaf:0,opaque:0,reads:0});
    const initial=await until(client,report=>report.hooks.includes('authentication-provider-manager'));
    const wrong=fixture.reviewer.password+'-unissued';
    const [success,failure]=await Promise.all([request(delegatedPath,fixture.reviewer),request(delegatedPath,fixture.reviewer,wrong)]);
    assert.equal(success.status,200);
    assert.deepEqual(await success.json(),{people:2});
    assert.equal(failure.status,401);
    await failure.arrayBuffer();
    const requests=after(await until(client,report=>after(report,newest(initial)).length===2),newest(initial));
    const allowed=specialized(requests.find(trace=>trace.status===200),'returned','returned',[['returned','propagated'],['returned','propagated']]);
    const rejected=specialized(requests.find(trace=>trace.status===401),'rejected','rejected',[['rejected','propagated'],['rejected','propagated']]);
    assert.deepEqual(allowed.ids,rejected.ids);
    assert.ok(allowed.managers.slice(0,2).every(manager=>manager.providers[0].outcome==='abstained'));
    assert.equal(allowed.managers[2].providers[0].outcome,'returned');
    assert.equal(allowed.managers[2].selectedProvider,1);
    assert.equal(rejected.managers[2].failureProvider,1);
    assert.equal(rejected.managers[0].failureProvider,undefined);

    const deniedFallback=await one(delegatedPath,fixture.viewer,401);
    const fallback=specialized(deniedFallback,'rejected','rejected',[['provider-not-found','ignored-not-found'],
      ['provider-not-found','ignored-not-found']]);
    assert.equal(fallback.managers[0].failureProvider,1);
    assert.deepEqual(fallback.managers.map(manager=>manager.providers[0].outcome),['rejected','abstained','abstained']);
    assert.equal(fallback.managers[2].failureProvider,undefined);

    const serviceErrorTrace=await one(delegatedPath,fixture.operator,401);
    const serviceError=specialized(serviceErrorTrace,'error','error',[['error','propagated'],['error','propagated']]);
    assert.equal(serviceError.managers[2].failureProvider,1);
    assert.deepEqual(serviceError.ids,fallback.ids);
    assert.deepEqual(serviceError.ids,allowed.ids);

    const [opaqueReturn,opaqueEmpty]=[await one(opaquePath,fixture.reviewer,200),await one(opaquePath,fixture.viewer,401)];
    for(const [trace,outcome,disposition] of [[opaqueReturn,'returned','propagated'],[opaqueEmpty,'empty','unused']]){
      assert.equal(trace.authenticationCoverage,'partial');
      assert.equal(trace.authenticationManagers.length,1);
      const root=trace.authenticationManagers[0];
      assert.equal(root.parentType,fixtureType('OpaqueParent'));
      assert.equal(root.complete,false);
      assert.deepEqual(root.parentCall,{managerId:root.parentCall.managerId,childIndex:null,outcome,disposition});
      assert.match(root.parentCall.managerId,/^manager-\d+$/u);
      assert.ok(!allowed.ids.includes(root.parentCall.managerId));
    }
    assert.equal(opaqueReturn.authenticationManagers[0].parentCall.managerId,opaqueEmpty.authenticationManagers[0].parentCall.managerId);
    const count=await counters();
    assert.deepEqual(count,{child:4,middle:4,leaf:4,opaque:2,reads:2});
    const endpoint=fixture.observer.url+'/security-trace', headers={Authorization:'Bearer '+fixture.observer.token};
    assert.equal((await fetch(endpoint)).status,401);
    assert.equal((await fetch(endpoint,{method:'POST',headers})).status,405);
    assert.equal((await fetch(endpoint+'?replay=1',{headers})).status,400);
    const raw=await fetch(endpoint,{headers}).then(response=>response.text());
    const report=await client.securityTrace(), html=renderAuthenticationDecisions(report);
    for(const value of [privateInput,delegatedPath,opaquePath,'fixture-private-child-rejection','fixture-private-provider-exception-message',
      fixture.observer.token,fixture.auth(fixture.reviewer),wrong,'ROLE_FIXTURE_CUSTOM',
      ...[fixture.operator,fixture.viewer,fixture.reviewer].flatMap(item=>[item.name,item.password])]){
      assert.ok(!raw.includes(value)&&!html.includes(value),'Unexpected private fixture data');
    }
    assert.match(html,/Invocation 2/u);
    assert.match(html,/Ignored by the calling manager/u);
    assert.match(html,/Failure retained by manager/u);
    assert.match(html,/Parent internals unavailable/u);
    if(showNative)await showNative(fixture.observer);
    assert.deepEqual(await counters(),count);
    const reset=await client.securityTrace();
    assert.equal(reset.traces[0].authenticationCoverage,'unobserved');
    assert.deepEqual(reset.traces[0].authenticationManagers,[]);
    assert.deepEqual(await jdbcReadback(),data);
    return {engine:config.dbEngine,jdbc:data,parentDepth:2,concurrentStatuses:[200,401],observedNestedRequests:4,
      outcomes:['returned','rejected','provider-not-found','error'],retainedLocalFailure:true,opaqueBoundaryOnly:true,
      resetAfterRequest:true,providerCountsUnchanged:true,privateValuesOmitted:true,nativeView:Boolean(showNative)};
  }finally{client.dispose();await fixture.close();}
}

async function runSpringParentAuthenticationChecks(api,vscode,checks){
  const config=await readConfig();
  const prepared=await vscode.commands.executeCommand('rocketbrain.jpa.observer.prepare');
  assert.equal(prepared.authenticationProviderTraceEnabled,false);
  assert.equal(JSON.parse(await fs.readFile(prepared.configFile,'utf8')).authenticationProviderTrace,false);
  const proof=await verify(config,{observerJar:prepared.jar,async showNative(observed){
    await api.jpa.observer.connect(observed);
    try{
      const result=await vscode.commands.executeCommand(command);
      assert.equal(result?.view,command);
      assert.ok(result.traces.some(trace=>trace.authenticationCoverage==='observed'&&trace.authenticationManagers.length===3));
      assert.ok(result.traces.some(trace=>trace.authenticationManagers?.some(manager=>manager.parentCall?.disposition==='ignored-not-found'&&
        manager.failureProvider===1)));
      const visible=()=>vscode.window.tabGroups.all.some(group=>group.tabs.some(tab=>tab.label===title));
      const deadline=Date.now()+5000;
      while(!visible()&&Date.now()<deadline)await delay(60);
      assert.ok(visible());
    }finally{api.jpa.observer.disconnect();}
  }});
  checks.push('Installed Spring Authentication Decisions showed two actual nested parent calls, propagated outcomes, and a retained local rejection with opaque custom parent coverage stated separately.');
  return proof;
}

module.exports={runSpringParentAuthenticationChecks};
if(require.main===module)readConfig().then(async config=>{
  const linked=await verify(config);
  const fixture=await startSpringSecurityFixture(config,{authenticationProviderTrace:true,customAuthentication:true});
  let servlet;
  try{servlet=await verifyExistingServlet(fixture,config);}
  finally{await fixture.close();}
  const reactive=await verifyExistingReactive(config);
  return {...linked,version:servlet.version,legacyServletProviders:servlet.observedProviders,legacyReactive:reactive.actualJdbc&&reactive.concurrentCorrelation};
}).then(result=>console.log(JSON.stringify(result)),error=>{console.error(error.stack);process.exitCode=1;});
