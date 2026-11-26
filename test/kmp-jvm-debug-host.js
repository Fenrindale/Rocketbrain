'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { pathToFileURL } = require('node:url');
const { resolveLaunch, serverSettings } = require('../src/java/runtime');
const { loadKmpModel } = require('../src/java/kmp-gradle');
const { startKmpJvmDebug } = require('../src/java/kmp-jvm-debug');
const { createDebugProcessDiscovery } = require('../src/java/debug-processes');
const { StdioLsp, until } = require('./helpers/stdio-lsp');
const { DapClient } = require('./java-debug-dap');
const { jdbcReadback } = require('./java-source-analysis-host');

const fixture = path.join(__dirname,'fixtures/java/kotlin-multiplatform');
const invoke = promisify(execFile);
const permission = {workspaceTrusted:true,allowProjectExecution:true};
const names = ['kmpfixture.MainKt#commonProbe','kmpfixture.PlatformJvmKt#jvmProbe'];

async function ownedFixture(parent,work,{sourceLines=false}={}) {
  const directory=await fs.realpath(parent), root=await fs.mkdtemp(path.join(directory,'rb-kmp-jvm-proof-'));
  try {
    const project=path.join(root,'project');
    await fs.cp(fixture,project,{recursive:true});
    const common=path.join(project,'src/commonMain/kotlin/kmpfixture/Main.kt');
    const actual=path.join(project,'src/jvmMain/kotlin/kmpfixture/PlatformJvm.kt');
    const signal=path.join(project,'rocketbrain-debug-results.txt');
    const configFile=process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG;
    const config=configFile ? JSON.parse(await fs.readFile(configFile,'utf8')) : undefined;
    if (config) {
      assert.equal(config.dbEngine,process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE);
      assert.match(config.baseUrl,/^http:\/\/127\.0\.0\.1:\d+$/);
    }
    await fs.writeFile(common,[
      'package kmpfixture','',
      'fun commonProbe(seed: Int): Int {',
      sourceLines ? '    val commonValue = (seed + 5).also { check(it == 12) }' : '    val commonValue = seed + 5',
      '    return commonValue * 2',
      '}','',
      'fun main() {',
      ...(sourceLines?['    check(shadow.matchingName() == 99)']:[]),
      '    val result = commonProbe(7)',
      '    println("Rocketbrain KMP ${describe(result)}")',
      '}',''
    ].join('\n'));
    if (sourceLines) {
      const duplicate=path.join(project,'src/commonMain/kotlin/shadow/Main.kt');
      await fs.mkdir(path.dirname(duplicate),{recursive:true});
      await fs.writeFile(duplicate,[
        'package shadow','','fun matchingName(): Int {','    val commonValue = 99','    return commonValue','}',''
      ].join('\n'),{flag:'wx'});
    }
    await fs.writeFile(actual,[
      'package kmpfixture','',
      'actual val platformLabel: String = "JVM"',
      'actual fun describe(value: String): String = value.uppercase()',
      'actual fun describe(value: Int): String = jvmProbe(value)','',
      'private fun jvmProbe(input: Int): String {',
      '    val ownedValue = input + 3',
      ...(config ? [
        '    val request = java.net.http.HttpRequest.newBuilder(java.net.URI.create('+JSON.stringify(config.baseUrl+'/probe/testing-state')+'))',
        '        .timeout(java.time.Duration.ofSeconds(6)).build()',
        '    val response = java.net.http.HttpClient.newHttpClient().send(request, java.net.http.HttpResponse.BodyHandlers.ofString())',
        '    check(response.statusCode() == 200 && response.body().contains("\\\"people\\\":2"))'
      ] : []),
      '    java.io.File('+JSON.stringify(signal.replaceAll('\\','/'))+').writeText("'+(config?.dbEngine || 'standalone')+':$ownedValue")',
      '    return "count=$input"',
      '}',''
    ].join('\n'));
    return await work({root,project,common,actual,signal,engine:config?.dbEngine});
  } finally {
    const real=await fs.realpath(root);
    assert.equal(path.relative(root,real),'');
    assert.equal(path.relative(directory,path.dirname(real)),'');
    assert.match(path.basename(real),/^rb-kmp-jvm-proof-[a-zA-Z0-9]{6}$/);
    await fs.rm(real,{recursive:true,maxRetries:12,retryDelay:300});
  }
}

