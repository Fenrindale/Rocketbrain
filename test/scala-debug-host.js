'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createSbtRunner } = require('../src/java/scala-sbt');
const { version: adapterVersion } = require('../src/java/scala-debug-runtime');
const { DapClient } = require('./java-debug-dap');
const { until } = require('./helpers/stdio-lsp');
const { populateScala, scala2, scala3 } = require('./helpers/scala-fixture');
const { jdbcReadback } = require('./java-source-analysis-host');

const main = 'scalafixture.Application';
const relative = 'app/src/main/scala/scalafixture/Application.scala';

async function ownedFixture(parent, version, work) {
  const directory = await fs.realpath(parent);
  const root = await fs.mkdtemp(path.join(directory, 'rb-scala-debug-'));
  try {
    await populateScala(root, version);
    const name = path.join(root, relative);
    const before = await fs.readFile(name, 'utf8');
    const source = before.replace('def count: String = Message.hello(3)', [
      'def count: String = {', '    val number = 3', '    Message.hello(number)', '  }'
    ].join('\n'));
    assert.notEqual(source, before);
    await fs.writeFile(name, source);
    await fs.writeFile(path.join(root, 'project/plugins.sbt'),
      'addSbtPlugin("ch.epfl.scala" % "sbt-debug-adapter" % "'+adapterVersion+'")\n', { flag: 'wx' });
    const line = source.split('\n').findIndex(text => text.includes('Message.hello(number)'))+1;
    assert.ok(line > 0);
    return await work(root, name, line);
  } finally {
    const physical = await fs.realpath(root);
    assert.equal(path.relative(path.dirname(physical),directory),'');
    assert.match(path.basename(physical), /^rb-scala-debug-/);
    await fs.rm(physical,{recursive:true,force:true,maxRetries:8,retryDelay:250});
  }
}

async function frameAndLocal(request, threadId, target, line) {
  const frame = (await request('stackTrace',{threadId})).stackFrames[0];
  assert.equal(frame.line,line);
  assert.equal(path.relative(frame.source.path,target),'');
  assert.match(frame.name,/Application.*count/);
  const scopes = (await request('scopes',{frameId:frame.id})).scopes;
  const locals = scopes.find(scope=>/local/i.test(scope.name));
  assert.ok(locals, 'The Scala frame exposes a local scope.');
  const variables = (await request('variables',{variablesReference:locals.variablesReference})).variables;
  assert.equal(variables.find(variable=>variable.name==='number')?.value,'3');
  return {line,local:'3'};
}

function settings(root, javaHome) {
  const {ROCKETBRAIN_SBT_LAUNCHER: launcher, ROCKETBRAIN_SBT_CACHE: cache,
    ROCKETBRAIN_SBT_REPOSITORIES: repositoryConfig} = process.env;
  return {root,javaHome,launcher,cache,repositoryConfig,projectId:'app',
    workspaceTrusted:true,allowProjectExecution:true,main};
}

async function runHeadless(version) {
  const root = path.resolve(__dirname,'../test-output');
  const {ROCKETBRAIN_SPRING_JAVA_HOME:javaHome} = process.env;
  const runner = createSbtRunner({log: text=>process.stderr.write(text)});
  let client;
  try {
    return await ownedFixture(root,version,async(owned,source,line)=>{
      const target = await runner.debug(settings(owned,javaHome));
      const proof = await runner.verifyDebug(target);
      assert.equal(proof.address,'127.0.0.1');
      assert.equal(proof.verified,true);
      client = new DapClient(proof.port);
      const request = (...args)=>client.request(...args);
      await request('initialize',{adapterID:'scala',clientID:'rocketbrain-scala',
        linesStartAt1:true,columnsStartAt1:true,pathFormat:'path'});
      const launch = request('launch',{name:'Scala main',type:'rocketbrain-scala',request:'launch',noDebug:false});
      launch.catch(()=>{});
      await client.event('initialized');
      await request('setBreakpoints',{source:{name:path.basename(source),path:source},breakpoints:[{line}]});
      await request('configurationDone');
      await launch;
      const stop = await client.event('stopped');
      assert.equal(stop.reason,'breakpoint');
      const frame = await frameAndLocal(request,stop.threadId,source,line);
      await request('continue',{threadId:stop.threadId});
      await client.event('terminated');
      const output = client.events.filter(event=>event.event==='output').map(event=>event.body.output).join('');
      assert.match(output,/Scala greets Rocketbrain \/ Scala counted 3/);
      await client.close();
      await runner.stop();
      await assert.rejects(runner.verifyDebug(target),/owned Scala debugger has ended/);
      return {version,frame,verifiedLoopback:true,debuggeeCompleted:true,pathMatched:true};
    });
  } finally {
    try { await client?.close(); }
    finally { await runner.dispose(); }
  }
}

