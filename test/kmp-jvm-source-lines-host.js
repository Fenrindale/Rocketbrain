'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL,fileURLToPath } = require('node:url');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { resolveLaunch,serverSettings } = require('../src/java/runtime');
const { loadKmpModel } = require('../src/java/kmp-gradle');
const { startKmpJvmDebug } = require('../src/java/kmp-jvm-debug');
const { createDebugProcessDiscovery } = require('../src/java/debug-processes');
const { KOTLIN_LINE_BUILDS } = require('../src/java/debug-runtime');
const { StdioLsp,until } = require('./helpers/stdio-lsp');
const { DapClient } = require('./java-debug-dap');
const { ownedFixture,frameLocal,readCompletion,toolsFor } = require('./kmp-jvm-debug-host');

const execute=promisify(execFile);
const permission={workspaceTrusted:true,allowProjectExecution:true};

async function runKmpJvmSourceLinesHeadless() {
  return ownedFixture(os.tmpdir(),async fixture=>{
    const config=JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_JAVA_TEST_CONFIG,'utf8'));
    const tools=toolsFor(config.javaHome), resolver=createDebugProcessDiscovery({javaHome:()=>config.javaHome,trusted(){}});
    const runner={async execute(spec){
      try {await execute(spec.command,spec.args,{cwd:spec.cwd,env:spec.env,timeout:190000,maxBuffer:2500000});return {code:0};}
      catch(error){process.stderr.write(error.stdout || '');process.stderr.write(error.stderr || '');throw error;}
    }};
    let engine, app, dap;
    try {
      const model=await loadKmpModel({root:fixture.project,tools,runner,...permission});
      const javaRoot=path.join(fixture.root,'jdt-workspace');
      await fs.cp(path.join(__dirname,'fixtures/java/maven'),javaRoot,{recursive:true});
      const rootUri=pathToFileURL(javaRoot).href, settings=serverSettings([{name:'JavaSE-25',path:config.javaHome,default:true}]);
      const launch=resolveLaunch({...config,storagePath:path.join(fixture.root,'jdt')});
      assert.ok(KOTLIN_LINE_BUILDS.includes(launch.debugBuild));
      engine=new StdioLsp(launch);
      await engine.request('initialize',{processId:process.pid,rootUri,workspaceFolders:[{uri:rootUri,name:'kotlin-lines'}],
        capabilities:{workspace:{configuration:true}},initializationOptions:{bundles:launch.bundles,workspaceFolders:[rootUri],settings}},90000);
      engine.notify('initialized',{});
      const port=await until(()=>engine.request('workspace/executeCommand',{command:'vscode.java.startDebugSession',arguments:[]},12000),65000);
      app=await startKmpJvmDebug({model,modulePath:':',targetName:'jvm',tools,...permission,sourceLineJavaHome:config.javaHome,
        resolveDescendant:resolver.resolveDescendant,onOutput:chunk=>process.stderr.write(chunk)});
      assert.equal(app.task,':jvmRun');
      const source=(file)=>app.sourceLines?.files.find(item=>!path.relative(file,item.file));
      assert.equal(source(fixture.common)?.lines[5]?.stratum,'Kotlin');
      const jvmStratum=source(fixture.actual)?.lines[9]?.stratum;
      assert.ok(['Java','Kotlin'].includes(jvmStratum));
      assert.ok(source(path.join(fixture.project,'src/commonMain/kotlin/shadow/Main.kt'))?.lines[5]);
      assert.equal(source(fixture.common).lines[2],undefined);
      dap=new DapClient(port);
      const request=(...args)=>dap.request(...args);
      await request('initialize',{adapterID:'rocketbrain-java',clientID:'kotlin-lines',linesStartAt1:true,columnsStartAt1:true,pathFormat:'path'});
      const attaching=request('attach',{hostName:app.target.hostName,port:app.target.port,sourcePaths:app.sourcePaths,
        rocketbrainKotlinSourceLines:app.sourceLines});
      void attaching.catch(()=>{});
      await dap.event('initialized');
      const set=(file,lines,extra={})=>request('setBreakpoints',{source:{name:path.basename(file),path:file},
        breakpoints:lines.map(line=>({line})),...extra});
      const original=await fs.readFile(fixture.common);
      await fs.appendFile(fixture.common,'// saved after compilation\n');
      try {assert.equal((await set(fixture.common,[5])).breakpoints[0].verified,false);}
      finally {await fs.writeFile(fixture.common,original);}
      assert.equal((await set(fixture.common,[5],{sourceModified:true})).breakpoints[0].verified,false);
      const foreign=path.join(fixture.root,'Main.kt');
      await fs.writeFile(foreign,original,{flag:'wx'});
      assert.equal((await set(foreign,[5])).breakpoints[0].verified,false);
      await set(fixture.common,[4]);
      const commonSet=await set(fixture.common,[2,5]);
      const jvmSet=await set(fixture.actual,[9]);
      assert.equal(commonSet.breakpoints[0].verified,false);
      const commonId=commonSet.breakpoints[1].id, jvmId=jvmSet.breakpoints[0].id;
      assert.ok(Number.isInteger(commonId) && Number.isInteger(jvmId));
      await request('configurationDone');
      await attaching;
      let stop=await dap.event('stopped',0,23000);
      assert.equal(stop.reason,'breakpoint');
      const common=await frameLocal(request,stop.threadId,fixture.common,'commonValue',12);
      assert.equal(common.line,5);
      await until(()=>dap.events.some(event=>event.event==='breakpoint' && event.body.breakpoint.id===commonId && event.body.breakpoint.verified),6000);
      const offset=dap.events.length;
      await request('continue',{threadId:stop.threadId});
      stop=await dap.event('stopped',offset,23000);
      assert.equal(stop.reason,'breakpoint');
      const jvm=await frameLocal(request,stop.threadId,fixture.actual,'ownedValue',27);
      assert.equal(jvm.line,9);
      await until(()=>dap.events.some(event=>event.event==='breakpoint' && event.body.breakpoint.id===jvmId && event.body.breakpoint.verified),6000);
      await request('continue',{threadId:stop.threadId});
      const result=await readCompletion(fixture);
      assert.equal((await app.done).code,0);
      assert.ok(!dap.events.some(event=>event.event==='breakpoint' && event.body.breakpoint.id===commonSet.breakpoints[0].id && event.body.breakpoint.verified));
      return {task:app.task,common,jvm,jvmStratum,smapped:true,liveVerified:true,exactPath:true,staleAndDirtyRefused:true,
        nonExecutableUnverified:true,replacedBreakpointRemoved:true,...result};
    } finally {
      await dap?.close();
      try {await app?.stop();}
      finally {await engine?.close();}
    }
  },{sourceLines:true});
}

