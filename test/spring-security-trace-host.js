'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const mysql=require('mysql2/promise');
const { ObserverClient }=require('../src/jpa/observer-client');
const { startSpringSecurityFixture }=require('./helpers/spring-security-fixture');

const name='rocketbrain.spring.securityTrace', label='Spring Security Filter Trace';
const sentinel='fixture-trace-data-must-not-be-retained';

async function fixtureConfig(){
  const config=JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG,'utf8'));
  assert.ok(['mysql','mariadb'].includes(config.dbEngine));
  return config;
}

async function verify(fixture,config){
  const observer=fixture.observer, client=new ObserverClient({...observer,timeoutMs:10000});
  const privateHeader={Authorization:'Bearer '+observer.token};
  const read=(suffix,account,password)=>fetch(fixture.baseUrl+suffix+'?trace_fixture='+sentinel,{redirect:'manual',
    signal:AbortSignal.timeout(10000),headers:{'X-Fixture-Trace':sentinel,Cookie:'fixture='+sentinel,...(account?{Authorization:fixture.auth(account,password)}:{})}});
  async function tracked(suffix,account,password){
    const before=await client.securityTrace();
    const cut=Math.max(0,...before.traces.map(trace=>trace.id));
    const response=await read(suffix,account,password), body=await response.text();
    const after=await client.securityTrace();
    const additions=after.traces.filter(trace=>trace.id>cut);
    assert.equal(additions.length,1,JSON.stringify({hooks:after.hooks, state:after.state, traces:after.traces.map(item=>item.coverage)}));
    const trace=additions[0];
    assert.equal(trace.coverage,'observed',JSON.stringify(trace));
    assert.equal(trace.status,response.status);
    assert.equal(trace.completed,true);
    assert.equal(trace.method,'GET');
    assert.deepEqual(trace.entered,trace.configured.slice(0,trace.entered.length));
    assert.ok(trace.entered.length>0);
    return {trace,body};
  }
  try{
    assert.equal((await fetch(observer.url+'/security-trace')).status,401);
    assert.equal((await fetch(observer.url+'/security-trace',{method:'POST',headers:privateHeader})).status,405);
    assert.equal((await fetch(observer.url+'/security-trace?anything=true',{headers:privateHeader})).status,400);
    assert.equal((await fetch(observer.url+'/security-trace',{headers:{...privateHeader,Origin:'https://example.invalid'}})).status,403);
    const initial=await client.securityTrace();
    assert.equal(initial.state,'ready',JSON.stringify(initial.hooks));
    assert.equal(initial.authenticationProviderTraceEnabled,undefined);
    assert.ok(!initial.hooks.includes('authentication-provider-manager'));
    assert.ok(initial.hooks.includes('authorization'));
    assert.ok(initial.hooks.some(hook=>hook.endsWith('execution')),JSON.stringify({hooks:initial.hooks,warnings:(await client.refresh()).warnings}));
    const anonymous=(await tracked('/secure/db')).trace;
    const failed=(await tracked('/secure/db',fixture.reviewer,'unissued-fixture-password')).trace;
    const denied=(await tracked('/secure/db',fixture.viewer)).trace;
    const allowed=await tracked('/secure/db',fixture.reviewer);
    const management=(await tracked('/actuator/health',fixture.operator)).trace;
    assert.deepEqual([anonymous.status,failed.status,denied.status,allowed.trace.status,management.status],[401,401,403,200,200]);
    assert.deepEqual(JSON.parse(allowed.body),{people:2,departments:1});
    for(const trace of [anonymous,failed,denied,allowed.trace]){
      assert.equal(trace.selectedChain,2);
      assert.deepEqual(trace.matches.map(item=>item.matched),[false,true]);
    }
    assert.deepEqual(management.matches.map(item=>item.matched),[true]);
    assert.equal(management.selectedChain,1);
    assert.equal(failed.authorizationDecision,'unobserved');
    assert.equal(denied.authorizationDecision,'denied');
    assert.equal(allowed.trace.authorizationDecision,'granted');
    const basic=failed.entered.findIndex(type=>type.endsWith('.BasicAuthenticationFilter'));
    const authorization=allowed.trace.entered.findIndex(type=>type.endsWith('.AuthorizationFilter'));
    assert.ok(basic>=0&&authorization>basic);
    assert.equal(failed.entered.length,basic+1);
    assert.ok(failed.configured.length>failed.entered.length);
    assert.equal(allowed.trace.entered.length,allowed.trace.configured.length);

    const raw=await (await fetch(observer.url+'/security-trace',{headers:privateHeader})).text();
    for(const value of [sentinel,'/secure/db','/actuator/health','unissued-fixture-password',observer.token,
      fixture.reviewer.name,fixture.reviewer.password,fixture.operator.name,fixture.auth(fixture.viewer)])assert.equal(raw.includes(value),false);
    const general=await client.refresh();
    assert.equal(general.securityTrace,undefined);
    assert.equal(general.traces,undefined);
    assert.deepEqual(general.events,[]);
    for(let index=0;index<34;index++){
      const ready=await read('/ready');assert.equal(ready.status,200);await ready.arrayBuffer();
    }
    const bounded=await client.securityTrace();
    assert.equal(bounded.traces.length,32);
    assert.ok(bounded.dropped>=3);
    assert.ok(bounded.traces.every(trace=>trace.id>allowed.trace.id));

    const dbConfig=JSON.parse(await fs.readFile(config.dbConfigPath,'utf8'));
    const db=await mysql.createConnection({host:dbConfig.host,port:dbConfig.port,user:dbConfig.user,password:dbConfig.password,database:dbConfig.database});
    let version;
    try{const [[server]]=await db.query('SELECT VERSION() AS version');version=server.version;}finally{await db.end();}
    assert.equal(/mariadb/i.test(version),config.dbEngine==='mariadb');
    return {engine:config.dbEngine,version,statuses:[401,401,403,200,200],orderedChainMatches:true,actualFilterOrder:true,
      observedAuthorization:true,shortCircuitedBasicAuth:true,actualJdbc:true,boundedHistory:32,dropped:bounded.dropped,
      requestValuesDiscarded:true,loopbackBearerRequired:true,observerGetOnly:true};
  }finally{client.dispose();}
}

