'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const { setTimeout:delay }=require('node:timers/promises');
const mysql=require('mysql2/promise');
const { ObserverClient }=require('../src/jpa/observer-client');
const { renderAuthenticationDecisions }=require('../src/spring/security-trace-vscode');
const { startSpringSecurityFixture }=require('./helpers/spring-security-fixture');

const command='rocketbrain.spring.securityTrace.inspectAuthentication', label='Spring Authentication Decisions';
const route='/custom-authentication/data', parentRoute='/custom-authentication-delegated';
const sentinel='fixture-private-provider-request-value', denial='fixture-private-provider-exception-message';
const type=name=>'fixture.security.CustomAuthenticationFixture$'+name;

async function fixtureConfig(){
  const config=JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG,'utf8'));
  assert.ok(['mysql','mariadb'].includes(config.dbEngine));
  return config;
}

async function verify(fixture,config){
  const client=new ObserverClient({...fixture.observer,timeoutMs:10000});
  const read=(suffix,account,password)=>fetch(fixture.baseUrl+suffix+'?private='+sentinel,{
    redirect:'manual',signal:AbortSignal.timeout(14000),headers:{'X-Fixture-Trace':sentinel,Cookie:'owned='+sentinel,
      ...(account?{Authorization:fixture.auth(account,password)}:{})}});
  const counters=async()=>{
    const response=await read('/custom-authentication/counters');
    assert.equal(response.status,200);
    return response.json();
  };
  async function exercise(suffix,account,password){
    const response=await read(suffix,account,password);
    const body=response.ok?await response.json():null;
    if(!response.ok)await response.arrayBuffer();
    return {status:response.status,body};
  }
  try{
    const initial=await client.securityTrace();
    assert.equal(initial.authenticationProviderTraceEnabled,true);
    assert.ok(initial.hooks.includes('authentication-provider-manager'),JSON.stringify({
      hooks:initial.hooks,warnings:(await client.refresh()).warnings
    }));
    const start=Math.max(0,...initial.traces.map(trace=>trace.id));
    const acceptedPassword=fixture.reviewer.password, invalidPassword=acceptedPassword+'-unissued';
    const [allowed,denied]=await Promise.all([exercise(route,fixture.reviewer),exercise(route,fixture.reviewer,invalidPassword)]);
    assert.deepEqual(allowed,{status:200,body:{people:2}});
    assert.equal(denied.status,401);
    const direct=await client.securityTrace();
    const directTraces=direct.traces.filter(trace=>trace.id>start);
    assert.equal(directTraces.length,2);
    assert.equal(new Set(directTraces.map(trace=>trace.id)).size,2);
    const [allowedTrace,deniedTrace]=[200,401].map(status=>directTraces.find(trace=>trace.status===status));
    assert.ok(allowedTrace&&deniedTrace);
    const [acceptManager,rejectManager]=[allowedTrace,deniedTrace].map(trace=>{
      assert.equal(trace.authenticationCoverage,'observed');
      assert.equal(trace.authenticationManagers.length,1);
      const manager=trace.authenticationManagers[0];
      assert.equal(manager.complete,true);
      assert.equal(manager.delegated,false);
      assert.equal(manager.managerType,'org.springframework.security.authentication.ProviderManager');
      assert.deepEqual(manager.providers.map(provider=>provider.providerType),
        ['SkippingProvider','AbstainingProvider','RejectingProvider','CredentialProvider'].map(type));
      return manager;
    });
    assert.equal(acceptManager.managerId,rejectManager.managerId);
    assert.equal(acceptManager.selectedProvider,4);
    assert.equal(acceptManager.outcome,'returned');
    assert.deepEqual(acceptManager.providers.map(provider=>provider.outcome),['skipped','abstained','rejected','returned']);
    assert.equal(rejectManager.outcome,'rejected');
    assert.equal(rejectManager.selectedProvider,null);
    assert.deepEqual(rejectManager.providers.map(provider=>provider.outcome),['skipped','abstained','rejected','rejected']);

    const error=await exercise(route,fixture.operator);
    assert.equal(error.status,401);
    const errored=(await client.securityTrace()).traces[0];
    assert.equal(errored.authenticationManagers[0]?.outcome,'error');
    assert.equal(errored.authenticationManagers[0].providers.at(-1).outcome,'error');
    assert.equal(errored.authenticationManagers[0].selectedProvider,null);
    assert.equal(errored.authenticationManagers[0].managerId,acceptManager.managerId);
    const delegated=await exercise(parentRoute,fixture.reviewer);
    assert.deepEqual(delegated,{status:200,body:{people:2}});
    const report=await client.securityTrace(), delegatedTrace=report.traces[0];
    assert.equal(delegatedTrace.authenticationCoverage,'partial');
    const parent=delegatedTrace.authenticationManagers[0];
    assert.equal(parent.managerType,acceptManager.managerType);
    assert.notEqual(parent.managerId,acceptManager.managerId);
    assert.deepEqual({result:parent.outcome,delegated:parent.delegated,complete:parent.complete,provider:parent.selectedProvider,parent:parent.parentType},
      {result:'returned',delegated:true,complete:false,provider:null,parent:type('OpaqueParent')});
    assert.deepEqual(parent.providers,[{index:1,providerType:type('AbstainingProvider'),outcome:'abstained'}]);
    const noReplay=await counters();
    assert.deepEqual(noReplay,{skipChecks:3,abstentions:4,rejections:3,credentials:3,parent:1,reads:2});
    assert.equal((await fetch(fixture.observer.url+'/security-trace')).status,401);
    const raw=await (await fetch(fixture.observer.url+'/security-trace',{headers:{Authorization:'Bearer '+fixture.observer.token}})).text();
    const html=renderAuthenticationDecisions(report);
    for(const value of [sentinel,denial,route,parentRoute,fixture.reviewer.name,acceptedPassword,invalidPassword,fixture.operator.name,
      fixture.auth(fixture.reviewer),fixture.observer.token,'ROLE_FIXTURE_CUSTOM']){
      assert.equal(raw.includes(value),false);
      assert.equal(html.includes(value),false);
    }
    assert.ok(html.includes(type('CredentialProvider')));
    assert.ok(html.includes('Partial authentication evidence'));
    assert.ok(html.includes('Returned by manager'));
    assert.deepEqual(await counters(),noReplay);
    const final=await client.securityTrace();
    assert.equal(final.traces[0].authenticationCoverage,'unobserved');
    assert.deepEqual(final.traces[0].authenticationManagers,[]);
    const dbConfig=JSON.parse(await fs.readFile(config.dbConfigPath,'utf8'));
    const db=await mysql.createConnection({host:dbConfig.host,port:dbConfig.port,user:dbConfig.user,password:dbConfig.password,database:dbConfig.database});
    let version;
    try{const [[server]]=await db.query('SELECT VERSION() AS version');version=server.version;}finally{await db.end();}
    assert.equal(/mariadb/i.test(version),config.dbEngine==='mariadb');
    return {engine:config.dbEngine,version,springSecurity:'7.1.2',
      concurrentStatuses:[allowed.status,denied.status],observedProviders:acceptManager.providers.map(provider=>provider.outcome),
      managerOutcomes:[acceptManager.outcome,rejectManager.outcome,errored.authenticationManagers[0].outcome,parent.outcome],
      managerIdentityIsolated:true,delegationPartial:true,providerCountPreserved:true,rawValuesOmitted:true,loopbackBearerRequired:true,actualSpringJdbc:true};
  }finally{client.dispose();}
}

