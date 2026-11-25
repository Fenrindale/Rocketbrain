'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const { ObserverClient }=require('../src/jpa/observer-client');
const { startSpringSecurityFixture }=require('./helpers/spring-security-fixture');

const view='rocketbrain.spring.securityTrace', title='Spring Security Filter Trace';
const allowedRoles=['ROLE_DATA_READ','ROLE_VIEWER'];
const privateProbe='private-method-input-rocketbrain';
const type='fixture.security.MethodPermissionFixture';
const methodHooks=['method-before','method-after','method-roles','method-manager'];

async function fixtureConfig(){
  const config=JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG,'utf8'));
  assert.ok(['mysql','mariadb'].includes(config.dbEngine));
  return config;
}

async function usingFixture(config,roleDisclosure,observerJar,verify){
  const traceRoles=roleDisclosure?allowedRoles:[];
  const fixture=await startSpringSecurityFixture(config,{trace:true,methodTrace:true,traceRoles,observerJar});
  const client=new ObserverClient({...fixture.observer,timeoutMs:10000});
  const get=(route,account)=>fetch(fixture.baseUrl+route+'?probe='+privateProbe,{redirect:'manual',signal:AbortSignal.timeout(10000),
    headers:{Authorization:fixture.auth(account),'X-Method-Sentinel':privateProbe}});

  async function track(route,account){
    const latest=await client.securityTrace();
    const cut=latest.traces[0]?.id??0;
    const response=await get(route,account),body=await response.text(),report=await client.securityTrace();
    assert.equal(report.methodTraceEnabled,true,JSON.stringify(report.hooks));
    assert.equal(report.roleDisclosureEnabled,roleDisclosure);
    const additions=report.traces.filter(trace=>trace.id>cut);
    assert.equal(additions.length,1,JSON.stringify(report.traces.map(({id,status,coverage})=>({id,status,coverage}))));
    const trace=additions[0];
    assert.equal(trace.status,response.status);
    const missing=methodHooks.filter(hook=>!report.hooks.includes(hook));
    if(missing.length)assert.fail(JSON.stringify({missing,hooks:report.hooks,warnings:(await client.refresh()).warnings}));
    const serialized=JSON.stringify(report);
    for(const secret of [privateProbe,'/method/','ROLE_PRIVATE_FIXTURE_AUTHORITY',fixture.viewer.name,
      fixture.reviewer.name,fixture.reviewer.password,fixture.auth(account)])
      assert.equal(serialized.includes(secret),false);
    return {trace,body};
  }

  try{return await verify(fixture,track,get,client);}finally{client.dispose();await fixture.close();}
}

function observed(item,phase,outcome,httpStatus,expectedChecked,expectedMatched){
  const {trace}=item;
  assert.equal(trace.status,httpStatus);
  assert.equal(trace.coverage,'observed');
  assert.equal(trace.methodCoverage,'observed',JSON.stringify(trace.methodDecisions));
  assert.equal(trace.authorizationDecision,'granted');
  assert.equal(trace.methodDecisions.length,1,JSON.stringify(trace.methodDecisions));
  const event=trace.methodDecisions[0];
  assert.equal(event.owner,type);
  assert.equal(event.method,phase);
  assert.deepEqual(event.parameterTypes,['java.lang.String']);
  assert.equal(event.phase,phase);
  assert.equal(event.decision,outcome);
  assert.equal(event.decisionSource,'framework-result');
  assert.match(event.manager,/ObservationAuthorizationManager$/);
  assert.match(event.delegateManager,phase==='before'?/PreAuthorizeAuthorizationManager$/:/PostAuthorizeAuthorizationManager$/);
  assert.deepEqual(event.roleSources,['role-hierarchy']);
  assert.deepEqual(event.checkedRoles,expectedChecked);
  assert.deepEqual(event.matchedRoles,expectedMatched);
}

