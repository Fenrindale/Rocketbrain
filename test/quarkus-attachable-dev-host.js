'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {pathToFileURL}=require('node:url');
const {EventEmitter}=require('node:events');
const {resolveLaunch,serverSettings}=require('../src/java/runtime');
const {resolveDebugBundles}=require('../src/java/debug-runtime');
const {collectProjects}=require('../src/java/workbench-model');
const {createDebugProcessDiscovery}=require('../src/java/debug-processes');
const {registerQuarkusWorkbench,COMMANDS}=require('../src/java/quarkus-vscode');
const {DEBUG_TYPE,processAttachTarget}=require('../src/java/debug');
const {StdioLsp,until}=require('./helpers/stdio-lsp');
const {DapClient}=require('./java-debug-dap');
const {ownedDatabase,web,assertStopped,assertDebugClosed}=require('./quarkus-gradle-host');
const {importedSpring,jdbcReadback}=require('./java-source-analysis-host');

const approval={allowProjectExecution:true};
const source='src/main/java/quarkusgradlefixture/FixtureResource.java';
const firstMessage='dev-fixture-ready',secondMessage='dev-fixture-ready-after-detach';
const read=async file=>JSON.parse(await fs.readFile(file,'utf8'));

async function withProject(parent,tool,work){
  parent=await fs.realpath(parent);
  const room=await fs.mkdtemp(path.join(parent,'rb-quarkus-attach-'));
  const root=path.join(room,'app'),identity=await fs.lstat(room,{bigint:true});
  const gradleFixture=path.join(__dirname,'fixtures/java/quarkus-gradle');
  try{
    await fs.cp(path.join(gradleFixture,'src/main'),path.join(root,'src/main'),{recursive:true});
    if(tool==='maven'){
      await fs.copyFile(path.join(__dirname,'fixtures/java/quarkus-attachable-dev/pom.xml'),path.join(root,'pom.xml'));
      if(process.env.ROCKETBRAIN_QUARKUS_MAVEN_REPO){
        const repo=await fs.realpath(process.env.ROCKETBRAIN_QUARKUS_MAVEN_REPO);
        await fs.mkdir(path.join(root,'.mvn'));
        await fs.writeFile(path.join(root,'.mvn/maven.config'),'-Dmaven.repo.local='+repo+'\n');
      }
    } else {
      for(const name of ['build.gradle','settings.gradle'])await fs.copyFile(path.join(gradleFixture,name),path.join(root,name));
    }
    return await work(root,room);
  } finally {
    const real=await fs.realpath(room), current=await fs.lstat(real,{bigint:true});
    assert.equal(path.dirname(real),parent);
    assert.match(path.basename(real),/^rb-quarkus-attach-/u);
    assert.deepEqual([current.dev,current.ino],[identity.dev,identity.ino]);
    await fs.rm(real,{recursive:true,force:true,maxRetries:8,retryDelay:300});
  }
}

async function pauseAt(client,file,baseUrl,expectedMessage){
  const line=(await fs.readFile(file,'utf8')).split(/\r?\n/u).findIndex(value=>value.includes('return message;'))+1;
  assert.ok(line>0);
  const bp=await client.request('setBreakpoints',{source:{name:path.basename(file),path:file},breakpoints:[{line}]});
  assert.equal(bp.breakpoints.length,1);
  const after=client.mark();
  const request=web(baseUrl,'/proof','text',50000);
  request.catch(()=>{});
  const stopped=await client.stopped(after);
  assert.equal(stopped.reason,'breakpoint');
  const frame=(await client.request('stackTrace',{threadId:stopped.threadId})).stackFrames[0];
  assert.equal(frame.line,line);
  assert.equal(path.relative(frame.source.path,file),'');
  assert.match(frame.name,/FixtureResource\.greeting/u);
  const scopes=await client.request('scopes',{frameId:frame.id});
  const locals=scopes.scopes.find(scope=>scope.name==='Local'||scope.name==='Locals');
  assert.ok(locals,'Missing stopped Java locals scope.');
  const variables=await client.request('variables',{variablesReference:locals.variablesReference});
  const actual=variables.variables.find(item=>item.name==='message');
  assert.equal(actual?.value?.replace(/^"|"$/gu,''),expectedMessage);
  const pending=Symbol('suspended');
  assert.equal(await Promise.race([request,new Promise(resolve=>setTimeout(resolve,150,pending))]),pending);
  return {line,request,threadId:stopped.threadId};
}

