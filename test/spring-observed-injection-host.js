'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const { ObserverClient }=require('../src/jpa/observer-client');
const { sourceParameter }=require('../src/spring/observed-injection');
const { jdbcReadback }=require('./java-source-analysis-host');

const qualifiedOwner='fixture.boot.QualifiedWireConsumer';
const ambiguousOwner='fixture.boot.AmbiguousWireConsumer';
const dependency='fixture.boot.ObservedDynamicValue';
const contextId='rocketbrain-runtime-wiring-child';
const sourceFile='src/main/java/fixture/boot/ObservedInjectionProbe.java';

async function fixture(run){
  const config=JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG,'utf8'));
  assert.equal(config.dbEngine,process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE);
  for(const url of [config.baseUrl,config.observerUrl])assert.match(url,/^http:\/\/127\.0\.0\.1:\d+$/u);
  const token=(await fs.readFile(config.observerTokenFile,'utf8')).trim();
  const jdbc=await jdbcReadback();
  assert.deepEqual(jdbc,{people:2,departments:1,rolledBackNames:0});
  async function call(operation){
    const response=await fetch(config.baseUrl+'/probe/observed-injection/'+operation,{
      signal:AbortSignal.timeout(10000),redirect:'error'
    });
    assert.equal(response.status,200,operation+': '+(response.ok?'':await response.text()));
    return response.json();
  }
  const result=await run({config,token,call});
  assert.deepEqual(await jdbcReadback(),jdbc);
  return {engine:config.dbEngine,jdbc,...result};
}

function checkTrace(trace, app){
  assert.equal(trace.state,'observed',JSON.stringify(app.warnings));
  assert.equal(trace.processId,app.processId);
  assert.equal(trace.inspectionInvokedBeans,false);
  assert.equal(trace.beanValuesRetained,false);
  assert.equal(trace.observerExecutedSql,false);
  const qualified=trace.events.filter(value=>value.site.owner===qualifiedOwner).sort((a,b)=>a.site.parameterIndex-b.site.parameterIndex);
  const ambiguous=trace.events.filter(value=>value.site.owner===ambiguousOwner);
  const all=[...qualified,...ambiguous];
  const detail=JSON.stringify({events:all,warnings:app.warnings},null,2);
  assert.equal(all.length,3,detail);
  assert.deepEqual(qualified.map(value=>[value.state,value.site.parameterIndex,value.site.parameterName,value.suggestedName,value.selectedBean]),[
    ['resolved',0,'first','runtimeWireLeft','runtimeWireLeft'],
    ['resolved',1,'second','runtimeWireRight','runtimeWireRight']
  ],detail);
  assert.deepEqual(qualified.map(value=>value.site.parameterTypes),[[dependency,dependency],[dependency,dependency]]);
  assert.equal(ambiguous[0].state,'ambiguous',detail);
  assert.equal(ambiguous[0].selectedBean,undefined);
  assert.equal(ambiguous[0].site.parameterName,'unresolved');
  assert.ok(all.every(value=>value.site.requestingBean==='wireConsumer'&&value.context.id===contextId));
  assert.equal(qualified[0].context.key,qualified[1].context.key);
  assert.notEqual(qualified[0].context.key,ambiguous[0].context.key);
  return all;
}

async function verify({config,token,call},client){
  const snapshot=await client.refresh();
  assert.equal(snapshot.capabilities.springAutowireTrace,true);
  assert.deepEqual(await call('qualified'),{first:'fixture-only-left-value',second:'fixture-only-right-value'});
  assert.deepEqual(await call('ambiguous'),{candidates:2});
  const before=await call('counters');
  assert.ok(before.supplierCalls>=2);
  const trace=await client.observedInjection();
  const events=checkTrace(trace,snapshot);
  const after=await call('counters');
  assert.deepEqual(after,before);
  const contexts=await client.persistenceContexts();
  const runtime=contexts.contexts.find(value=>value.key===events[0].context.key);
  assert.equal(runtime.id,contextId);
  assert.equal(runtime.parentState,'observed');
  assert.ok(!contexts.contexts.some(value=>value.key===events[2].context.key));
  const text=await fs.readFile(path.join(config.projectPath,sourceFile),'utf8');
  const offsets=events.map(event=>sourceParameter({text},event.site));
  assert.deepEqual(offsets.map(value=>text.slice(value.start,value.end)),['first','second','unresolved']);
  assert.ok(!JSON.stringify(trace).includes('fixture-only-left-value'));
  assert.ok(!JSON.stringify(trace).includes('fixture-only-right-value'));
  assert.ok(!JSON.stringify(trace).includes(token));
  return {events,sourceParameters:offsets.map(value=>value.name),supplierCallsUnchanged:true,
    expectedAmbiguity:2,activeContextParent:runtime.parentKey};
}

async function runSpringObservedInjectionChecks(api,vscode,checks){
  const proof=await fixture(async input=>{
    const observer=api.jpa.observer;
    const client=new ObserverClient({url:input.config.observerUrl,token:input.token});
    try{
      await observer.connect({url:input.config.observerUrl,token:input.token});
      const result=await verify(input,client);
      const directory=await fs.realpath(process.env.ROCKETBRAIN_JAVA_TEST_WORKSPACE);
      assert.ok(directory.split(path.sep).includes('test-output'));
      const uri=vscode.Uri.file(path.join(directory,sourceFile));
      for(const event of result.events){
        const report=await vscode.commands.executeCommand('rocketbrain.jpa.observer.inspectObservedInjection',event.id);
        assert.deepEqual(report.event,event);
        assert.deepEqual(JSON.parse(vscode.window.activeTextEditor.document.getText()),report);
        const opened=await vscode.commands.executeCommand('rocketbrain.jpa.observer.openObservedInjectionSource',{eventId:event.id,sourceUri:uri});
        assert.equal(opened.uri.toString(),uri.toString());
        assert.equal(vscode.window.activeTextEditor.document.getText(opened.range),event.site.parameterName);
      }
      return {...result,nativeView:true};
    }finally{client.dispose();observer.disconnect();}
  });
  checks.push('Two actual constructor parameters resolved different dynamically registered Beans. A separate same-name context recorded real ambiguity, and the reports opened the exact local source parameters without calling Bean suppliers.');
  return proof;
}

if(require.main===module)fixture(async input=>{
  const client=new ObserverClient({url:input.config.observerUrl,token:input.token});
  try{return await verify(input,client);}
  finally{client.dispose();}
}).then(result=>console.log(JSON.stringify(result)),error=>{console.error(error.stack);process.exitCode=1;});

module.exports={runSpringObservedInjectionChecks,withObservedInjectionFixture:fixture,verifyObservedConstructorInjection:verify};
