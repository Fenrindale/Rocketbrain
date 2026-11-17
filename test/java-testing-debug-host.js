'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');

async function until(action,timeoutMs=90000){
  const deadline=Date.now()+timeoutMs;let last;
  while(Date.now()<deadline){try{const value=await action();if(value)return value;}catch(error){last=error;}await new Promise(resolve=>setTimeout(resolve,100));}
  throw last||new Error('Native Java test-debug verification timed out.');
}

async function runJavaTestingDebugChecks(api,vscode,checks,supplied={}){
  const runtime=supplied.runtime||JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG,'utf8'));
  const base=require('./java-testing-fixture').fixtureTestingConfig(runtime);
  const installed=supplied.runtimePath?{runtimePath:supplied.runtimePath}:await vscode.commands.executeCommand('rocketbrain.java.testing.install');
  assert.ok(installed?.runtimePath,'Install the current embedded independent test launcher before test debugging.');
  const cases=supplied.cases||[
    {framework:'junit',className:'fixture.boot.RocketbrainSpringTest',methodName:'realRepository',file:'RocketbrainSpringTest.java',marker:'// TEST_DEBUG_GATE'},
    {framework:'testng',className:'fixture.boot.RocketbrainTestNGTest',methodName:'realRepository',file:'RocketbrainTestNGTest.java',marker:'// TESTNG_DEBUG_GATE'}
  ];
  const reports=[];
  for(const item of cases){
    console.log('[Test Debug test] discovering '+item.framework+' test profile');
    const profile={...base,id:'debug-'+item.framework+'-'+runtime.dbEngine,label:'Debug '+item.framework+' · '+runtime.dbEngine,framework:item.framework,runtimePath:installed.runtimePath};
    const snapshot=await api.javaTesting.discover({projects:[profile],build:false});
    const selected=snapshot.tests.find(test=>test.className===item.className&&test.methodName===item.methodName&&test.kind==='test')||snapshot.tests.find(test=>test.className===item.className&&test.methodName===item.methodName);
    assert.ok(selected,item.framework+' selected test must be discovered');
    const source=vscode.Uri.file(path.join(runtime.projectPath,'src/test/java/fixture/boot',item.file));
    const document=await vscode.workspace.openTextDocument(source);await vscode.window.showTextDocument(document);
    const lines=document.getText().split(/\r?\n/),marker=lines.findIndex(line=>line.includes(item.marker));assert.ok(marker>=0,'Owned debug source marker exists');
    const breakpoint=new vscode.SourceBreakpoint(new vscode.Location(source,new vscode.Position(marker+1,0)),true);
    const events=[],sessions=new Map();
    const tracker=vscode.debug.registerDebugAdapterTrackerFactory('rocketbrain-java',{createDebugAdapterTracker(session){
      if(typeof session.configuration.__rocketbrainTestDebugId!=='string')return;
      sessions.set(session.id,session);return {onDidSendMessage(message){if(message.type==='event')events.push({sessionId:session.id,event:message.event,body:message.body});}};
    }});
    const ended=vscode.debug.onDidTerminateDebugSession(session=>{if(sessions.has(session.id))events.push({sessionId:session.id,event:'session-ended'});});
    vscode.debug.addBreakpoints([breakpoint]);let work,earlyError,outcome;
    const launch=()=>{earlyError=undefined;outcome=undefined;work=api.javaTesting.run({includeIds:[selected.nativeId],debug:true,build:false});void work.then(result=>{outcome=result;},error=>{earlyError=error;});return work;};
    const stopped=async from=>until(()=>{if(earlyError)throw earlyError;if(outcome)throw new Error('The test JVM completed before its source breakpoint.');return events.slice(from).find(event=>event.event==='stopped'&&event.body?.reason==='breakpoint');});
    try{
      console.log('[Test Debug test] attaching managed '+item.framework+' JVM');
      launch();const pause=await stopped(0),session=sessions.get(pause.sessionId);assert.ok(session);
      const frames=await session.customRequest('stackTrace',{threadId:pause.body.threadId}),top=frames.stackFrames[0];
      assert.match(top.name,/realRepository/);assert.equal(top.line,marker+2);assert.ok(top.source?.path?.endsWith(item.file));
      const scopes=await session.customRequest('scopes',{frameId:top.id}),locals=[];
      for(const scope of scopes.scopes)if(scope.variablesReference)locals.push(...(await session.customRequest('variables',{variablesReference:scope.variablesReference})).variables);
      assert.ok(locals.some(value=>value.name==='actualCount'&&String(value.value)==='2'),JSON.stringify(locals));
      const watch=await session.customRequest('evaluate',{expression:'actualCount',frameId:top.id,context:'watch'});assert.equal(watch.result,'2');
      const from=events.length;await session.customRequest('next',{threadId:pause.body.threadId});
      const step=await until(()=>events.slice(from).find(event=>event.sessionId===session.id&&event.event==='stopped'&&event.body?.reason==='step'));
      await session.customRequest('continue',{threadId:step.body.threadId});
      const result=await work;const project=result.projects.find(value=>value.projectId===profile.id)||result.projects[0];
      assert.equal(result.state,'completed');assert.equal(project.summary.testsFailed,0);assert.ok(project.summary.testsSucceeded>=1);assert.equal(project.debug?.attached,true);assert.equal(project.debug?.listenerOwnershipVerified,true);assert.equal(project.debug?.sessionStopped,true);assert.equal(project.debug?.applicationOutputUsedForControl,false);assert.equal(project.debug.sessionId,session.id);
      reports.push({framework:item.framework,engine:runtime.dbEngine,selectedId:selected.id,summary:project.summary,debug:project.debug,frame:{name:top.name,line:top.line,source:top.source},localCount:2,watch:watch.result,step:step.body.reason});
      checks.push(`The native ${item.framework} Debug Tests profile starts its own suspended JVM, verifies loopback listener ownership, stops in the actual Spring/DB test, inspects count=2, evaluates a watch, steps and completes the selected test.`);
      console.log('[Test Debug test] cancelling a paused '+item.framework+' test JVM');
      const cancelFrom=events.length;launch();const cancelledPause=await stopped(cancelFrom),cancelSession=sessions.get(cancelledPause.sessionId);assert.ok(cancelSession);
      api.javaTesting.cancel();const cancelledResult=await work;assert.equal(cancelledResult.state,'cancelled');
      const cancelledProject=cancelledResult.projects.find(value=>value.projectId===profile.id)||cancelledResult.projects[0];assert.equal(cancelledProject.state,'cancelled');assert.equal(cancelledProject.debug?.sessionStopped,true);
      await until(()=>events.find(event=>event.sessionId===cancelSession.id&&event.event==='session-ended'),10000);
      reports.push({framework:item.framework,engine:runtime.dbEngine,cancelled:true,state:cancelledProject.state,debug:cancelledProject.debug});
      checks.push(`Cancelling the paused ${item.framework} test closes its managed JVM and matching debug session and reports cancellation instead of a false pass.`);
    }finally{
      vscode.debug.removeBreakpoints([breakpoint]);api.javaTesting.cancel();if(work)await work.catch(()=>{});tracker.dispose();ended.dispose();
    }
  }
  const response=await fetch(runtime.baseUrl+'/probe/testing-state');assert.equal(response.status,200);const isolation=await response.json();assert.deepEqual(isolation,{people:2,departments:1,rolledBackNames:0});
  fs.writeFileSync(path.resolve(__dirname,'../test-output/'+(process.env.ROCKETBRAIN_TEST_REPORT_PREFIX||"v0.9")+'-native-test-debug-'+runtime.dbEngine+'.json'),JSON.stringify({asOf:new Date().toISOString(),engine:runtime.dbEngine,source:'Native Testing API Debug profile with independent Rocketbrain Java DAP',reports,isolation},null,2)+'\n');
  return {reports,isolation};
}

module.exports={runJavaTestingDebugChecks};
