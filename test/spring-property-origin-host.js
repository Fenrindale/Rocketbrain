'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { ActuatorClient } = require('../src/spring/runtime-client');
const { createDebugProcessDiscovery } = require('../src/java/debug-processes');

const property = 'fixture.inspection.message';
const masked = 'fixture.credentials.password';
const title = 'Spring Property Origin';

function fixtureConfig() {
  assert.equal(process.env.ROCKETBRAIN_SPRING_PROPERTY_TEST, '1');
  const config = JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  assert.ok(['mysql','mariadb'].includes(config.dbEngine));
  assert.ok(Number.isInteger(config.debugPort) && config.debugPort > 0);
  assert.ok(Number.isInteger(config.javaProcessId) && config.javaProcessId > 0);
  return config;
}

function assertOrigin(report, engine, verified) {
  assert.equal(report.key, property);
  assert.equal(report.debugProcessVerified, verified);
  assert.deepEqual(report.display, { state:'visible', type:'string', value:engine+'-from-local-launch' });
  assert.equal(report.source,'systemEnvironment');
  assert.match(report.origin,/FIXTURE_INSPECTION_MESSAGE/);
  const effective = report.sources.find(item => item.effective);
  const shadow = report.sources.find(item => !item.effective && item.origin?.includes('application.properties'));
  assert.equal(effective.origin,report.origin);
  assert.ok(shadow && shadow.position > effective.position);
  assert.doesNotMatch(JSON.stringify(report),/default-from-packaged-properties|fixture-only-secret-sentinel/);
}

async function withClient(config, operation) {
  const client = new ActuatorClient({ url:config.runtimeUrl });
  try { return await operation(client); } finally { client.dispose(); }
}

async function verify(config) {
  return withClient(config, async client => {
    assertOrigin(await client.property(property), config.dbEngine, false);
    assertOrigin(await client.property(property,{verifiedPid:config.javaProcessId}), config.dbEngine, true);
    const redacted = await client.property(masked,{verifiedPid:config.javaProcessId});
    assert.deepEqual(redacted.display,{state:'redacted'});
    assert.match(redacted.origin,/application\.properties/);
    assert.doesNotMatch(JSON.stringify(redacted), /fixture-only-secret-sentinel/);
    await assert.rejects(() => client.property(property,{verifiedPid:config.javaProcessId+1}),error => error.code==='DEBUG_PROCESS_MISMATCH');
    await assert.rejects(() => client.property('fixture.inspection.nonexistent'),error => error.code==='NOT_EXPOSED');
    const observation = await client.refresh();
    assert.ok(observation.environment.sources.some(source => source.keys.includes(property)));
    assert.doesNotMatch(JSON.stringify(observation), /fixture-only-secret-sentinel|from-local-launch|default-from-packaged-properties/);
    const response = await fetch(config.baseUrl+'/probe', {signal:AbortSignal.timeout(10000)});
    assert.equal(response.ok,true);
    const probe = await response.json();
    assert.equal(probe.department,'Engineering');
    assert.ok(probe.jpqlCount > 0);
    const mysql = require('mysql2/promise');
    const dbConfig = JSON.parse(fs.readFileSync(config.dbConfigPath,'utf8'));
    const db = await mysql.createConnection({host:dbConfig.host,port:dbConfig.port,user:dbConfig.user,password:dbConfig.password,database:dbConfig.database});
    let version;
    try { const [[data]] = await db.query('SELECT VERSION() AS version'); version = data.version; }
    finally { await db.end(); }
    assert.equal(/MariaDB/i.test(version),config.dbEngine==='mariadb');
    return { engine:config.dbEngine,version,environmentOverridesPackagedConfig:true,exactEffectiveOrigin:true,lowerPriorityOrigin:true,
      lowerPriorityValueDiscarded:true,redactionRespected:true,missingUnavailable:true,pidMismatchRejected:true,rawValuesNotRetainedInSummary:true,
      actualSpringJdbcQuery:true };
  });
}

async function until(predicate, message, timeout = 30000) {
  const deadline = Date.now()+timeout;
  while(Date.now()<deadline) {
    const result=await predicate();
    if(result)return result;
    await new Promise(resolve => setTimeout(resolve,100));
  }
  throw Error(message);
}

async function runSpringPropertyChecks(api,vscode,checks) {
  const config=fixtureConfig(), runtime=api.java.spring.runtime;
  const report=await verify(config);
  const seen=new Map();
  const tracker=vscode.debug.registerDebugAdapterTrackerFactory('rocketbrain-java', { createDebugAdapterTracker(session) {
    seen.set(session.id,session);
    return {};
  } });
  const opened=()=>vscode.window.tabGroups.all.some(group=>group.tabs.some(tab=>tab.label===title));
  let session;
  try {
    assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.spring.debugProperty'));
    await runtime.connect({url:config.runtimeUrl});
    const manual=await vscode.commands.executeCommand('rocketbrain.spring.runtimeProperty',{key:property,approved:true});
    assert.equal(manual?.view,'rocketbrain.spring.propertyOrigin');
    assertOrigin(manual, config.dbEngine, false);
    await until(opened,'The runtime property panel did not open');
    runtime.disconnect();
    await until(()=>!opened(),'The runtime property panel did not close after disconnect');
    await runtime.connect({url:config.runtimeUrl});

    assert.equal(await api.java.debug.processes.attach(config.javaProcessId,{folder:vscode.workspace.workspaceFolders?.[0],
      sourcePaths:config.sourcePaths,name:'Spring property fixture PID attach'}),true);
    session=await until(()=>[...seen.values()].find(item=>api.java.debug.verifiedLocalPid(item)===config.javaProcessId &&
      vscode.debug.activeDebugSession?.id===item.id),'The native debugger did not confirm the active local Spring PID');
    const inspected=await vscode.commands.executeCommand('rocketbrain.spring.debugProperty',{key:property,approved:true});
    assert.equal(inspected?.view,'rocketbrain.spring.propertyOrigin');
    assertOrigin(inspected,config.dbEngine,true);
    await until(opened,'The debugger property panel did not open');
    const hidden=await vscode.commands.executeCommand('rocketbrain.spring.debugProperty',{key:masked,approved:true});
    assert.deepEqual(hidden?.display,{state:'redacted'});
    await vscode.debug.stopDebugging(session);
    await until(()=>!opened(),'The debugger property panel did not clear after detach');
    assert.equal((await fetch(config.baseUrl+'/probe/ready',{signal:AbortSignal.timeout(10000)})).ok,true);
    checks.push('The installed Spring property command inspects the same verified Spring JVM attached in the debugger, shows effective value and ordered origins, respects redaction, and closes on detach.');
    return {...report,nativeRuntimeView:true,nativeDebugView:true,nativePidAttach:true,clearedOnDetach:true};
  } finally {
    for (const item of seen.values()) if (item.id===vscode.debug.activeDebugSession?.id) await vscode.debug.stopDebugging(item).catch(()=>{});
    tracker.dispose();
    runtime.disconnect();
  }
}

module.exports={runSpringPropertyChecks};
if (require.main===module) (async()=>{
  const config=fixtureConfig();
  const report=await verify(config);
  const discovery=createDebugProcessDiscovery({javaHome:()=>process.env.ROCKETBRAIN_SPRING_JAVA_HOME,trusted(){}});
  const target=await discovery.resolve(config.javaProcessId);
  assert.equal(target.pid,config.javaProcessId);
  assert.equal(target.port,config.debugPort);
  console.log(JSON.stringify({...report,osVerifiedJvmListener:true,nativeDebugView:false}));
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
