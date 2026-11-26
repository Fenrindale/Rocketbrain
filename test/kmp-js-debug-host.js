'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const net=require('node:net');
const { execFile }=require('node:child_process');
const { promisify }=require('node:util');
const { once }=require('node:events');
const { loadKmpModel }=require('../src/java/kmp-gradle');
const { jsDebugSelection,snapshotJsInputs,buildKotlinJsDebug }=require('../src/java/kmp-js-build');
const { nodeExecutable,runKotlinJsInspector,checkInspectorOwner }=require('../src/java/kmp-js-inspector');
const { createKotlinJsDebugAdapter }=require('../src/java/kmp-js-debug-adapter');
const { DEBUG_TYPE }=require('../src/java/kmp-js-debug-vscode');
const { until }=require('./helpers/stdio-lsp');
const { importedSpring,jdbcReadback }=require('./java-source-analysis-host');

const invoke=promisify(execFile);
const stock=path.join(__dirname,'fixtures/java/kotlin-multiplatform');

async function ownedFixture(parent,work) {
  const directory=await fs.realpath(parent), root=await fs.mkdtemp(path.join(directory,'rb-kmp-js-proof-'));
  try {
    assert.ok(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG);
    const config=JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG,'utf8'));
    assert.equal(config.dbEngine,process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE);
    assert.match(config.dbEngine,/^(mysql|mariadb)$/u);
    assert.match(config.baseUrl,/^http:\/\/127\.0\.0\.1:\d+$/u);
    await fs.cp(stock,root,{recursive:true});
    const common=path.join(root,'src/commonMain/kotlin/kmpfixture/Main.kt');
    const platform=path.join(root,'src/jsMain/kotlin/kmpfixture/PlatformJs.kt');
    const foreign=path.join(root,'unrelated/PlatformJs.kt');
    const sharedSource=[
      'package kmpfixture','','fun main() {','    val commonSeed = 7','    val commonLabel = "common"',
      '    val combined = commonSeed + 6','    println(commonLabel + ":" + combined)',
      '    println(describe(combined))','}',''
    ].join('\n');
    const jsSource=[
      'package kmpfixture','','actual val platformLabel: String = "JS"',
      'actual fun describe(value: String): String = value.uppercase()','',
      'actual fun describe(value: Int): String {','    val ownedValue = value + 29',
      '    val label = "node"','    report(ownedValue, label)','    return label + ":" + ownedValue','}','',
      'private fun report(count: Int, label: String) {',
      '    val http = js("require(\'node:http\')")',
      '    http.get('+JSON.stringify(config.baseUrl+'/probe/testing-state')+', { response: dynamic ->',
      '        check(response.statusCode == 200)','        var body = ""','        response.setEncoding("utf8")',
      '        response.on("data", { chunk: String -> body += chunk })',
      '        response.on("end", {','            val state = JSON.parse<dynamic>(body)',
      '            check(state.people == 2 && state.departments == 1 && state.rolledBackNames == 0)',
      '            println("rocketbrain-kotlin-js:'+config.dbEngine+':" + label + ":" + count)','        })',
      '    }).on("error", { error: dynamic -> throw IllegalStateException(error.message as String) })','}',''
    ].join('\n');
    await fs.writeFile(common,sharedSource);
    await fs.writeFile(platform,jsSource);
    await fs.mkdir(path.dirname(foreign));
    await fs.writeFile(foreign,jsSource,{flag:'wx'});
    return await work({root,common,platform,foreign,sharedSource,engine:config.dbEngine,
      expectedOutput:'rocketbrain-kotlin-js:'+config.dbEngine+':node:42'});
  } finally {
    const physical=await fs.realpath(root);
    assert.equal(path.relative(root,physical),'');
    assert.equal(path.relative(directory,path.dirname(physical)),'');
    assert.match(path.basename(physical),/^rb-kmp-js-proof-[A-Za-z0-9]{6}$/u);
    await fs.rm(physical,{recursive:true,maxRetries:12,retryDelay:300});
  }
}

