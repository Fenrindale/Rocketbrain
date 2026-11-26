'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const { randomUUID }=require('node:crypto');
const { fileURLToPath,pathToFileURL }=require('node:url');
const { promisify }=require('node:util');
const { execFile }=require('node:child_process');
const net=require('node:net');
const mysql=require('mysql2/promise');
const { BuildTasks }=require('../src/java/workbench-tasks');
const { collectProjects }=require('../src/java/workbench-model');
const { inspectQuarkusProject }=require('../src/java/quarkus-model');
const { createQuarkusDev, fastJar }=require('../src/java/quarkus-dev');
const { createDebugProcessDiscovery }=require('../src/java/debug-processes');
const { resolveLaunch,serverSettings }=require('../src/java/runtime');
const { resolveDebugBundles }=require('../src/java/debug-runtime');
const { StdioLsp,until }=require('./helpers/stdio-lsp');
const { DapClient }=require('./java-debug-dap');
const { importedSpring,jdbcReadback }=require('./java-source-analysis-host');

const run=promisify(execFile), read=async file=>JSON.parse(await fs.readFile(file,'utf8'));
const fixture=path.resolve(__dirname,'fixtures/java/quarkus-gradle');
const sourceRelative='src/main/java/quarkusgradlefixture/FixtureResource.java';
const className='quarkusgradlefixture.FixtureResource';
const marker='return message;';

async function ownedDatabase(work) {
  const config=await read(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG);
  assert.equal(config.dbEngine,process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE);
  const file=await fs.realpath(config.dbConfigPath), directory=path.dirname(file);
  const owner=await read(path.join(directory,'owner.json'));
  const kind={mysql:'RocketbrainDisposableOracleMysqlFixture-v1',mariadb:'RocketbrainDisposableMariaDbFixture-v1'}[config.dbEngine];
  assert.ok(kind);
  assert.deepEqual([owner.kind,owner.id],[kind,path.basename(directory)]);
  const db=await read(file);
  assert.deepEqual([db.host,db.database],['127.0.0.1','rocketbrain_fixture']);
  assert.ok(Number.isInteger(db.port)&&db.port>1024&&db.port<65536);
  const connection=await mysql.createConnection(db);
  let version;
  try {
    const [[row]]=await connection.query('SELECT @@datadir AS datadir, VERSION() AS version');
    assert.equal(path.relative(directory,path.dirname(await fs.realpath(row.datadir))),'');
    version=row.version;
  } finally { await connection.end(); }
  const jdbc=await jdbcReadback();
  const keys={
    RB_QUARKUS_TEST_JDBC_URL:'jdbc:'+config.dbEngine+'://127.0.0.1:'+db.port+'/'+db.database+'?'+
      (config.dbEngine==='mysql'?'allowPublicKeyRetrieval=true&sslMode=DISABLED':'useSsl=false'),
    RB_QUARKUS_TEST_DB_USER:db.user,RB_QUARKUS_TEST_DB_PASSWORD:db.password
  };
  const previous=Object.fromEntries(Object.keys(keys).map(key=>[key,process.env[key]]));
  try {
    Object.assign(process.env,keys);
    return {engine:config.dbEngine,version,jdbc,...await work()};
  } finally {
    for(const [key,value] of Object.entries(previous)) {
      if(value===undefined)delete process.env[key];else process.env[key]=value;
    }
  }
}

async function web(url,route,format='text',timeoutMs=10000) {
  try {
    const response=await fetch(url+route,{signal:AbortSignal.timeout(timeoutMs),redirect:'error'});
    assert.equal(response.status,200,route);
    return await response[format]();
  } catch(error) {
    throw new Error(`GET ${route} (${timeoutMs} ms deadline): ${error.message}`,{cause:error});
  }
}

async function verifyServed(url,profile) {
  assert.equal(await web(url,'/proof'),profile+'-fixture-ready');
  assert.equal(await web(url,'/proof/jdbc'),'2');
  assert.equal((await web(url,'/q/health/ready','json')).status,'UP');
}

async function assertStopped(url) {
  await assert.rejects(fetch(url+'/proof',{signal:AbortSignal.timeout(1200)}));
}