async function exercise(service,root,uri,clientOf,{rejectNextAttach,execute}={}){
  const file=path.join(root,source);
  await assert.rejects(service.attachDev(approval),/current owned Quarkus dev JVM/u);
  await assert.rejects(service.startAttachableDev({projectUri:uri}),/Explicitly start/u);
  const ready=execute?await execute(COMMANDS.startAttachableDev):await service.startAttachableDev({projectUri:uri,...approval});
  const {runId,baseUrl,debug}=ready;
  try{
    assert.equal(ready.profile,'dev');
    assert.equal(debug.verified,true);
    assert.equal(ready.sessionId,undefined);
    assert.match(runId,/^[a-f0-9-]{36}$/u);
    assert.equal(await web(baseUrl,'/proof'),firstMessage);
    assert.equal(await web(baseUrl,'/proof/jdbc'),'2');
    assert.equal((await web(baseUrl,'/q/health/ready','json')).status,'UP');
    await assert.rejects(service.attachDev({runId}),/Explicitly attach/u);
    await assert.rejects(service.attachDev({runId:'stale',...approval}),/current owned/u);
    if(rejectNextAttach){
      rejectNextAttach();
      await assert.rejects(service.attachDev({runId,...approval}),/Could not start the debugger/u);
      assert.equal(await web(baseUrl,'/proof'),firstMessage);
    }

    const first=execute?await execute(COMMANDS.attachDev):await service.attachDev({runId,...approval});
    assert.deepEqual([first.runId,first.debug.pid,first.debug.port],[runId,debug.pid,debug.port]);
    await assert.rejects(service.attachDev({runId,...approval}),/Detach the current/u);
    await assert.rejects(service.detachDev({runId,sessionId:'unrelated',...approval}),/current Quarkus dev debugger/u);
    const paused=await pauseAt(clientOf(first.sessionId),file,baseUrl,firstMessage);
    const detached=execute?await execute(COMMANDS.detachDev):await service.detachDev({runId,sessionId:first.sessionId,...approval});
    assert.deepEqual([detached.state,detached.detachedSessionId,detached.runId,detached.debug.pid],
      ['detached',first.sessionId,runId,debug.pid]);
    assert.equal(await paused.request,firstMessage);
    assert.equal(await web(baseUrl,'/proof/jdbc'),'2');

    const before=await fs.readFile(file,'utf8'), updated=before.replace('greeting + "-ready"','greeting + "-ready-after-detach"');
    assert.notEqual(before,updated);
    await fs.writeFile(file,updated);
    await until(async()=>await web(baseUrl,'/proof','text',18000)===secondMessage,85000);
    const second=await service.attachDev({runId,...approval});
    assert.notEqual(second.sessionId,first.sessionId);
    assert.deepEqual([second.runId,second.baseUrl,second.debug.pid,second.debug.port],[runId,baseUrl,debug.pid,debug.port]);
    const nextClient=clientOf(second.sessionId), again=await pauseAt(nextClient,file,baseUrl,secondMessage);
    assert.equal(again.line,paused.line);
    await nextClient.request('continue',{threadId:again.threadId});
    assert.equal(await again.request,secondMessage);
    assert.equal(await web(baseUrl,'/proof/jdbc'),'2');
    assert.equal((await service.stopDev()).state,'stopped');
    await assertStopped(baseUrl);
    await assertDebugClosed(debug.port);
    await assert.rejects(service.attachDev({runId,...approval}),/current owned/u);
    const springJdbc=await jdbcReadback();
    assert.deepEqual(springJdbc,{people:2,departments:1,rolledBackNames:0});
    return {tool:ready.tool,quarkus:ready.version,source,line:again.line,detachedWhilePaused:true,firstMessage,secondMessage,
      ownedSameJvm:true,localVariablesVerified:true,postDetachReload:true,staleSessionRefused:true,springJdbc,
      quarkusJdbc:2,ownedHttpAndJdwpClosed:true,rejectedDebuggerRetainedHttp:!!rejectNextAttach};
  }finally{await service.stopDev();}
}

