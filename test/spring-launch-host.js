'use strict';

const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const assert=require('node:assert/strict');
const {setTimeout:delay}=require('node:timers/promises');
const {ActuatorClient}=require('../src/spring/runtime-client');
const {registerJavaWorkbench}=require('../src/java/workbench');
const {applyManagedSpringLaunch}=require('../src/java/spring-launch');
const {fixture,fakeVscode}=require('./java-workbench-fixture');
const F=require('./helpers/spring-launch-fixture');

async function until(action,ms=60000){
  const end=Date.now()+ms;
  let last;
  while(Date.now()<end){
    try{const result=await action();if(result)return result;}
    catch(error){last=error;}
    await delay(140);
  }
  throw last||Error('The owned Spring launch did not become ready.');
}

async function live(input,engine){
  const root='http://127.0.0.1:'+input.port;
  const probe=await until(async()=>{
    const result=await fetch(root+'/config-probe',{signal:AbortSignal.timeout(1200)});
    return result.ok?result.json():false;
  },45000);
  assert.equal(probe.displayName,input.sample);
  assert.equal(probe.queryLimit,1);
  assert.equal(probe.retries,12);
  assert.deepEqual(probe.thresholds,[13]);
  assert.deepEqual(probe.people,[1]);
  assert.equal(/mariadb/i.test(probe.serverVersion),engine==='mariadb');
  const client=new ActuatorClient({url:root+'/actuator'});
  try{
    const seen=Object.fromEntries(await Promise.all(Object.entries({
      activeProfiles:['spring.profiles.active',F.versions[input.profileSource]],
      environment:['fixture.catalog.retries','systemEnvironment'],
      jvm:['fixture.catalog.query-limit','systemProperties'],
      arguments:['fixture.catalog.display-name','commandLineArgs']
    }).map(async ([name,[key,source]])=>{
      const observed=await client.property(key);
      assert.equal(observed.source,source,key);
      assert.equal(observed.display.state,'redacted',key);
      return [name,observed.source];
    })));
    return {...seen,serverVersion:probe.serverVersion,rows:probe.people.length};
  }finally{client.dispose();}
}

async function exercise(workbench,config,project,debugHook){
  const main=await until(async()=>{
    const methods=await workbench.mainClasses({projectUri:project.uri});
    return methods.find(item=>item.mainClass===F.main);
  });
  let saved;
  const launches=[];
  try{
    for(const source of ['environment','jvm','arguments']){
      const input=await F.inputs(config,source);
      const draft={configurationId:saved?.id,projectUri:project.uri,name:'Owned Spring launch '+source,
        mainClass:main.mainClass,projectName:main.projectName,args:[],vmArgs:[],env:input.env,springBoot:input.springBoot};
      saved=await workbench.saveRunConfiguration(draft);
      assert.deepEqual(saved.springBoot,{profiles:['local-db'],profileSource:source,
        properties:input.springBoot.properties.map(({key,source})=>({key,source}))});
      const surfaces=[saved,workbench.listRunConfigurations(),workbench.getSnapshot(),workbench.getTreeChildren()];
      for(const value of surfaces)assert.equal(JSON.stringify(value).includes(input.sample),false);
      assert.equal(JSON.stringify(surfaces).includes('springSecretId'),false);
      const debug=Boolean(debugHook)&&source==='jvm';
      if(debug)await debugHook.before();
      const run=await workbench.start({configurationId:saved.id,debug});
      assert.equal(run.debug,debug);
      assert.equal(run.state,'running');
      if(debug)await debugHook.after(run.sessionId);
      launches.push({source,...await live(input,config.dbEngine),debug});
      await workbench.stop({runId:run.runId});
      await until(async()=>{
        try{await fetch('http://127.0.0.1:'+input.port+'/config-probe',{signal:AbortSignal.timeout(500)});return false;}
        catch{return true;}
      },12000);
    }
    return {engine:config.dbEngine,launches,privateSettings:true,ownedStop:true,selectedProfileSourceVerified:true,
      actualBootDebug:Boolean(debugHook)};
  }finally{
    await workbench.stop();
    if(saved)await workbench.deleteRunConfiguration(saved.id);
  }
}