async function assertDebugClosed(port) {
  await new Promise((resolve,reject)=>{
    const socket=net.createConnection({host:'127.0.0.1',port});
    socket.once('error',error=>error.code==='ECONNREFUSED'?resolve():reject(error));
    socket.once('connect',()=>{socket.destroy();reject(Error('The former Quarkus JDWP port still accepts TCP connections.'));});
    socket.setTimeout(1500,()=>{socket.destroy();reject(Error('The former Quarkus JDWP port did not settle.'));});
  });
}

async function breakpointLine(source) {
  const lines=(await fs.readFile(source,'utf8')).split(/\r?\n/u);
  const line=lines.findIndex(value=>value.includes(marker))+1;
  assert.ok(line>0);
  return line;
}

async function testCount(root) {
  const xml=await fs.readFile(path.join(root,'build/test-results/test/TEST-quarkusgradlefixture.FixtureResourceTest.xml'),'utf8');
  assert.match(xml,/<testsuite [^>]*tests="2"/u);
  assert.match(xml,/<testsuite [^>]*failures="0"/u);
  assert.match(xml,/<testsuite [^>]*errors="0"/u);
  return 2;
}

async function observeLiveReload(source, baseUrl) {
  const previous=await fs.readFile(source,'utf8');
  const updated=previous.replace('String message = greeting + "-ready";','String message = greeting + "-ready-reloaded";');
  assert.notEqual(updated,previous);
  await fs.writeFile(source,updated);
  await until(async()=>await web(baseUrl,'/proof','text',18000)==='dev-fixture-ready-reloaded',85000);
  assert.equal(await web(baseUrl,'/proof/jdbc'),'2');
  assert.equal((await web(baseUrl,'/q/health/ready','json')).status,'UP');
}

async function actualBreakpoint(command,session,project) {
  const source=path.join(project.root,sourceRelative), line=await breakpointLine(source);
  const profile=session.profile==='dev'?'dev':'packaged';
  const greeting=profile+'-fixture-ready';
  const dap=new DapClient(await command('vscode.java.startDebugSession'));
  const location={name:'FixtureResource.java',path:source};
  let request;
  try {
    await dap.request('initialize',{adapterID:'rocketbrain-java',clientID:'rocketbrain-quarkus',
      linesStartAt1:true,columnsStartAt1:true,pathFormat:'path',supportsRunInTerminalRequest:false});
    const attach=dap.request('attach',{type:'rocketbrain-java',name:'Owned Quarkus Gradle application',
      hostName:session.debug.address,port:session.debug.port,sourcePaths:[path.join(project.root,'src/main/java')]});
    attach.catch(()=>{});
    await dap.event('initialized');
    const breakpoints=await dap.request('setBreakpoints',{source:location,breakpoints:[{line}]});
    assert.equal(breakpoints.breakpoints.length,1);
    await dap.request('setExceptionBreakpoints',{filters:[]});
    await dap.request('configurationDone');
    await attach;
    request=web(session.baseUrl,'/proof','text',50000);
    request.catch(()=>{});
    const stopped=await dap.event('stopped',0,40000);
    assert.equal(stopped.reason,'breakpoint');
    const frame=(await dap.request('stackTrace',{threadId:stopped.threadId})).stackFrames[0];
    assert.equal(frame.line,line);
    assert.match(frame.name,/FixtureResource\.greeting/u);
    assert.equal(path.relative(source,frame.source.path),'');
    await dap.request('continue',{threadId:stopped.threadId});
    assert.equal(await request,greeting);

    // A retained breakpoint can suspend a second HTTP request. Exercise it with
    // the same attached JVM before requiring acknowledgement of its removal.
    const nextEvent=dap.events.length;
    request=web(session.baseUrl,'/proof','text',50000);
    request.catch(()=>{});
    const repeatedStop=await dap.event('stopped',nextEvent,40000);
    assert.equal(repeatedStop.reason,'breakpoint');
    const repeatFrame=(await dap.request('stackTrace',{threadId:repeatedStop.threadId})).stackFrames[0];
    assert.equal(repeatFrame.line,line);
    assert.equal(path.relative(source,repeatFrame.source.path),'');
    const pending=Symbol('suspended request');
    assert.equal(await Promise.race([request,new Promise(resolve=>setTimeout(resolve,150,pending))]),pending);
    const cleared=await dap.request('setBreakpoints',{source:location,breakpoints:[]});
    assert.deepEqual(cleared.breakpoints,[]);
    await dap.request('continue',{threadId:repeatedStop.threadId});
    assert.equal(await request,greeting);
    await verifyServed(session.baseUrl,profile);
    if (profile==='dev') {
      await observeLiveReload(source,session.baseUrl);
      const next=await dap.request('setBreakpoints',{source:location,breakpoints:[{line}]});
      assert.equal(next.breakpoints.length,1);
      const afterReload=dap.events.length;
      request=web(session.baseUrl,'/proof','text',50000);
      request.catch(()=>{});
      const reloaded=await dap.event('stopped',afterReload,40000);
      assert.equal(reloaded.reason,'breakpoint');
      const reloadedFrame=(await dap.request('stackTrace',{threadId:reloaded.threadId})).stackFrames[0];
      assert.equal(reloadedFrame.line,line);
      assert.equal(path.relative(source,reloadedFrame.source.path),'');
      await dap.request('setBreakpoints',{source:location,breakpoints:[]});
      await dap.request('continue',{threadId:reloaded.threadId});
      assert.equal(await request,'dev-fixture-ready-reloaded');
    }
    await dap.request('disconnect',{terminateDebuggee:false});
    dap.socket.destroy();
    return {source:sourceRelative,line,method:className+'.greeting',retainedBreakpointSuspendedRepeatHttp:true,
      clearAcknowledged:true,attachedHttpStillReady:true,...(profile==='dev'&&{debuggerStoppedAfterLiveReload:true})};
  } finally {
    await dap.close();
    await request?.catch(()=>{});
  }
}