function headlessHost(project,tools,processes,command,log){
  const events=new EventEmitter(), commands=new Map(), sessions=new Map(), errors=[];
  const disposable=()=>({dispose(){}}), uri={scheme:'file',fsPath:project.root};
  let rejectNext=false;
  const on=(event,listener)=>{
    events.on(event,listener);
    return {dispose(){events.off(event,listener);}};
  };
  async function detach(session,{terminateDebuggee=false}={}){
    assert.equal(terminateDebuggee,false);
    try{await session.dap.request('disconnect',{terminateDebuggee:false},5000);}
    finally{session.dap.socket.destroy();}
  }
  const vscode={
    Uri:{parse:value=>value},ProgressLocation:{Notification:15},
    workspace:{isTrusted:true,workspaceFolders:[project.uri],textDocuments:[],getWorkspaceFolder:()=>({uri}),
      getConfiguration:()=>({get:key=>tools[key]})},
    window:{activeTextEditor:{document:{uri}},createOutputChannel:()=>({append:log,dispose(){},show(){}}),
      withProgress:(_options,operation)=>operation({},new AbortController().signal),
      showInformationMessage:async()=>undefined,showErrorMessage:async message=>errors.push(message)},
    commands:{registerCommand(name,operation){commands.set(name,operation);return disposable();}},
    languages:{registerCompletionItemProvider:disposable,registerDefinitionProvider:disposable},
    debug:{onDidStartDebugSession:listener=>on('start',listener),onDidTerminateDebugSession:listener=>on('end',listener),
      stopDebugging:session=>detach(session),
      async startDebugging(_folder,configuration,options){
        assert.equal(options.suppressSaveBeforeStart,true);
        if(rejectNext){rejectNext=false;return false;}
        const target=await processes.resolve(configuration.processId);
        const exact=processAttachTarget(target);
        for(const [key,value] of Object.entries(exact))assert.deepEqual(configuration[key],value);
        const dap=new DapClient(await command('vscode.java.startDebugSession'));
        try{
          await dap.request('initialize',{adapterID:DEBUG_TYPE,clientID:'quarkus-owned-lifecycle',linesStartAt1:true,
            columnsStartAt1:true,pathFormat:'path',supportsRunInTerminalRequest:false});
          const pending=dap.request('attach',{type:DEBUG_TYPE,name:configuration.name,hostName:target.hostName,
            port:target.port,sourcePaths:configuration.sourcePaths});
          pending.catch(()=>{});
          await dap.event('initialized',0,20000);
          await dap.request('configurationDone');
          await pending;
          const session={id:randomUUID(),type:DEBUG_TYPE,configuration,dap,pid:target.pid,customRequest(name,args){
            assert.equal(name,'disconnect');
            return detach(this,args);
          }};
          sessions.set(session.id,session);
          dap.socket.once('close',()=>{sessions.delete(session.id);events.emit('end',session);});
          events.emit('start',session);
          return true;
        }catch(error){await dap.close();throw error;}
      }}
  };
  const java={getState:()=>tools,workbench:{getSnapshot:()=>({projects:[project]})},
    debug:{processes,verifiedLocalPid:session=>sessions.get(session.id)?.pid}};
  const service=registerQuarkusWorkbench(vscode,java);
  return {service,rejectNextAttach(){rejectNext=true;},async execute(name){
    assert.ok(commands.has(name));
    const result=await commands.get(name)();
    if(errors.length)throw Error(errors.shift());
    return result;
  },clientOf:id=>{
    const {dap}=sessions.get(id);
    return {request:(name,args)=>dap.request(name,args),mark:()=>dap.events.length,stopped:mark=>dap.event('stopped',mark,40000)};
  }};
}