async function verify(config,showNative,observerJar){
  await usingFixture(config,false,observerJar,async (fixture,track)=>{
    const allowed=await track('/method/before',fixture.reviewer);
    observed(allowed,'before','granted',200,[],[]);
    assert.deepEqual(JSON.parse(allowed.body),{people:2,departments:1});
    const denied=await track('/method/after',fixture.viewer);
    observed(denied,'after','denied',403,[],[]);
  });

  return usingFixture(config,true,observerJar,async (fixture,track,get,client)=>{
    const beforeDenied=await track('/method/before',fixture.viewer);
    const beforeGranted=await track('/method/before',fixture.reviewer);
    const afterDenied=await track('/method/after',fixture.viewer);
    const afterGranted=await track('/method/after',fixture.reviewer);
    observed(beforeDenied,'before','denied',403,['ROLE_VIEWER'],[]);
    observed(beforeGranted,'before','granted',200,['ROLE_DATA_READ'],['ROLE_DATA_READ']);
    observed(afterDenied,'after','denied',403,['ROLE_VIEWER'],[]);
    observed(afterGranted,'after','granted',200,['ROLE_DATA_READ'],['ROLE_DATA_READ']);
    for(const item of [beforeGranted,afterGranted])assert.deepEqual(JSON.parse(item.body),{people:2,departments:1});
    const counters=await get('/method/counters',fixture.reviewer);
    assert.equal(counters.status,200);
    assert.deepEqual(await counters.json(),{before:1,after:2});
    const repeated=await track('/method/repeated',fixture.reviewer);
    assert.equal(repeated.trace.status,200);
    assert.deepEqual(JSON.parse(repeated.body),{invocations:10});
    assert.equal(repeated.trace.methodCoverage,'partial');
    assert.equal(repeated.trace.methodDecisions.length,8);
    assert.ok(repeated.trace.methodDecisions.every(event=>event.phase==='before'&&event.decision==='granted'));
    const raw=await (await fetch(fixture.observer.url+'/security-trace',{headers:{Authorization:'Bearer '+fixture.observer.token}})).text();
    for(const value of [privateProbe,'/method/','ROLE_PRIVATE_FIXTURE_AUTHORITY','ROLE_REVIEWER',
      fixture.reviewer.name,fixture.reviewer.password,fixture.auth(fixture.viewer)])assert.equal(raw.includes(value),false);
    assert.equal((await client.refresh()).methodDecisions,undefined);
    if(showNative)await showNative(fixture.observer);
    return {engine:config.dbEngine,preAuthorize:[403,200],postAuthorize:[403,200],filterGrantedMethodDenied:true,
      actualJdbc:true,beforeReads:1,afterReads:2,roleHierarchyEvidence:true,allowlistOnly:true,privateValuesDiscarded:true,
      roleLabelsHiddenByDefault:true,nativeMethodSecurity:Boolean(showNative),maxDecisionsPerRequest:8,observedCap:true};
  });
}

async function runSpringMethodSecurityChecks(api,vscode,checks){
  const config=await fixtureConfig();
  const preparation=await vscode.commands.executeCommand('rocketbrain.jpa.observer.prepare');
  assert.equal(preparation.securityMethodTraceEnabled,false);
  const defaults=JSON.parse(await fs.readFile(preparation.configFile,'utf8'));
  assert.equal(defaults.securityMethodTrace,false);
  assert.deepEqual(defaults.securityTraceRoles,[]);
  const visible=()=>vscode.window.tabGroups.all.some(group=>group.tabs.some(tab=>tab.label===title));
  const result=await verify(config,async observer=>{
    await api.jpa.observer.connect(observer);
    try {
      const opened=await vscode.commands.executeCommand(view);
      assert.equal(opened?.view,view);
      assert.equal(opened.methodTraceEnabled,true);
      const phases=opened.traces.flatMap(trace=>trace.methodDecisions);
      assert.ok(phases.some(event=>event.phase==='before'&&event.decision==='denied'));
      assert.ok(phases.some(event=>event.phase==='after'&&event.matchedRoles.includes('ROLE_DATA_READ')));
      const deadline=Date.now()+5000;
      while(!visible()&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,60));
      assert.ok(visible());
    }finally{api.jpa.observer.disconnect();}
  },preparation.jar);
  checks.push('The installed Spring Security trace shows actual before/after authorization, effective role comparisons, privacy defaults and bounded method evidence.');
  return result;
}

module.exports={verify,runSpringMethodSecurityChecks};
if(require.main===module)fixtureConfig().then(config=>verify(config)).then(report=>console.log(JSON.stringify(report)),error=>{
  console.error(error.stack);process.exitCode=1;
});
