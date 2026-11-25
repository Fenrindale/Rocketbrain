'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const { startSpringSecurityFixture }=require('./helpers/spring-security-fixture');

async function runSpringSecurityChecks(api,vscode,checks) {
  const config=JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG,'utf8'));
  assert.equal(config.dbEngine,process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE);
  const fixture=await startSpringSecurityFixture(config);
  const runtime=api.java.spring.runtime, security=runtime.security;
  const id='rocketbrain.spring.runtimeSecurity';
  const request=(suffix,account,password)=>fetch(fixture.baseUrl+suffix,{redirect:'manual',signal:AbortSignal.timeout(9000),
    headers:account?{Authorization:fixture.auth(account,password)}:{}});
  const updates=[];
  const subscription=security.onDidChange(state=>updates.push(state.state));
  try {
    assert.ok((await vscode.commands.getCommands(true)).includes(id));
    assert.equal((await vscode.commands.executeCommand(id)).state,'disconnected');
    const management=fixture.baseUrl+'/actuator';
    const anonymous=(await request('/secure/db')).status;
    const rejected=(await request('/secure/db',fixture.reviewer,'unissued-fixture-password')).status;
    const denied=(await request('/secure/db',fixture.viewer)).status;
    const allowed=await request('/secure/db',fixture.reviewer);
    assert.deepEqual([anonymous,rejected,denied,allowed.status],[401,401,403,200]);
    const jdbc=await allowed.json();
    const original=await fetch(config.baseUrl+'/probe/testing-state',{signal:AbortSignal.timeout(9000)});
    assert.equal(original.status,200);
    assert.deepEqual(jdbc,(({people,departments})=>({people,departments}))(await original.json()));
    assert.deepEqual(jdbc,{people:2,departments:1});
    const inaccessible=await runtime.connect({url:management,authorization:fixture.auth(fixture.viewer),timeoutMs:10000});
    assert.equal(inaccessible.state,'error');
    const forbidden=(await security.refresh()).report;
    assert.equal(forbidden.state,'unavailable');
    assert.deepEqual(Object.values(forbidden.endpoints).map(endpoint=>endpoint.status),[403,403,403]);
    assert.equal(forbidden.audit,null);
    const operator=await runtime.connect({url:management,authorization:fixture.auth(fixture.operator),timeoutMs:10000});
    assert.equal(operator.state,'connected');
    const observed=(await vscode.commands.executeCommand(id)).report;
    assert.equal(observed.state,'observed');
    assert.deepEqual(Object.values(observed.endpoints).map(endpoint=>endpoint.state),['available','available','available']);
    const chains=observed.beans.filter(bean=>bean.kind==='filter-chain').map(bean=>bean.name).sort();
    assert.ok(chains.includes('fixtureManagementChain') && chains.includes('fixtureApplicationChain'));
    const match=(type,principal)=>observed.audit.events.some(event=>event.type===type && event.principal===principal);
    assert.equal(match('AUTHENTICATION_SUCCESS',fixture.reviewer.name),true);
    assert.equal(match('AUTHENTICATION_FAILURE',fixture.reviewer.name),true);
    assert.equal(match('AUTHORIZATION_FAILURE',fixture.viewer.name),true);
    const filtered=(await security.refresh({minutes:5,principal:fixture.viewer.name,type:'AUTHORIZATION_FAILURE'})).report;
    assert.equal(filtered.selection.filteredPrincipal,true);
    assert.equal(filtered.audit.events.length>=1,true);
    assert.ok(filtered.audit.events.every(event=>event.type==='AUTHORIZATION_FAILURE' && event.principal===fixture.viewer.name));
    const params=new URLSearchParams({after:filtered.selection.after,principal:fixture.viewer.name,type:'AUTHORIZATION_FAILURE'});
    const direct=await request('/actuator/auditevents?'+params,fixture.operator);
    assert.equal(direct.status,200);
    const published=(await direct.json()).events;
    assert.deepEqual(filtered.audit.events.map(({timestamp,principal,type})=>({timestamp,principal,type})),
      published.map(({timestamp,principal,type})=>({timestamp,principal,type})).sort((a,b)=>Date.parse(b.timestamp)-Date.parse(a.timestamp)));
    assert.ok(filtered.audit.events.every(item=>Object.keys(item).sort().join(',')==='outcome,principal,timestamp,type'));
    const serialized=JSON.stringify([observed,filtered]);
    for (const account of [fixture.operator,fixture.reviewer,fixture.viewer]) {
      assert.equal(serialized.includes(account.password),false);
      assert.equal(serialized.includes(fixture.auth(account)),false);
    }
    runtime.disconnect();
    assert.deepEqual(security.snapshot(),{state:'disconnected',report:null});
    assert.ok(updates.includes('observed') && updates.includes('unavailable'));
    checks.push('A real authenticated Spring Security application allowed the reviewer to read the owned database, returned HTTP 401/403 on rejected requests and denied Actuator access to the viewer.');
    checks.push('The native Actuator panel observed both real filter-chain registrations and matched authentication success, failure and authorization denial against live audit events. Filtered results discarded raw event details and cleared on disconnect.');
    return {successful:true,engine:config.dbEngine,http:{anonymous,rejected,denied,allowed:allowed.status},jdbc,
      chainBeans:['fixtureApplicationChain','fixtureManagementChain'],auditTypes:['AUTHENTICATION_SUCCESS','AUTHENTICATION_FAILURE','AUTHORIZATION_FAILURE'],
      managementDenied:true,principalFilter:true,matchedLiveAudit:true,rawEventDataRetained:false,disconnectedCleared:true};
  } finally {
    subscription.dispose();
    security.close();
    runtime.disconnect();
    await fixture.close();
  }
}

module.exports={runSpringSecurityChecks};