async function checkFrame(request,file,line,expected,kind='breakpoint') {
  const {stackFrames}=await request('stackTrace',{threadId:1,startFrame:0,levels:1});
  const [frame]=stackFrames;
  assert.equal(path.relative(file,frame.source.path),'');
  assert.equal(frame.line,line);
  const {scopes}=await request('scopes',{frameId:frame.id});
  const local=scopes.find(scope=>scope.name==='Locals');
  if (expected) {
    assert.ok(local);
    const {variables}=await request('variables',{variablesReference:local.variablesReference});
    for (const [name,value] of Object.entries(expected)) assert.equal(variables.find(item=>item.name===name)?.value,value);
  }
  return {source:path.basename(file),line,kind,locals:expected ?? {}};
}

function eventWait(events,from,event,reason) {
  return until(()=>events.slice(from).find(item=>item.event===event && (!reason || item.body?.reason===reason)),25000);
}

async function interact(request,events,fixture) {
  await eventWait(events,0,'stopped','breakpoint');
  const common=await checkFrame(request,fixture.common,6,{commonSeed:'7',commonLabel:'"common"'});
  let offset=events.length;
  await request('next',{threadId:1,granularity:'line'});
  await eventWait(events,offset,'stopped','step');
  const stepped=await checkFrame(request,fixture.common,7,{combined:'13'},'step');
  offset=events.length;
  await request('continue',{threadId:1});
  await eventWait(events,offset,'stopped','breakpoint');
  const js=await checkFrame(request,fixture.platform,9,{ownedValue:'42',label:'"node"'});
  await request('continue',{threadId:1});
  await eventWait(events,0,'terminated');
  const output=events.filter(item=>item.event==='output').map(item=>item.body.output).join('');
  assert.ok(output.includes(fixture.expectedOutput),output);
  assert.doesNotMatch(output,/ws:\/\/127\.0\.0\.1:/u);
  return {common,stepped,js,completion:fixture.expectedOutput,jdbc:await jdbcReadback()};
}

async function portClosed(port) {
  return until(()=>new Promise(resolve=>{
    const socket=net.createConnection({host:'127.0.0.1',port});
    socket.once('error',()=>resolve(true));
    socket.once('connect',()=>{socket.destroy();resolve(false);});
    socket.setTimeout(900,()=>{socket.destroy();resolve(false);});
  }),10000);
}