async function headless({live=false,projectRoot=fixture}={}) {
  const root=await fs.realpath(projectRoot), uri=pathToFileURL(root).href;
  const config=await read(process.env.ROCKETBRAIN_JAVA_TEST_CONFIG);
  const javaHome=await fs.realpath(process.env.ROCKETBRAIN_SPRING_JAVA_HOME||config.javaHome);
  const gradleHome=await fs.realpath(process.env.ROCKETBRAIN_QUARKUS_GRADLE_HOME||process.env.ROCKETBRAIN_GRADLE_HOME);
  const cache=await fs.realpath(process.env.GRADLE_USER_HOME);
  const work=path.resolve(__dirname,'../test-output');
  const storage=await fs.mkdtemp(path.join(work,'quarkus-gradle-proof-'));
  const launch=resolveLaunch({javaHome,serverPath:config.serverPath,storagePath:storage});
  launch.options.env.GRADLE_USER_HOME=cache;
  const lsp=new StdioLsp(launch);
  let log='';
  const processes=createDebugProcessDiscovery({javaHome:()=>javaHome,trusted(){}});
  const runtime=createQuarkusDev({startupMs:200000,resolveDescendant:processes.resolveDescendant,
    log:chunk=>{log=(log+chunk).slice(-8192);}});
  const taskTools={javaHome,gradleHome};
  const tasks=new BuildTasks({storagePath:storage,tools:()=>taskTools,runner:{
    async execute(spec,{timeoutMs}){
      try {
        await run(spec.command,spec.args,{cwd:spec.cwd,env:spec.env,windowsHide:true,timeout:timeoutMs,maxBuffer:8*1024*1024});
        return {code:0};
      } catch(error) {
        process.stderr.write(String(error.stderr||error.stdout||error.message).slice(-3000)+'\n');
        return {code:error.code||1};
      }
    }
  }});
  try {
    const settings=serverSettings([{name:'JavaSE-25',path:javaHome,default:true}],{gradleHome,gradleJavaHome:javaHome});
    settings.java.import.gradle.wrapper.enabled=false;
    settings.java.import.gradle.offline={enabled:true};
    const bundles=resolveDebugBundles(config.debugBundlePath,config.serverPath);
    assert.ok(bundles.length);
    await lsp.request('initialize',{processId:process.pid,rootUri:uri,workspaceFolders:[{uri,name:'quarkus-gradle'}],
      capabilities:{workspace:{configuration:true,workspaceFolders:true}},
      initializationOptions:{bundles,workspaceFolders:[uri],settings}},90000);
    lsp.notify('initialized',{});
    const source=path.join(root,sourceRelative);
    lsp.notify('textDocument/didOpen',{textDocument:{uri:pathToFileURL(source).href,languageId:'java',version:1,text:await fs.readFile(source,'utf8')}});
    const command=(name,...args)=>lsp.request('workspace/executeCommand',{command:name,arguments:args});
    const project=await until(async()=>{
      const imported=await collectProjects({request:(name,args)=>command(name,...args),folders:[uri]});
      const found=imported.projects.find(value=>!path.relative(value.root,root));
      return found?.sourceRoots.some(item=>item.name==='src/main/java'||!path.relative(item.path,path.join(root,'src/main/java')))&&found;
    },140000);
    assert.equal(project.tool,'gradle');
    assert.ok(project.natures.some(nature=>nature.includes('buildship')));
    const model=inspectQuarkusProject(project);
    assert.ok(model.configuration.some(item=>item.key==='rocketbrain.greeting'));
    assert.ok(model.endpoints.some(item=>item.path==='/proof/jdbc'));
    const approval={allowProjectExecution:true};
    const start={project,...taskTools,workspaceTrusted:true,...approval};
    if (live) {
      const debug=await runtime.start({...start,debug:'development'});
      assert.equal(debug.profile,'dev');
      assert.equal(debug.artifact,undefined);
      assert.equal(debug.debug.verified,true);
      const frame=await actualBreakpoint(command,debug,project);
      assert.equal(frame.debuggerStoppedAfterLiveReload,true);
      assert.deepEqual(await runtime.verifyDebugTarget(),debug.debug);
      assert.equal((await runtime.stop()).state,'stopped');
      await assertStopped(debug.baseUrl);
      await assertDebugClosed(debug.debug.port);
      return {version:model.version,tool:'gradle',realBuildshipImport:true,profile:debug.profile,
        frame,ownedJvmVerified:true,ownedShutdown:true,quarkusJdbc:true,nativeView:false};
    }
    const catalog=await tasks.discover(project,approval);
    for(const name of [':test',':quarkusBuild']) {
      const selected=catalog.find(task=>task.name===name);
      assert.ok(selected,'missing observed '+name);
      assert.equal((await tasks.run(project,selected.id,approval)).state,'succeeded');
    }
    const tests=await testCount(root);
    await assert.rejects(runtime.start({...start,allowProjectExecution:false,debug:true}),/trusted workspace/);
    const dev=await runtime.start(start);
    assert.deepEqual([dev.profile,dev.tool,dev.version],['dev','gradle','3.40.1.2']);
    await verifyServed(dev.baseUrl,'dev');
    await assert.rejects(runtime.verifyDebugTarget(),/unavailable/);
    assert.equal((await runtime.stop()).state,'stopped');
    await assertStopped(dev.baseUrl);
    const debug=await runtime.start({...start,debug:true});
    assert.equal(debug.artifact,fastJar(project));
    const selected=await createDebugProcessDiscovery({javaHome:()=>javaHome,trusted(){}}).resolve(debug.debug.pid);
    const proof=await runtime.verifyDebugTarget();
    assert.deepEqual([selected.pid,selected.port,selected.hostName],[proof.pid,proof.port,proof.address]);
    const frame=await actualBreakpoint(command,debug,project);
    await verifyServed(debug.baseUrl,'packaged');
    assert.equal((await runtime.stop()).state,'stopped');
    await assertStopped(debug.baseUrl);
    await assertDebugClosed(debug.debug.port);
    await assert.rejects(runtime.verifyDebugTarget(),/unavailable/);
    return {version:model.version,tool:'gradle',realBuildshipImport:true,buildTask:':quarkusBuild',tests,
      devProfile:true,explicitDebugApproval:true,ownedLoopbackListener:true,jvmProcessResolved:true,
      frame,debugPortClosed:true,detachedAppStillReady:true,quarkusJdbc:true,nativeView:false};
  } catch(error) {
    if(log)process.stderr.write(log+'\n');
    throw error;
  } finally {
    try { await runtime.dispose(); }
    finally { await lsp.close(); }
  }
}