async function headless(config){
  const runtime=await F.readRuntime(),folder=fixture();
  folder.javaHome=runtime.home;
  const harness=fakeVscode(folder),children=new Map();
  const request=harness.java.requestWorkspaceCommand;
  harness.java.requestWorkspaceCommand=async function(name,args){
    if(name==='vscode.java.resolveMainClass')return [{mainClass:F.main,projectName:'fixture'}];
    return request.call(this,name,args);
  };
  const debug=harness.vscode.debug,launch=debug.startDebugging,stop=debug.stopDebugging;
  debug.startDebugging=async function(folder,configuration,options){
    const pending={...configuration};
    assert.equal(JSON.stringify(pending).includes('owned literal application value'),false);
    applyManagedSpringLaunch(configuration);
    const process=F.startOwnedArtifact(runtime,configuration);
    const admitted=await launch.call(this,folder,configuration,options);
    children.set('debug-'+harness.starts.length,process);
    return admitted;
  };
  debug.stopDebugging=async function(session){
    await children.get(session.id)?.stop();
    children.delete(session.id);
    return stop.call(this,session);
  };
  const api=registerJavaWorkbench(harness.context,harness.vscode,harness.java,harness.output,{runner:harness.runner});
  try{return await exercise(api,config,{uri:folder.uri});}
  finally{
    await api.dispose();
    assert.equal(harness.secrets.size,0);
    const check=await fs.realpath(folder.parent);
    assert.ok(path.basename(check).startsWith('rb-workbench-v18-'));
    assert.equal(path.dirname(check),await fs.realpath(os.tmpdir()));
    await fs.rm(check,{recursive:true,maxRetries:3});
  }
}

async function runSpringLaunchChecks(api,vscode,checks){
  const config=JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG,'utf8'));
  const workspace=vscode.workspace.workspaceFolders?.find(folder=>path.relative(folder.uri.fsPath,process.env.ROCKETBRAIN_JAVA_TEST_WORKSPACE||'.')==='');
  assert.ok(workspace,'Use the owned launch test workspace.');
  assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.java.workbench.configureSpringRun'));
  const runtime=await F.readRuntime(),project=await F.ownedProject(workspace.uri.fsPath,runtime);
  const workbench=api.java.workbench,events=[];
  let breakpoint,tracker;
  try{
    await api.java.start();
    await workbench.resyncProject({projectUri:project.uri,allowProjectExecution:true});
    const source=await vscode.workspace.openTextDocument(vscode.Uri.file(project.source));
    const line=source.getText().split('\n').findIndex(text=>text.includes('SpringApplication.run('));
    assert.ok(line>=0);
    breakpoint=new vscode.SourceBreakpoint(new vscode.Location(source.uri,new vscode.Position(line,0)),true);
    tracker=vscode.debug.registerDebugAdapterTrackerFactory('rocketbrain-java',{createDebugAdapterTracker(session){
      return {onDidSendMessage(message){if(message.type==='event'&&message.event==='stopped')events.push({session,thread:message.body.threadId});}};
    }});
    const report=await exercise(workbench,config,project,{
      before(){vscode.debug.addBreakpoints([breakpoint]);},
      async after(sessionId){
        const event=await until(()=>events.find(item=>item.session.id===sessionId),30000);
        const stack=await event.session.customRequest('stackTrace',{threadId:event.thread,startFrame:0,levels:5});
        assert.ok(stack.stackFrames.some(frame=>frame.name.includes('main')));
        await event.session.customRequest('continue',{threadId:event.thread});
        vscode.debug.removeBreakpoints([breakpoint]);
        breakpoint=undefined;
      }
    });
    checks.push('The installed Spring Boot run settings select profiles through each real property source, preserve private values and launch the owned Spring application in native Run and Debug.');
    return {...report,nativeSpringRunConfiguration:true};
  }finally{
    tracker?.dispose();
    if(breakpoint)vscode.debug.removeBreakpoints([breakpoint]);
    await workbench.stop();
    await api.java.executeWorkspaceCommand('java.project.changeImportedProjects',[],[],[project.uri]).catch(()=>{});
    await project.close();
  }
}

module.exports={headless,runSpringLaunchChecks};