async function runScalaDebugChecks(api,vscode,checks,version=scala2) {
  const workspace = await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
  const config = vscode.workspace.getConfiguration('rocketbrain.scala');
  const target = vscode.ConfigurationTarget.Global;
  const changes = [];
  let breakpoint,tracker;
  const service = api.java.scala;
  try {
    for (const [key,value] of Object.entries({sbtLauncher:process.env.ROCKETBRAIN_SBT_LAUNCHER,
      cacheDirectory:process.env.ROCKETBRAIN_SBT_CACHE,repositoryConfig:process.env.ROCKETBRAIN_SBT_REPOSITORIES})) {
      if (!value) continue;
      changes.push([key,config.inspect(key)?.globalValue]);
      await config.update(key,value,target);
    }
    return await ownedFixture(workspace,version,async(root,source,line)=>{
      try {
        const options={projectUri:pathToFileURL(root).href,projectId:'app',mainClass:main,allowProjectExecution:true};
        assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.scala.debug'));
        await assert.rejects(service.debug({...options,allowProjectExecution:false}),/Explicitly choose the sbt task/);
        assert.ok((await service.discover(options)).projects.some(project=>project.id==='app'));
        const uri=vscode.Uri.file(source);
        breakpoint=new vscode.SourceBreakpoint(new vscode.Location(uri,new vscode.Position(line-1,0)),true);
        vscode.debug.addBreakpoints([breakpoint]);
        const events=[];
        let session;
        tracker=vscode.debug.registerDebugAdapterTrackerFactory('rocketbrain-scala',{createDebugAdapterTracker(current){
          session=current;
          return {onDidSendMessage(message){if(message.type==='event') events.push(message);}};
        }});
        const opened=await service.debug(options);
        assert.equal(opened.verifiedLoopback,true);
        const stopped=await until(()=>events.find(event=>event.event==='stopped'&&event.body.reason==='breakpoint'),50000);
        assert.equal(session.id,opened.sessionId);
        const request=session.customRequest.bind(session);
        const frame=await frameAndLocal(request,stopped.body.threadId,source,line);
        await request('continue',{threadId:stopped.body.threadId});
        await until(()=>events.some(event=>event.event==='terminated'),50000);
        await until(()=>events.filter(event=>event.event==='output').map(event=>event.body.output).join('').includes('Scala greets Rocketbrain / Scala counted 3'),8000);
        checks.push('An actual sbt Scala main paused on its Scala source with the local value 3 and ran to completion after continuing.');
        return {version,frame,verifiedLoopback:true,debuggeeCompleted:true,pathMatched:true,installedVscode:true,jdbc:await jdbcReadback()};
      } finally {
        if(breakpoint)vscode.debug.removeBreakpoints([breakpoint]);
        tracker?.dispose();
        await service.stop();
      }
    });
  } finally {
    for (const [key,previous] of changes.reverse()) await config.update(key,previous,target);
  }
}

module.exports={runScalaDebugChecks};
if(require.main===module)runHeadless(process.argv.includes('--scala3')?scala3:scala2).then(result=>console.log(JSON.stringify(result))).catch(error=>{
  console.error(error.stack);process.exitCode=1;
});