async function runSpringAuthenticationProviderChecks(api,vscode,checks){
  const config=await fixtureConfig(),fixture=await startSpringSecurityFixture(config,{authenticationProviderTrace:true,customAuthentication:true});
  const visible=()=>vscode.window.tabGroups.all.some(group=>group.tabs.some(tab=>tab.label===label));
  async function waitForTab(expected){
    const deadline=Date.now()+5000;
    while(visible()!==expected&&Date.now()<deadline)await delay(60);
    assert.equal(visible(),expected);
  }
  try{
    const report=await verify(fixture,config);
    const preparation=await vscode.commands.executeCommand('rocketbrain.jpa.observer.prepare');
    assert.equal(preparation?.authenticationProviderTraceEnabled,false);
    assert.equal(JSON.parse(await fs.readFile(preparation.configFile,'utf8')).authenticationProviderTrace,false);
    await api.jpa.observer.connect(fixture.observer);
    const opened=await vscode.commands.executeCommand(command);
    assert.equal(opened?.view,command);
    assert.ok(opened.traces.some(trace=>trace.authenticationManagers?.some(manager=>manager.selectedProvider===4)));
    assert.ok(opened.traces.some(trace=>trace.authenticationManagers?.some(manager=>manager.delegated&&!manager.complete)));
    await waitForTab(true);
    api.jpa.observer.disconnect();
    await waitForTab(false);
    checks.push('Spring Authentication Decisions shows isolated observed provider attempts and manager results without capturing credentials or replaying authentication.');
    return {...report,nativeAuthenticationDecisions:true,defaultOff:true,closedOnDisconnect:true};
  }finally{api.jpa.observer.disconnect();await fixture.close();}
}

module.exports={runSpringAuthenticationProviderChecks,verify};
if(require.main===module)(async()=>{
  const config=await fixtureConfig(),fixture=await startSpringSecurityFixture(config,{authenticationProviderTrace:true,customAuthentication:true});
  try{console.log(JSON.stringify({...await verify(fixture,config),nativeAuthenticationDecisions:false}));}
  finally{await fixture.close();}
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