async function frameLocal(request,threadId,source,name,value) {
  const [frame]=(await request('stackTrace',{threadId,startFrame:0,levels:1})).stackFrames;
  assert.ok(frame.source?.path,JSON.stringify(frame));
  assert.equal(path.relative(source,frame.source.path),'');
  const {scopes}=await request('scopes',{frameId:frame.id});
  const local=scopes.find(scope=>/local/i.test(scope.name));
  assert.ok(local,JSON.stringify(scopes));
  const {variables}=await request('variables',{variablesReference:local.variablesReference});
  assert.equal(variables.find(item=>item.name===name)?.value,String(value),JSON.stringify(variables));
  return {line:frame.line,local:name,value,source:path.basename(source)};
}

async function readCompletion(fixture) {
  const completion=await until(()=>fs.readFile(fixture.signal,'utf8').catch(()=>undefined),15000);
  assert.equal(completion,(fixture.engine || 'standalone')+':27');
  return {completion,jdbc:await jdbcReadback()};
}

function toolsFor(javaHome) {
  return {javaHome,gradleHome:process.env.ROCKETBRAIN_KMP_GRADLE_HOME,gradleUserHome:process.env.ROCKETBRAIN_KMP_GRADLE_USER_HOME};
}

async function runKmpJvmDebugHeadless() {
  return ownedFixture(os.tmpdir(),async fixture=>{
    const config=JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_JAVA_TEST_CONFIG,'utf8'));
    const tools=toolsFor(config.javaHome), resolver=createDebugProcessDiscovery({javaHome:()=>config.javaHome,trusted(){}});
    const runner={async execute(spec){
      try {await invoke(spec.command,spec.args,{cwd:spec.cwd,env:spec.env,timeout:190000,maxBuffer:2500000});return {code:0};}
      catch(error){process.stderr.write(error.stdout || '');process.stderr.write(error.stderr || '');throw error;}
    }};
    let engine, app, dap;
    try {
      const model=await loadKmpModel({root:fixture.project,tools,runner,...permission});
      const options={model,modulePath:':',targetName:'jvm',tools,...permission,resolveDescendant:resolver.resolveDescendant,
        onOutput:chunk=>process.stderr.write(chunk)};
      await assert.rejects(startKmpJvmDebug({...options,targetName:'js'}),/observed Kotlin JVM application/);
      await assert.rejects(startKmpJvmDebug({...options,allowProjectExecution:false}),/trusted workspace/);
      const jdtWorkspace=path.join(fixture.root,'jdt-workspace');
      await fs.cp(path.join(__dirname,'fixtures/java/maven'),jdtWorkspace,{recursive:true});
      const rootUri=pathToFileURL(jdtWorkspace).href;
      const launch=resolveLaunch({...config,storagePath:path.join(fixture.root,'jdt')});
      engine=new StdioLsp(launch);
      await engine.request('initialize',{processId:process.pid,rootUri,workspaceFolders:[{uri:rootUri,name:'kmp-debug'}],
        capabilities:{workspace:{configuration:true}},initializationOptions:{bundles:launch.bundles,workspaceFolders:[rootUri],
          settings:serverSettings([{name:'JavaSE-25',path:config.javaHome,default:true}])}},90000);
      engine.notify('initialized',{});
      const port=await until(()=>engine.request('workspace/executeCommand',{command:'vscode.java.startDebugSession',arguments:[]},12000),65000);
      app=await startKmpJvmDebug(options);
      assert.equal(app.task,':jvmRun');
      assert.notEqual(app.target.pid,app.target.ancestorPid);
      dap=new DapClient(port);
      const request=(...args)=>dap.request(...args);
      await request('initialize',{adapterID:'rocketbrain-java',clientID:'kmp-jvm-debug',linesStartAt1:true,columnsStartAt1:true,pathFormat:'path'});
      const attaching=request('attach',{hostName:app.target.hostName,port:app.target.port,sourcePaths:app.sourcePaths});
      void attaching.catch(()=>{});
      await dap.event('initialized');
      const source=await request('setBreakpoints',{source:{name:'Main.kt',path:fixture.common},breakpoints:[{line:5}]});
      await request('setBreakpoints',{source:{name:'Main.kt',path:fixture.common},breakpoints:[]});
      await request('setFunctionBreakpoints',{breakpoints:names.map(name=>({name}))});
      await request('configurationDone');
      await attaching;
      let stop=await dap.event('stopped',0,22000);
      assert.equal(stop.reason,'function breakpoint');
      const commonEntry=await frameLocal(request,stop.threadId,fixture.common,'seed',7);
      let offset=dap.events.length;
      await request('next',{threadId:stop.threadId,granularity:'line'});
      stop=await dap.event('stopped',offset,22000);
      assert.equal(stop.reason,'step');
      const common=await frameLocal(request,stop.threadId,fixture.common,'commonValue',12);
      offset=dap.events.length;
      await request('continue',{threadId:stop.threadId});
      stop=await dap.event('stopped',offset,22000);
      assert.equal(stop.reason,'function breakpoint');
      const jvm=await frameLocal(request,stop.threadId,fixture.actual,'input',24);
      await request('continue',{threadId:stop.threadId});
      const proof=await readCompletion(fixture);
      assert.equal((await app.done).code,0);
      await assert.rejects(resolver.resolve(app.target),/verified local JDWP listener/);
      return {task:app.task,commonEntry,common,jvm,ownedLoopback:true,sourceBreakpointVerified:source.breakpoints[0].verified,...proof};
    } finally {
      await dap?.close();
      try {await app?.stop();}
      finally {await engine?.close();}
    }
  });
}

