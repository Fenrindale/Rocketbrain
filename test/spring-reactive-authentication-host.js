'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const {setTimeout:delay}=require('node:timers/promises');
const {ObserverClient}=require('../src/jpa/observer-client');
const {renderReactiveSecurityTrace}=require('../src/spring/reactive-security-trace-vscode');
const {startReactiveSecurityFixture}=require('./helpers/spring-reactive-security-fixture');
const {jdbcReadback}=require('./java-source-analysis-host');
const {verify:verifyLegacy}=require('./spring-reactive-security-host');

const view='rocketbrain.spring.reactiveSecurityTrace';
const title='Reactive Spring Security Trace';
const manager='org.springframework.security.authentication.DelegatingReactiveAuthenticationManager';
const probe='fixture.reactive.ReactiveSecurityFixture$ProbeDelegate';
const provider='fixture.reactive.ReactiveSecurityFixture$FixtureProvider';
const canary='fixture-private-reactive-query';
const authHooks=['authentication-manager','authentication-delegates'];
const authPath='/reactive-security-trace';
const baseConfig=async()=>JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG,'utf8'));

function send(fixture,method,account,path='/auth-observed/read'){
  const headers=account?{Authorization:fixture.authorization(account),'X-Private':canary}:{};
  return fetch(fixture.baseUrl+path+'?request='+canary,{method,headers,redirect:'error',signal:AbortSignal.timeout(12000)});
}

async function until(client,check){
  let latest;
  for(let deadline=Date.now()+8000;Date.now()<deadline;){
    latest=await client.reactiveSecurityTrace();
    if(check(latest))return latest;
    await delay(80);
  }
  const {warnings}=await client.refresh();
  assert.fail('Expected completed authentication observation: '+JSON.stringify({latest,warnings}));
}

async function verifyDefault(config,observerJar){
  const fixture=await startReactiveSecurityFixture(config,{authenticationFixture:true,observerJar});
  const client=new ObserverClient(fixture.observer);
  try{
    const response=await send(fixture,'GET',fixture.ops);
    assert.equal(response.status,200);
    assert.equal((await response.json()).jdbc,true);
    const report=await until(client,current=>current.traces.some(row=>row.status===200&&row.methodDecisions.length));
    assert.equal(report.authenticationEnabled,undefined);
    assert.ok(report.hooks.every(hook=>!authHooks.includes(hook)));
    assert.ok(report.traces.every(row=>row.authenticationAttempts===undefined&&row.authenticationLimited===undefined));
    return true;
  }finally{client.dispose();await fixture.close();}
}

function verifyAttempt(sample,status,outcome,outcomes){
  assert.equal(sample.status,status,JSON.stringify(sample));
  assert.equal(sample.authenticationLimited,false);
  assert.equal(sample.authenticationAttempts.length,1);
  const attempt=sample.authenticationAttempts[0];
  assert.deepEqual([attempt.managerId,attempt.managerType,attempt.outcome,attempt.delegateCoverage],[1,manager,outcome,'observed']);
  assert.deepEqual(attempt.delegates.map(entry=>[entry.sequence,entry.parent,entry.managerId,entry.managerType,entry.outcome]),
    [[1,0,2,probe,outcomes[0]],[2,0,3,manager,outcomes[1]],[3,2,4,probe,outcomes[2]],[4,2,5,provider,outcomes[3]]]);
  return outcome;
}