async function withOwnedFixture(parent,work) {
  const workspace=await fs.realpath(parent);
  const name='rb-quarkus-gradle-'+randomUUID().slice(0,8), root=path.join(workspace,name);
  await fs.mkdir(root);
  const copy=source=>!['build','bin','.gradle','.project','.classpath','.settings'].includes(path.basename(source));
  try {
    await fs.cp(fixture,root,{recursive:true,filter:copy});
    return await work(workspace,root);
  } finally {
    const real=await fs.realpath(root);
    assert.deepEqual([path.dirname(real),path.basename(real)],[workspace,name]);
    await fs.rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:300});
  }
}

async function runQuarkusGradleChecks(api,vscode,checks,live=false) {
  const selected=process.env.ROCKETBRAIN_QUARKUS_GRADLE_HOME;
  if(selected)assert.equal(await fs.realpath(vscode.workspace.getConfiguration('rocketbrain.java').get('gradleHome')),
    await fs.realpath(selected));
  const parent=vscode.workspace.workspaceFolders[0].uri.fsPath;
  return ownedDatabase(()=>withOwnedFixture(parent,async(workspace,root)=>{
    const service=api.java.quarkus, projectUri=vscode.Uri.file(root).toString();
    const options={projectUri,allowProjectExecution:true};
    let breakpoint, tracker, request;
    let phase, phaseStart, failure;
    const begin=label=>{phase=label;phaseStart=performance.now();};
    const phases=[];
    const complete=()=>{
      phases.push({phase,elapsedMs:Math.round(performance.now()-phaseStart)});
    };
    try {
      begin('Spring workspace import');
      await importedSpring(api,workspace);
      complete();
      begin('Quarkus Gradle project import');
      const imported=await api.java.workbench.resyncProject(options);
      assert.ok(imported.projects.some(project=>project.tool==='gradle'&&!path.relative(project.root,root)));
      assert.equal((await service.inspect(options)).version,'3.40.1.2');
      complete();
      begin('Quarkus Gradle test');
      assert.equal((await service.runTests(options)).state,'succeeded');
      const tests=await testCount(root);
      complete();
      begin('Quarkus Gradle fast-jar build');
      const build=await service.build(options);
      assert.equal(build.state,'succeeded');assert.equal(build.task,':quarkusBuild');
      complete();
      begin('dev listener startup');
      const dev=await service.startDev(options);
      complete();
      begin('dev HTTP verification');
      await verifyServed(dev.baseUrl,'dev');
      complete();
      begin('dev loopback shutdown');
      await service.stopDev();
      await assertStopped(dev.baseUrl);
      complete();
      const debug=live?service.debugDev:service.debug;
      const profile=live?'dev':'packaged';
      begin(profile+' debugger startup and owned JVM attach');
      await assert.rejects(debug({projectUri}),/Explicitly choose Quarkus debugging/);
      const source=vscode.Uri.file(path.join(root,sourceRelative)), line=await breakpointLine(source.fsPath);
      breakpoint=new vscode.SourceBreakpoint(new vscode.Location(source,new vscode.Position(line-1,0)),true);
      vscode.debug.addBreakpoints([breakpoint]);
      const events=[];
      const cleared=new Map();
      tracker=vscode.debug.registerDebugAdapterTrackerFactory('rocketbrain-java',{createDebugAdapterTracker(session){
        const removals=new Set();
        return {
          onWillReceiveMessage(message) {
            if(message.type!=='request'||message.command!=='setBreakpoints')return;
            const {source:target,breakpoints:positions,lines}=message.arguments||{};
            const sent=positions??lines;
            if(!target?.path||!Array.isArray(sent)||sent.length)return;
            const candidate=target.path.startsWith('file:')?fileURLToPath(target.path):target.path;
            if(path.isAbsolute(candidate)&&!path.relative(source.fsPath,candidate))removals.add(message.seq);
          },
          onDidSendMessage(message) {
            if(message.type==='event'&&message.event==='stopped')events.push({id:session.id,threadId:message.body?.threadId,reason:message.body?.reason});
            if(message.type==='response'&&message.command==='configurationDone'&&message.success)events.push({id:session.id,configured:true});
            if(message.type==='response'&&message.command==='setBreakpoints'&&removals.delete(message.request_seq)) {
              cleared.set(session.id,{success:message.success,breakpoints:message.body?.breakpoints});
            }
          }
        };
      }});
      const session=await debug(options);
      assert.equal(session.profile,live?'dev':'prod');
      assert.equal(session.debug.verified,true);
      const active=vscode.debug.activeDebugSession;
      assert.equal(active?.id,session.sessionId);
      assert.equal(api.java.debug.verifiedLocalPid(active),session.debug.pid);
      await until(()=>events.some(event=>event.id===active.id&&event.configured),26000);
      complete();
      begin(profile+' GET /proof at the source breakpoint');
      request=web(session.baseUrl,'/proof','text',50000);
      request.catch(()=>{});
      const stopped=await until(()=>events.find(event=>event.id===active.id&&event.reason==='breakpoint'),40000);
      const frame=(await active.customRequest('stackTrace',{threadId:stopped.threadId})).stackFrames[0];
      assert.equal(frame.line,line);
      assert.match(frame.name,/FixtureResource\.greeting/u);
      complete();
      begin(profile+' GET /proof after debugger continue');
      await active.customRequest('continue',{threadId:stopped.threadId});
      assert.equal(await request,profile+'-fixture-ready');
      complete();
      begin(profile+' debugger breakpoint removal acknowledgement');
      vscode.debug.removeBreakpoints([breakpoint]);
      breakpoint=undefined;
      assert.deepEqual(await until(()=>cleared.get(active.id),8000),{success:true,breakpoints:[]});
      complete();
      begin(profile+' HTTP verification after breakpoint removal');
      await verifyServed(session.baseUrl,profile);
      assert.equal(events.filter(event=>event.id===active.id&&event.reason==='breakpoint').length,1);
      complete();
      if (live) {
        begin('dev hot reload with debugger attached');
        await observeLiveReload(source.fsPath,session.baseUrl);
        assert.equal(vscode.debug.activeDebugSession?.id,active.id);
        assert.equal(api.java.debug.verifiedLocalPid(active),session.debug.pid);
        complete();
      }
      begin(profile+' HTTP and JDWP shutdown');
      await service.stopDev();
      await assertStopped(session.baseUrl);
      await assertDebugClosed(session.debug.port);
      complete();
      checks.push('Imported Quarkus Gradle in Java Projects, ran its observed tests and fast-jar build, and hit a source breakpoint in its verified owned JVM.');
      return {tool:'gradle',version:'3.40.1.2',tests,buildTask:build.task,frame:{line,source:sourceRelative},nativeView:true,
        ownedLoopbackListener:true,ownedShutdown:true,devProfile:true,quarkusJdbc:true,
        breakpointRemovalAcknowledged:true,attachedHttpStillReady:true,...(live&&{sameDebugSessionAcrossLiveReload:true}),phases};
    } catch(error) {
      failure=new Error(`Quarkus Gradle ${phase} failed after ${Math.round(performance.now()-phaseStart)} ms: ${error.message}`,
        {cause:error});
      throw failure;
    } finally {
      if(breakpoint)vscode.debug.removeBreakpoints([breakpoint]);
      tracker?.dispose();
      try { await service.stopDev(); }
      catch(error) {
        if(!failure)throw error;
        failure.message+=` (shutdown also failed: ${error.message})`;
      }
      finally {
        await request?.catch(()=>{});
        await api.java.executeWorkspaceCommand('java.project.changeImportedProjects',[],[],[projectUri]).catch(()=>{});
      }
    }
  }));
}

const runQuarkusLiveDebugChecks=(api,vscode,checks)=>runQuarkusGradleChecks(api,vscode,checks,true);
const runHeadless=()=>process.argv.includes('--live-debug')?
  withOwnedFixture(path.resolve(__dirname,'../test-output'),(_workspace,projectRoot)=>headless({live:true,projectRoot})):headless();

module.exports={runQuarkusGradleChecks,runQuarkusLiveDebugChecks,ownedDatabase,web,assertStopped,assertDebugClosed};
if(require.main===module)ownedDatabase(runHeadless).then(receipt=>console.log(JSON.stringify(receipt))).catch(error=>{
  console.error(error.stack);process.exitCode=1;
});