async function runSpringSecurityTraceChecks(api,vscode,checks){
  const config=await fixtureConfig(),fixture=await startSpringSecurityFixture(config,{trace:true});
  const visible=()=>vscode.window.tabGroups.all.some(group=>group.tabs.some(tab=>tab.label===label));
  try{
    const report=await verify(fixture,config);
    const preparation=await vscode.commands.executeCommand('rocketbrain.jpa.observer.prepare');
    assert.equal(preparation?.securityTraceEnabled,false);
    assert.equal(JSON.parse(await fs.readFile(preparation.configFile,'utf8')).securityTrace,false);
    await api.jpa.observer.connect(fixture.observer);
    const opened=await vscode.commands.executeCommand(name);
    assert.equal(opened?.view,name);
    assert.equal(opened.traces.length,32);
    const deadline=Date.now()+5000;
    while(!visible()&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,60));
    assert.ok(visible());
    api.jpa.observer.disconnect();
    const removeBy=Date.now()+5000;
    while(visible()&&Date.now()<removeBy)await new Promise(resolve=>setTimeout(resolve,60));
    assert.equal(visible(),false);
    checks.push('The installed Spring Security view shows actual matcher and filter order, preserves short-circuit and authorization evidence, defaults off, and clears on observer disconnect.');
    return {...report,nativeSecurityTrace:true,defaultOff:true,closedOnDisconnect:true};
  } finally {api.jpa.observer.disconnect();await fixture.close();}
}

module.exports={runSpringSecurityTraceChecks,verify};
if(require.main===module)(async()=>{
  const config=await fixtureConfig(),fixture=await startSpringSecurityFixture(config,{trace:true});
  try{console.log(JSON.stringify({...await verify(fixture,config),nativeSecurityTrace:false}));}finally{await fixture.close();}
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