async function verify(config,{observerJar,showNative}={}){
  assert.ok(['mysql','mariadb'].includes(config.dbEngine));
  assert.equal(config.dbEngine,process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE);
  const jdbc=await jdbcReadback();
  assert.deepEqual(jdbc,{people:2,departments:1,rolledBackNames:0});
  const defaultOff=await verifyDefault(config,observerJar);
  const fixture=await startReactiveSecurityFixture(config,{authentication:true,observerJar});
  const client=new ObserverClient({...fixture.observer,timeoutMs:10000});
  const readCounters=async()=>{
    const response=await send(fixture,'GET',null,'/review-counters');
    assert.equal(response.status,200);
    return response.json();
  };
  const newAttempts=(value,after)=>value.traces.filter(row=>row.id>after&&row.authenticationAttempts?.length);
  const newest=value=>Math.max(0,...value.traces.map(row=>row.id));
  try{
    const initial=await until(client,report=>report.traces.length>0);
    assert.equal(initial.authenticationEnabled,true);
    assert.ok(initial.traces.every(row=>row.authenticationAttempts.length===0));
    assert.deepEqual(await readCounters(),{first:0,nested:0,provider:0});
    const cut=newest(await client.reactiveSecurityTrace());
    const wrong={...fixture.viewer,password:'fixture-private-wrong-password'};
    const [good,denied]=await Promise.all([send(fixture,'GET',fixture.ops),send(fixture,'POST',wrong)]);
    assert.equal(good.status,200);
    assert.deepEqual(await good.json(),{value:42,jdbc:true,schedulerChanged:true});
    assert.equal(denied.status,401);
    await denied.text();
    const concurrent=newAttempts(await until(client,report=>newAttempts(report,cut).length===2),cut);
    const allowed=concurrent.find(trace=>trace.method==='GET'), rejected=concurrent.find(trace=>trace.method==='POST');
    assert.ok(allowed&&rejected);
    const outcomes=[verifyAttempt(allowed,200,'returned',['empty','returned','rejected','returned']),
      verifyAttempt(rejected,401,'rejected',['empty','rejected','empty','rejected'])];
    assert.equal(allowed.verification,'passed');
    assert.deepEqual(allowed.methodDecisions.map(decision=>[decision.method,decision.decision]),[['before','granted']]);
    assert.deepEqual(rejected.methodDecisions,[]);
    for(const [account,outcome] of [[fixture.unmatched,'empty'],[fixture.authError,'error']]){
      const cutoff=newest(await client.reactiveSecurityTrace());
      const response=await send(fixture,'GET',account);
      assert.equal(response.status,500);
      await response.text();
      const latest=await until(client,report=>newAttempts(report,cutoff).length===1);
      outcomes.push(verifyAttempt(newAttempts(latest,cutoff)[0],500,outcome,['empty',outcome,'empty',outcome]));
    }
    const counts=await readCounters();
    assert.deepEqual(counts,{first:4,nested:4,provider:4});
    const report=await client.reactiveSecurityTrace();
    assert.ok(authHooks.every(hook=>report.hooks.includes(hook)));
    const endpoint=fixture.observer.url+authPath;
    assert.equal((await fetch(endpoint)).status,401);
    const headers={Authorization:'Bearer '+fixture.observer.token};
    assert.equal((await fetch(endpoint,{method:'POST',headers})).status,405);
    assert.equal((await fetch(endpoint+'?replay=true',{headers})).status,400);
    assert.equal((await fetch(endpoint,{headers:{...headers,Origin:'http://localhost'}})).status,403);
    const raw=await fetch(endpoint,{headers}).then(response=>response.text());
    const html=renderReactiveSecurityTrace(report);
    for(const value of [...[fixture.ops,fixture.viewer,fixture.unmatched,fixture.authError,wrong]
      .flatMap(account=>[account.name,account.password,fixture.authorization(account)]),canary,fixture.observer.token,
      '/auth-observed/', 'fixture-private-reactive-rejection','fixture-private-reactive-error','fixture-private-reactive-call','ROLE_']){
      assert.ok(!raw.includes(value)&&!html.includes(value),'Private fixture data leaked');
    }
    assert.match(html,/Reactive authentication/u);
    assert.match(html,/Dispatched by step 2/u);
    assert.match(html,/Completed without a result/u);
    if(showNative)await showNative(fixture.observer,outcomes);
    assert.deepEqual(await readCounters(),counts);
    assert.deepEqual(await jdbcReadback(),jdbc);
    return {engine:config.dbEngine,jdbc,actualWebFluxJdbc:true,outcomes,delegateSubscriptions:16,
      preservedRequestCorrelation:true,nestedDelegateOrder:[0,0,2,2],duplicateDelegateClassDistinguished:true,
      fallThroughOnErrorObserved:true,disabledWithoutSecondOptIn:defaultOff,privateValuesDiscarded:true,
      providerCountsUnchanged:true,existingChainAndMethodAuthorization:true,nativeView:Boolean(showNative)};
  }finally{client.dispose();await fixture.close();}
}

async function runReactiveAuthenticationChecks(api,vscode,checks){
  const config=await baseConfig();
  const prepared=await vscode.commands.executeCommand('rocketbrain.jpa.observer.prepare');
  assert.equal(prepared.securityReactiveAuthenticationTraceEnabled,false);
  assert.equal(JSON.parse(await fs.readFile(prepared.configFile,'utf8')).securityReactiveAuthenticationTrace,false);
  const proof=await verify(config,{observerJar:prepared.jar,async showNative(observed,outcomes){
    await api.jpa.observer.connect(observed);
    try{
      const result=await vscode.commands.executeCommand(view);
      assert.equal(result?.view,view);
      assert.equal(result.authenticationEnabled,true);
      const attempts=result.traces.flatMap(row=>row.authenticationAttempts);
      for(const outcome of outcomes)assert.ok(attempts.some(attempt=>attempt.outcome===outcome&&attempt.delegates.length===4));
      const visible=()=>vscode.window.tabGroups.all.some(group=>group.tabs.some(tab=>tab.label===title));
      const deadline=Date.now()+5000;
      while(!visible()&&Date.now()<deadline)await delay(50);
      assert.ok(visible());
    }finally{api.jpa.observer.disconnect();}
  }});
  checks.push('Installed Reactive Spring Security Trace showed the actual nested delegate order and emitted, empty, rejected and error outcomes across concurrent WebFlux requests. Inspection left the application’s authentication provider counters unchanged.');
  return proof;
}

module.exports={runReactiveAuthenticationChecks};
if(require.main===module)baseConfig().then(async config=>{
  const actual=await verify(config);
  const legacy=await verifyLegacy(config);
  return {...actual,legacyTraceVerified:legacy.duplicateFilterInstances&&legacy.concurrentCorrelation&&legacy.actualJdbc};
}).then(result=>console.log(JSON.stringify(result)),error=>{console.error(error.stack);process.exitCode=1;});