async function headless(tool){
  const config=await read(process.env.ROCKETBRAIN_JAVA_TEST_CONFIG);
  const javaHome=await fs.realpath(process.env.ROCKETBRAIN_SPRING_JAVA_HOME||config.javaHome);
  const mavenHome=await fs.realpath(process.env.ROCKETBRAIN_MAVEN_HOME||config.mavenHome);
  const gradleHome=tool==='gradle'?await fs.realpath(process.env.ROCKETBRAIN_QUARKUS_GRADLE_HOME):undefined;
  const tools={javaHome,mavenHome,gradleHome};
  const parent=await fs.realpath(process.env.ROCKETBRAIN_QUARKUS_TEST_OUTPUT||path.resolve('test-output'));
  return withProject(parent,tool,async(root,room)=>{
    const uri=pathToFileURL(root).href, storage=path.join(room,'jdt-storage');
    await fs.mkdir(storage);
    const launch=resolveLaunch({javaHome,serverPath:config.serverPath,storagePath:storage});
    const lsp=new StdioLsp(launch);
    let host,log='';
    try{
      const settings=serverSettings([{name:'JavaSE-25',path:javaHome,default:true}],{gradleHome,gradleJavaHome:javaHome});
      if(tool==='gradle')settings.java.import.gradle.wrapper.enabled=false;
      const bundles=resolveDebugBundles(config.debugBundlePath,config.serverPath);
      assert.ok(bundles.length);
      await lsp.request('initialize',{processId:process.pid,rootUri:uri,workspaceFolders:[{uri,name:'Quarkus attachable dev'}],
        capabilities:{workspace:{configuration:true,workspaceFolders:true}},initializationOptions:{bundles,workspaceFolders:[uri],settings}},90000);
      lsp.notify('initialized',{});
      const file=path.join(root,source);
      lsp.notify('textDocument/didOpen',{textDocument:{uri:pathToFileURL(file).href,languageId:'java',version:1,text:await fs.readFile(file,'utf8')}});
      const command=(name,...args)=>lsp.request('workspace/executeCommand',{command:name,arguments:args});
      const project=await until(async()=>{
        const snapshot=await collectProjects({request:(name,args)=>command(name,...args),folders:[uri]});
        const found=snapshot.projects.find(item=>!path.relative(item.root,root));
        return found?.sourceRoots.some(item=>!path.relative(item.path,path.join(root,'src/main/java')))&&found;
      },150000);
      assert.equal(project.tool,tool);
      const processes=createDebugProcessDiscovery({javaHome:()=>javaHome,trusted(){}});
      host=headlessHost(project,tools,processes,command,chunk=>{log=(log+chunk).slice(-12000);});
      return {actualJdtImport:true,...await exercise(host.service,root,uri,host.clientOf,host)};
    }catch(error){
      const password=process.env.RB_QUARKUS_TEST_DB_PASSWORD;
      if(log)process.stderr.write((password?log.replaceAll(password,'[redacted]'):log)+'\n');
      throw error;
    }finally{
      try{await host?.service.dispose();}finally{await lsp.close();}
    }
  });
}

async function runQuarkusAttachableDevChecks(api,vscode,checks){
  const parent=vscode.workspace.workspaceFolders[0].uri.fsPath;
  await importedSpring(api,parent);
  const sessions=new Map(), stopped=[];
  const tracker=vscode.debug.registerDebugAdapterTrackerFactory(DEBUG_TYPE,{createDebugAdapterTracker(session){
    sessions.set(session.id,session);
    return {onDidSendMessage(message){if(message.type==='event'&&message.event==='stopped')stopped.push({id:session.id,body:message.body});}};
  }});
  try{
    const result=await ownedDatabase(()=>withProject(parent,'maven',async root=>{
      const uri=vscode.Uri.file(root).toString(),service=api.java.quarkus;
      const ids=await vscode.commands.getCommands(true);
      for(const id of [COMMANDS.startAttachableDev,COMMANDS.attachDev,COMMANDS.detachDev])assert.ok(ids.includes(id));
      try{
        const imported=await api.java.workbench.resyncProject({projectUri:uri,...approval});
        assert.ok(imported.projects.some(project=>project.tool==='maven'&&!path.relative(project.root,root)));
        return await exercise(service,root,uri,id=>({request:(name,args)=>sessions.get(id).customRequest(name,args),
          mark:()=>stopped.length,stopped:mark=>until(async()=>stopped.slice(mark).find(event=>event.id===id)?.body,40000)}));
      }finally{
        await service.stopDev();
        await api.java.executeWorkspaceCommand('java.project.changeImportedProjects',[],[],[uri]).catch(()=>{});
      }
    }));
    checks.push('Attached when needed to an owned Quarkus Maven dev JVM, inspected HTTP handler locals, detached while suspended, reloaded while detached, and reattached to the same listener.');
    return result;
  }finally{tracker.dispose();}
}

module.exports={runQuarkusAttachableDevChecks};
if(require.main===module){
  const tool=process.argv[2]||'maven';
  assert.ok(['maven','gradle'].includes(tool));
  ownedDatabase(()=>headless(tool)).then(result=>console.log(JSON.stringify(result))).catch(error=>{
    console.error(error.stack);process.exitCode=1;
  });
}