async function runKmpJsDebugHeadless() {
  return ownedFixture(os.tmpdir(),async fixture=>{
    const config=JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_JAVA_TEST_CONFIG,'utf8'));
    const tools={javaHome:config.javaHome,gradleHome:process.env.ROCKETBRAIN_KMP_GRADLE_HOME,
      gradleUserHome:process.env.ROCKETBRAIN_KMP_GRADLE_USER_HOME,nodeHome:process.env.ROCKETBRAIN_KMP_NODE_HOME};
    const runner={async execute(spec){
      try {
        await invoke(spec.command,[...spec.args,'--offline'],{cwd:spec.cwd,env:spec.env,
          timeout:210000,maxBuffer:4*1024*1024,windowsHide:true});
        return {code:0};
      } catch(error) {
        process.stderr.write(error.stdout || '');
        process.stderr.write(error.stderr || '');
        throw error;
      }
    }};
    const model=await loadKmpModel({root:fixture.root,tools,runner,workspaceTrusted:true,allowProjectExecution:true});
    const selection=jsDebugSelection(model,':','js');
    assert.throws(()=>jsDebugSelection(model,':','jvm'),/Node development executable/);
    const fingerprint=snapshotJsInputs(model,selection).fingerprint;
    const validate=()=>{
      const snapshot=snapshotJsInputs(model,selection);
      if(snapshot.fingerprint!==fingerprint) throw Error('Saved Kotlin inputs changed');
      return snapshot;
    };
    const node=nodeExecutable(tools.nodeHome);
    const stage=await buildKotlinJsDebug({model,selection,tools,runner,validate});
    let run,adapter;
    const messages=[], events=[];
    const send=message=>(message.type==='event'?events:messages).push(message);
    let sequence=0;
    const request=async(command,args={})=>{
      const seq=++sequence;
      adapter.handleMessage({type:'request',seq,command,arguments:args});
      const result=await until(()=>messages.find(value=>value.request_seq===seq),16000);
      if(!result.success) throw Error(result.message);
      return result.body;
    };
    try {
      run=await runKotlinJsInspector({node,stage,onOutput:(category,text)=>adapter?.output(category,text)});
      const outside=net.createServer();
      outside.listen(0,'127.0.0.1');
      try {
        await once(outside,'listening');
        await assert.rejects(checkInspectorOwner(run.pid,outside.address().port),/belong exclusively/);
      } finally {await new Promise(resolve=>outside.close(resolve));}
      adapter=createKotlinJsDebugAdapter({run,stage,validate,send});
      await request('initialize');
      await request('launch');
      const bp=async(file,...breakpoints)=>(await request('setBreakpoints',{source:{path:file},breakpoints})).breakpoints;
      assert.equal((await bp(fixture.foreign,{line:9}))[0].verified,false);
      assert.deepEqual((await bp(fixture.common,{line:1},{line:5,condition:'true'},{line:6}))
        .map(item=>item.verified),[false,false,true]);
      assert.equal((await bp(fixture.platform,{line:9}))[0].verified,true);
      await assert.rejects(request('evaluate',{expression:'ownedValue'}),/unavailable/);
      await request('configurationDone');
      const result=await interact(request,events,fixture);
      assert.equal((await run.done).code,0);
      await run.stop();
      assert.ok(await portClosed(run.port));
      await assert.rejects(fs.stat(stage.directory),{code:'ENOENT'});
      await fs.appendFile(fixture.common,'// changed after review\n');
      try {await assert.rejects(buildKotlinJsDebug({model,selection,tools,runner,validate}),/inputs changed/);}
      finally {await fs.writeFile(fixture.common,fixture.sharedSource);}
      await staleStoppedSession({fixture,model,selection,tools,runner,validate,node});
      return {engine:fixture.engine,buildTask:selection.syncTask,artifactSha256:stage.artifactSha256,
        mapSha256:stage.mapSha256,sourceCount:stage.mapping.sourceCount,ownedLoopback:true,foreignListenerRefused:true,
        foreignSourceRefused:true,conditionalBreakpointRefused:true,staleBeforeBuild:true,staleWhilePaused:true,
        boundedLocals:true,ownedShutdown:true,...result};
    } finally {
      adapter?.dispose();
      if(run) await run.stop();
      else await stage.remove();
    }
  });
}

async function staleStoppedSession({fixture,model,selection,tools,runner,validate,node}) {
  const stage=await buildKotlinJsDebug({model,selection,tools,runner,validate});
  let run,adapter,sequence=0;
  const messages=[],events=[];
  try {
    run=await runKotlinJsInspector({node,stage,onOutput:(category,text)=>adapter?.output(category,text)});
    adapter=createKotlinJsDebugAdapter({run,stage,validate,send:message=>(message.type==='event'?events:messages).push(message)});
    const request=async(command,args={})=>{
      const seq=++sequence;
      adapter.handleMessage({type:'request',seq,command,arguments:args});
      return until(()=>messages.find(value=>value.request_seq===seq),16000);
    };
    assert.equal((await request('launch')).success,true);
    assert.equal((await request('setBreakpoints',{source:{path:fixture.common},breakpoints:[{line:6}]})).body.breakpoints[0].verified,true);
    assert.equal((await request('configurationDone')).success,true);
    await eventWait(events,0,'stopped','breakpoint');
    await fs.appendFile(fixture.common,'// changed during suspension\n');
    const skipped=await request('continue',{threadId:1});
    assert.equal(skipped.success,false);
    assert.match(skipped.message,/inputs changed/);
    await eventWait(events,0,'terminated');
    assert.notEqual((await run.done).code,0);
    assert.ok(await portClosed(run.port));
    assert.ok(!events.some(event=>event.event==='output'&&event.body.output.includes(fixture.expectedOutput)));
  } finally {
    adapter?.dispose();
    if(run) await run.stop();
    else await stage.remove();
    await fs.writeFile(fixture.common,fixture.sharedSource);
  }
}