async function runKmpJvmDebugChecks(api,vscode,checks) {
  const workspace=vscode.workspace.workspaceFolders[0].uri.fsPath, service=api.java.kotlinMultiplatform;
  assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.kotlin.multiplatform.debugJvm'));
  const settings=vscode.workspace.getConfiguration('rocketbrain.kotlin'), scope=vscode.ConfigurationTarget.Global, changes=[];
  try {
    for (const [name,value] of Object.entries({
      gradleHome:process.env.ROCKETBRAIN_KMP_GRADLE_HOME,gradleUserHome:process.env.ROCKETBRAIN_KMP_GRADLE_USER_HOME
    })) {
      if (!value) continue;
      changes.push([name,settings.inspect(name)?.globalValue]);
      await settings.update(name,value,scope);
    }
    return await ownedFixture(workspace,async fixture=>{
      const projectUri=vscode.Uri.file(fixture.project).toString();
      const options={projectUri,modulePath:':',targetName:'jvm',allowProjectExecution:true};
      await assert.rejects(service.debugJvm({...options,allowProjectExecution:false}),/Explicitly choose/);
      const model=await service.inspect(options);
      assert.ok(model.modules.find(item=>item.path===':').targets.some(item=>item.name==='jvm' && item.runTask === ':jvmRun'));
      await assert.rejects(service.debugJvm({...options,targetName:'js'}),/observed Kotlin JVM application/);
      const breakpoints=names.map(name=>new vscode.FunctionBreakpoint(name,true));
      const events=[];
      let session;
      const tracker=vscode.debug.registerDebugAdapterTrackerFactory('rocketbrain-java',{createDebugAdapterTracker(value){
        if (value.name!=='Kotlin JVM: :jvmRun' || !value.configuration.__rocketbrainKmpDebugSession) return undefined;
        session=value;
        return {onDidSendMessage(message){if(message.type==='event') events.push(message);}};
      }});
      vscode.debug.addBreakpoints(breakpoints);
      try {
        const opened=await service.debugJvm(options);
        assert.equal(opened.verifiedLoopback,true);
        assert.equal(opened.sessionId,session.id);
        assert.equal(opened.pid,api.java.debug.verifiedLocalPid(session));
        const request=session.customRequest.bind(session);
        const stopped=(offset,reason)=>until(()=>events.slice(offset).find(item=>item.event==='stopped'&&item.body.reason===reason)?.body,30000);
        let stop=await stopped(0,'function breakpoint');
        const commonEntry=await frameLocal(request,stop.threadId,fixture.common,'seed',7);
        let offset=events.length;
        await request('next',{threadId:stop.threadId,granularity:'line'});
        stop=await stopped(offset,'step');
        const common=await frameLocal(request,stop.threadId,fixture.common,'commonValue',12);
        offset=events.length;
        await request('continue',{threadId:stop.threadId});
        stop=await stopped(offset,'function breakpoint');
        const jvm=await frameLocal(request,stop.threadId,fixture.actual,'input',24);
        await request('continue',{threadId:stop.threadId});
        const proof=await readCompletion(fixture);
        await until(()=>events.some(item=>item.event==='terminated'),18000);
        checks.push('The exact Kotlin Gradle JVM application stopped in commonMain and jvmMain, stepped through a Kotlin local, and completed its Spring JDBC request.');
        return {task:opened.task,commonEntry,common,jvm,ownedLoopback:true,...proof};
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
    });
  } finally {
    for (const [name,previous] of changes.reverse()) await settings.update(name,previous,scope);
  }
}

module.exports={runKmpJvmDebugHeadless,runKmpJvmDebugChecks,ownedFixture,frameLocal,readCompletion,toolsFor};
if (require.main===module) runKmpJvmDebugHeadless().then(proof=>console.log(JSON.stringify(proof))).catch(error=>{
  console.error(error.stack);
  process.exitCode=1;
});