async function runKmpJvmSourceLinesChecks(api,vscode,checks) {
  const project=vscode.workspace.workspaceFolders[0].uri.fsPath, service=api.java.kotlinMultiplatform;
  await api.java.start();
  assert.ok(KOTLIN_LINE_BUILDS.includes(api.java.getState().debugBuild));
  const config=vscode.workspace.getConfiguration('rocketbrain.kotlin'), scope=vscode.ConfigurationTarget.Global, previous=[];
  try {
    for (const [name,value] of Object.entries({
      gradleHome:process.env.ROCKETBRAIN_KMP_GRADLE_HOME,gradleUserHome:process.env.ROCKETBRAIN_KMP_GRADLE_USER_HOME
    })) {
      if (!value) continue;
      previous.push([name,config.inspect(name)?.globalValue]);
      await config.update(name,value,scope);
    }
    return await ownedFixture(project,async fixture=>{
      const options={projectUri:vscode.Uri.file(fixture.project).toString(),modulePath:':',targetName:'jvm',allowProjectExecution:true};
      const model=await service.inspect(options);
      assert.ok(model.modules.find(item=>item.path===':').targets.some(item=>item.name==='jvm' && item.runTask === ':jvmRun'));
      const files=[[fixture.common,5],[fixture.actual,9]];
      const breakpoints=files.map(([file,line])=>new vscode.SourceBreakpoint(
        new vscode.Location(vscode.Uri.file(file),new vscode.Position(line-1,0)),true));
      const events=[], pending=new Map(), ids=new Map();
      let session;
      const tracker=vscode.debug.registerDebugAdapterTrackerFactory('rocketbrain-java',{createDebugAdapterTracker(value){
        if (value.name!=='Kotlin JVM: :jvmRun' || !value.configuration.__rocketbrainKmpDebugSession) return undefined;
        session=value;
        return {
          onWillReceiveMessage(message) {
            if (message.type==='request' && message.command==='setBreakpoints') pending.set(message.seq,message.arguments);
          },
          onDidSendMessage(message) {
            if (message.type==='event') events.push(message);
            if (message.type!=='response' || message.command!=='setBreakpoints') return;
            const input=pending.get(message.request_seq);
            pending.delete(message.request_seq);
            if (!input?.source?.path || !message.success) return;
            for (const [file,line] of files) {
              const selected=input.source.path.startsWith('file:') ? fileURLToPath(input.source.path) : input.source.path;
              if (path.relative(file,selected)) continue;
              const at=input.breakpoints?.findIndex(point=>point.line===line);
              const output=message.body?.breakpoints?.[at];
              if (output) ids.set(file,output);
            }
          }
        };
      }});
      vscode.debug.addBreakpoints(breakpoints);
      try {
        const opened=await service.debugJvm(options);
        assert.equal(opened.sessionId,session.id);
        assert.equal(opened.pid,api.java.debug.verifiedLocalPid(session));
        const request=session.customRequest.bind(session);
        const stopped=offset=>until(()=>events.slice(offset).find(item=>item.event==='stopped'&&item.body.reason==='breakpoint')?.body,30000);
        const verified=file=>until(()=>{
          const id=ids.get(file);
          return id?.verified || id && events.some(event=>event.event==='breakpoint'&&event.body.breakpoint.id===id.id&&event.body.breakpoint.verified);
        },7000);
        let stop=await stopped(0);
        const common=await frameLocal(request,stop.threadId,fixture.common,'commonValue',12);
        assert.equal(common.line,5);
        await verified(fixture.common);
        const offset=events.length;
        await request('continue',{threadId:stop.threadId});
        stop=await stopped(offset);
        const jvm=await frameLocal(request,stop.threadId,fixture.actual,'ownedValue',27);
        assert.equal(jvm.line,9);
        await verified(fixture.actual);
        await request('continue',{threadId:stop.threadId});
        const completion=await readCompletion(fixture);
        await until(()=>events.some(event=>event.event==='terminated'),18000);
        checks.push('VS Code Kotlin gutter breakpoints verified the actual commonMain and jvmMain executable lines and showed the exact source and values.');
        return {task:opened.task,common,jvm,liveVerified:true,exactPath:true,...completion};
      } finally {
        vscode.debug.removeBreakpoints(breakpoints);
        tracker.dispose();
        await service.stop();
        const tabs=vscode.window.tabGroups.all.flatMap(group=>group.tabs).filter(tab=>{
          const uri=tab.input?.uri;
          if (uri?.scheme!=='file' || uri.authority) return false;
          const relative=path.relative(fixture.root,uri.fsPath);
          return Boolean(relative) && !path.isAbsolute(relative) && relative!=='..' && !relative.startsWith('..'+path.sep);
        });
        if (tabs.length) await vscode.window.tabGroups.close(tabs);
      }
    },{sourceLines:true});
  } finally {
    for (const [name,value] of previous.reverse()) await config.update(name,value,scope);
  }
}

module.exports={runKmpJvmSourceLinesHeadless,runKmpJvmSourceLinesChecks};
if (require.main===module) runKmpJvmSourceLinesHeadless().then(result=>console.log(JSON.stringify(result))).catch(error=>{
  console.error(error.stack);
  process.exitCode=1;
});