async function runKmpJsDebugChecks(api,vscode,checks) {
  const service=api.java.kotlinMultiplatform;
  assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.kotlin.multiplatform.debugJs'));
  const workspace=vscode.workspace.workspaceFolders[0].uri.fsPath;
  await importedSpring(api,workspace);
  const settings=vscode.workspace.getConfiguration('rocketbrain.kotlin'), scope=vscode.ConfigurationTarget.Global, changes=[];
  try {
    for(const [setting,value] of Object.entries({gradleHome:process.env.ROCKETBRAIN_KMP_GRADLE_HOME,
      gradleUserHome:process.env.ROCKETBRAIN_KMP_GRADLE_USER_HOME,nodeHome:process.env.ROCKETBRAIN_KMP_NODE_HOME})) {
      assert.ok(value,'Missing Kotlin/JS '+setting+' proof input');
      changes.push([setting,settings.inspect(setting)?.globalValue]);
      await settings.update(setting,value,scope);
    }
    return await ownedFixture(workspace,async fixture=>{
      const projectUri=vscode.Uri.file(fixture.root).toString();
      const options={projectUri,modulePath:':',targetName:'js',allowProjectExecution:true};
      await service.inspect(options);
      const stale=service.prepareJsDebug(options);
      await fs.appendFile(fixture.common,'// saved edit after review\n');
      await assert.rejects(service.debugJs({...options,reviewId:stale.reviewId}),/settings changed since review/);
      await fs.writeFile(fixture.common,fixture.sharedSource);

      const events=[], breakpoints=[[fixture.common,6],[fixture.platform,9]].map(([file,line])=>
        new vscode.SourceBreakpoint(new vscode.Location(vscode.Uri.file(file),new vscode.Position(line-1,0))));
      let session;
      const tracker=vscode.debug.registerDebugAdapterTrackerFactory(DEBUG_TYPE,{createDebugAdapterTracker(candidate){
        if(candidate.name!=='Kotlin/JS Node: js') return undefined;
        session=candidate;
        return {onDidSendMessage(message){if(message.type==='event') events.push(message);}};
      }});
      vscode.debug.addBreakpoints(breakpoints);
      try {
        const selected=service.prepareJsDebug(options), launch={...options,reviewId:selected.reviewId};
        await assert.rejects(service.debugJs({...launch,allowProjectExecution:false}),/Explicitly choose/);
        const ready=await service.debugJs(launch);
        assert.ok(session);
        assert.equal(ready.sessionId,session.id);
        assert.equal(ready.ownedLoopback,true);
        assert.equal(ready.buildTask,':jsDevelopmentExecutableCompileSync');
        assert.match(ready.artifactSha256,/^[a-f0-9]{64}$/u);
        assert.match(ready.mapSha256,/^[a-f0-9]{64}$/u);
        const result=await interact(session.customRequest.bind(session),events,fixture);
        await service.stop();
        await assert.rejects(service.debugJs(launch),/review is unavailable or out of date/);
        checks.push('Reviewed Kotlin/JS Node Gradle build stopped in commonMain and jsMain, read exact locals, stepped a Kotlin line and completed the Spring JDBC HTTP readback.');
        return {engine:fixture.engine,buildTask:ready.buildTask,artifactSha256:ready.artifactSha256,
          mapSha256:ready.mapSha256,sourceCount:ready.sourceCount,ownedLoopback:true,staleBeforeBuild:true,
          oneUseReview:true,nativeDap:true,springWorkspace:true,...result};
      } finally {
        await service.stop();
        vscode.debug.removeBreakpoints(breakpoints);
        tracker.dispose();
        const tabs=vscode.window.tabGroups.all.flatMap(group=>group.tabs).filter(tab=>{
          const uri=tab.input?.uri;
          if(uri?.scheme!=='file'||uri.authority) return false;
          const relative=path.relative(fixture.root,uri.fsPath);
          return relative&&!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith('..'+path.sep);
        });
        if(tabs.length) await vscode.window.tabGroups.close(tabs);
      }
    });
  } finally {
    for(const [name,previous] of changes.reverse()) await settings.update(name,previous,scope);
  }
}

module.exports={runKmpJsDebugHeadless,runKmpJsDebugChecks};
if(require.main===module) runKmpJsDebugHeadless().then(result=>console.log(JSON.stringify(result))).catch(error=>{
  console.error(error.stack);
  process.exitCode=1;
});
