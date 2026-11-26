'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath, pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { StdioLsp, until } = require('./helpers/stdio-lsp');
const { DapClient } = require('./java-debug-dap');
const { createGroovyFixture } = require('./helpers/groovy-fixture');
const { springJdbcClasspath } = require('./helpers/instance-inline-fixture');
const { importedSpring, jdbcReadback } = require('./java-source-analysis-host');
const { withOwnedDatabase } = require('./micronaut-gradle-host');
const { createGroovyApplicationDebugger } = require('../src/java/groovy-debug-vscode');
const { createDebugProcessDiscovery } = require('../src/java/debug-processes');
const { GROOVY_DEBUG_MARKER } = require('../src/java/debug');
const { GROOVY_LINE_BUILDS, resolveDebugBundle } = require('../src/java/debug-runtime');
const { collectProjects, inside } = require('../src/java/workbench-model');
const { resolveLaunch, serverSettings } = require('../src/java/runtime');
const { buildSpec } = require('../src/java/workbench-tasks');
const { execute } = require('../src/java/testing/provision');

const read = file => fs.readFile(file, 'utf8').then(JSON.parse);
const uri = file => pathToFileURL(file).href;
const approval = { allowProjectExecution: true };
const sources = [
  'package groovyfixture',
  'import groovy.transform.CompileStatic',
  'import org.springframework.jdbc.core.JdbcTemplate',
  'import org.springframework.jdbc.datasource.DriverManagerDataSource',
  'import java.nio.file.Files',
  'import java.nio.file.Path',
  '',
  '@CompileStatic',
  'final class DebugProbe {',
  '  static void main(String[] args) {',
  '    int expected = 40',
  '    def data = new DriverManagerDataSource(System.getenv("RB_MICRONAUT_JDBC_URL"),',
  '      System.getenv("RB_MICRONAUT_JDBC_USER"), System.getenv("RB_MICRONAUT_JDBC_PASSWORD"))',
  '    JdbcTemplate jdbc = new JdbcTemplate(data)',
  '    int people = jdbc.queryForObject("SELECT COUNT(*) FROM rb_spring_person", Integer.class)',
  '    int result = expected + people',
  '    String version = jdbc.queryForObject("SELECT VERSION()", String.class)',
  '    Files.writeString(Path.of(System.getProperty("fixture.result")), version + "|" + result)',
  '  }',
  '}',
  ''
];
const line = sources.findIndex(text => text.includes('int result = ')) + 1;
const sourceText = sources.join('\n');

async function ownedFixture(parent, configure) {
  parent = await fs.realpath(parent);
  const root = await createGroovyFixture(parent);
  const identity = await fs.lstat(root, { bigint: true });
  try {
    const spring = await read(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG);
    const fixtures = await springJdbcClasspath(path.join(spring.projectPath, 'build', 'runtime-classpath.txt'), spring.dbEngine);
    const source = path.join(root, 'src/main/groovy/groovyfixture/DebugProbe.groovy');
    const anchor = path.join(root, 'src/main/java/groovyfixture/DebugAnchor.java');
    const result = path.join(root, '.owned-groovy-result');
    await fs.writeFile(source, sourceText, { flag: 'wx' });
    await fs.mkdir(path.dirname(anchor), { recursive: true });
    await fs.writeFile(anchor, 'package groovyfixture; public final class DebugAnchor {}\n', { flag: 'wx' });
    const quoted = file => JSON.stringify(file.replaceAll('\\', '/'));
    await fs.appendFile(path.join(root, 'build.gradle'), '\n' +
      'dependencies { implementation files(' + fixtures.map(quoted).join(', ') + ') }\n' +
      'application { mainClass = "groovyfixture.DebugProbe" }\n' +
      'run { systemProperty "fixture.result", ' + quoted(result) + ' }\n');
    return await configure({ root, source, anchor, result, engine: spring.dbEngine, projectUri: uri(root) });
  } finally {
    const current = await fs.realpath(root), stat = await fs.lstat(current, { bigint: true });
    assert.equal(path.relative(parent, path.dirname(current)), '');
    assert.match(path.basename(current), /^rb-groovy-fixture-/u);
    assert.deepEqual([stat.dev, stat.ino], [identity.dev, identity.ino]);
    await fs.rm(current, { recursive: true, force:true, maxRetries: 10, retryDelay: 250 });
  }
}

async function noPort(port) {
  await new Promise((resolve, reject) => {
    const socket=net.createConnection({ host:'127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); reject(Error('The owned Groovy debugger still accepts connections.')); });
    socket.once('error', error => error.code==='ECONNREFUSED' ? resolve() : reject(error));
    socket.setTimeout(1200, () => { socket.destroy(); reject(Error('Groovy listener closure timed out.')); });
  });
}

async function verifyPaused(fixture, request, stopped, expectedLine) {
  assert.ok(stopped.threadId);
  const { stackFrames } = await request('stackTrace', { threadId: stopped.threadId });
  const { name, line: reached, source, id } = stackFrames[0];
  assert.match(name, /DebugProbe\.main/u);
  assert.equal(reached, expectedLine);
  const physical = source.path.startsWith('file:') ? fileURLToPath(source.path) : source.path;
  assert.equal(path.relative(fixture.source, physical), '');
  const { scopes } = await request('scopes', { frameId: id });
  const locals = scopes.find(scope => /local/iu.test(scope.name));
  assert.ok(locals);
  const { variables } = await request('variables', { variablesReference: locals.variablesReference });
  assert.equal(variables.find(value => value.name === 'expected')?.value, '40');
  const count = variables.find(value => value.name === 'people');
  assert.deepEqual([count?.type,count?.value],['int','2']);
  await assert.rejects(fs.stat(fixture.result), { code:'ENOENT' });
  return { frame: name, line: reached, type: count.type, people: Number(count.value), source: path.basename(physical) };
}

async function resumed(fixture) {
  const result = await until(() => fs.readFile(fixture.result, 'utf8').catch(error => {
    if (error.code !== 'ENOENT') throw error;
  }), 18000);
  const [server, score] = result.split('|');
  assert.match(server, fixture.engine === 'mysql' ? /^8\.4\.13$/u : /^11\.4\.8.*MariaDB$/u);
  assert.equal(score, '42');
  const jdbc = await jdbcReadback();
  assert.deepEqual(jdbc, { people:2, departments:1, rolledBackNames:0 });
  return { server, score:Number(score), jdbc };
}

async function guards(debuggerApi, document, projectUri) {
  const plan = await debuggerApi.prepare({ document, projectUri });
  assert.equal(plan.task, ':run');
  assert.match(plan.source, /DebugProbe\.groovy$/u);
  await assert.rejects(debuggerApi.start({ id:plan.id }), /Explicitly approve/u);
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(debuggerApi.start({ id:plan.id, ...approval, cancellation:cancelled.signal }), /cancelled/u);
  return plan;
}

async function runGroovyApplicationDebugChecks(api, vscode, checks) {
  const workspace=await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
  await importedSpring(api, workspace);
  for (const command of ['debugApplication','stopDebugApplication']) {
    assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.groovy.'+command));
  }
  return withOwnedDatabase(() => ownedFixture(workspace, async fixture => {
    const debuggerApi=api.java.groovy.debug, source=vscode.Uri.file(fixture.source);
    const records=[];
    const tracking=vscode.debug.registerDebugAdapterTrackerFactory('rocketbrain-java',{
      createDebugAdapterTracker(session) {
        if (!session.configuration[GROOVY_DEBUG_MARKER]) return;
        return { onDidSendMessage(message) {
          if (message.type==='event' && message.event==='stopped') records.push({ id:session.id, ...message.body });
        } };
      }
    });
    const point=new vscode.SourceBreakpoint(new vscode.Location(source,new vscode.Position(line-1,0)));
    try {
      const view=await api.java.workbench.resyncProject({ projectUri:fixture.projectUri,...approval });
      assert.ok(view.projects.some(project => project.tool==='gradle' && !path.relative(project.root,fixture.root)));
      const document=await vscode.workspace.openTextDocument(source);
      assert.equal(document.languageId,'groovy');
      await vscode.window.showTextDocument(document,{preview:false});
      const plan=await guards(debuggerApi,document,fixture.projectUri);
      vscode.debug.addBreakpoints([point]);
      const attached=await debuggerApi.start({ id:plan.id,...approval });
      assert.equal(attached.state,'attached');
      assert.equal(attached.verifiedLoopback,true);
      const session=vscode.debug.activeDebugSession;
      assert.equal(session?.id,attached.sessionId);
      assert.equal(api.java.debug.verifiedLocalPid(session),attached.pid);
      const stopped=await until(()=>records.find(item=>item.id===session.id&&item.reason==='breakpoint'),20000);
      const request=session.customRequest.bind(session);
      const local=await verifyPaused(fixture,request,stopped,line);
      await request('next',{ threadId:stopped.threadId });
      const stepped=await until(()=>records.find(item=>item.id===session.id&&item.reason==='step'),15000);
      await verifyPaused(fixture,request,stepped,line+1);
      await request('continue',{ threadId:stepped.threadId });
      const after=await resumed(fixture);
      assert.equal((await vscode.commands.executeCommand('rocketbrain.groovy.stopDebugApplication')).state,'stopped');
      await noPort(attached.port);
      checks.push('Gradle compiled Groovy, the installed debugger verified the owned JVM, paused at the saved source line, read the JDBC local, stepped, continued and closed its listener.');
      return { ...after, local, steppedLine:line+1, exactSource:true, compiledGroovy:true, nativeSession:true, ownedShutdown:true };
    } finally {
      tracking.dispose();
      vscode.debug.removeBreakpoints([point]);
      await debuggerApi.stop();
      const tabs=vscode.window.tabGroups.all.flatMap(group=>group.tabs).filter(tab=>
        tab.input?.uri?.scheme==='file' && inside(fixture.root,tab.input.uri.fsPath));
      if (tabs.length) await vscode.window.tabGroups.close(tabs);
      await api.java.executeWorkspaceCommand('java.project.changeImportedProjects',[],[],[fixture.projectUri]).catch(()=>{});
    }
  }));
}

async function runHeadless(fixture) {
  const runtime=await read(process.env.ROCKETBRAIN_GROOVY_DEBUG_CONFIG);
  const gradleHome=await fs.realpath(process.env.ROCKETBRAIN_GROOVY_DEBUG_GRADLE_HOME);
  const { javaHome }=runtime;
  const bundle=resolveDebugBundle(runtime.debugBundlePath,runtime.serverPath);
  assert.ok(GROOVY_LINE_BUILDS.includes(bundle.build));
  await fs.appendFile(path.join(fixture.root,'build.gradle'),"\napply plugin: 'eclipse'\n");
  const projectDir={ root:fixture.root,uri:fixture.projectUri,name:'Owned Groovy app',tool:'gradle' };
  const eclipse=buildSpec(projectDir,{ javaHome,gradleHome },[':eclipse']);
  const exported=await execute(eclipse.command,[...eclipse.args,'--offline'],{
    cwd:eclipse.cwd,env:eclipse.env,timeoutMs:90000
  });
  assert.equal(exported.code,0,exported.output);
  assert.match(await fs.readFile(path.join(fixture.root,'.classpath'),'utf8'),/src\/main\/groovy/u);
  const parent=await fs.realpath(os.tmpdir());
  const storagePath=await fs.mkdtemp(path.join(parent,'rb-groovy-jdt-'));
  const storageIdentity=await fs.lstat(storagePath,{bigint:true});
  const lsp=new StdioLsp(resolveLaunch({ ...runtime,storagePath }));
  const command=(name,...args)=>lsp.request('workspace/executeCommand',{ command:name,arguments:args },90000);
  const trust=()=>{};
  const discovery=createDebugProcessDiscovery({ javaHome:()=>javaHome,trusted:trust });
  const starts=new Set(), ends=new Set(), sessions=new Map(), reviewPackets=new Map();
  const event=target=>handler=>{target.add(handler);return {dispose:()=>target.delete(handler)};};
  let service, logs='', local, stepped, unknownLineRefused, staleSourceRefused;
  let editorText=sourceText, version=1;
  const file={ scheme:'file',fsPath:fixture.source };
  const folder={ uri:{ scheme:'file',toString:()=>fixture.projectUri } };
  const document={ uri:file,languageId:'groovy',isDirty:false,get version(){return version;},getText:()=>editorText };
  try {
    const settings=serverSettings([{name:'JavaSE-25',path:javaHome,default:true}],{gradleHome,gradleJavaHome:javaHome});
    settings.java.autobuild.enabled=false;
    settings.java.import.gradle.enabled=false; // Import the genuine Gradle-exported Eclipse model for this stdio host.
    settings.java.import.gradle.wrapper.enabled=false;
    settings.java.import.gradle.offline={enabled:true};
    await lsp.request('initialize',{ processId:process.pid,rootUri:fixture.projectUri,
      workspaceFolders:[{uri:fixture.projectUri,name:'Owned Groovy debug'}],
      capabilities:{workspace:{configuration:true,workspaceFolders:true}},
      initializationOptions:{workspaceFolders:[fixture.projectUri],bundles:[bundle.path],settings} },90000);
    lsp.notify('initialized',{});
    lsp.notify('textDocument/didOpen',{textDocument:{uri:uri(fixture.anchor),languageId:'java',version:1,
      text:await fs.readFile(fixture.anchor,'utf8')}});
    const project=await until(async()=>{
      const result=await collectProjects({request:(name,args)=>command(name,...args),folders:[fixture.projectUri]});
      return result.projects.find(item=>item.tool==='gradle'&&item.languages.includes('groovy')&&!path.relative(item.root,fixture.root));
    },130000);
    const vscode={ Uri:{parse:value=>value}, workspace:{ workspaceFolders:[folder],textDocuments:[document],
      getWorkspaceFolder:()=>folder }, debug:{
      onDidStartDebugSession:event(starts),onDidTerminateDebugSession:event(ends),
      async startDebugging(_folder, config) {
        const record=reviewPackets.get(config[GROOVY_DEBUG_MARKER]);
        assert.ok(record);
        const target=await discovery.resolve(config.__rocketbrainJavaProcessSelection);
        assert.equal(target.pid,record.target.pid);
        const dap=new DapClient(await command('vscode.java.startDebugSession'));
        const session={ id:randomUUID(),type:config.type,configuration:config };
        try {
          await dap.request('initialize',{adapterID:'rocketbrain-java',clientID:'groovy-fixture',linesStartAt1:true,columnsStartAt1:true,pathFormat:'path'});
          const attached=dap.request('attach',{ request:'attach',name:config.name,hostName:target.hostName,port:target.port,
            sourcePaths:config.sourcePaths,rocketbrainGroovySourceLines:record.evidence });
          attached.catch(()=>{});
          await dap.event('initialized',0,20000);
          const source={ path:fixture.source,name:path.basename(fixture.source) };
          const bind=(source,lines)=>dap.request('setBreakpoints',{ source,breakpoints:lines.map(line=>({line})) });
          const alternate={ path:fixture.source.replace('DebugProbe.groovy','Other.groovy'),name:'Other.groovy' };
          unknownLineRefused=(await bind(alternate,[line])).breakpoints[0].verified===false;
          await fs.appendFile(fixture.source,'\n// post-attach drift\n');
          try { staleSourceRefused=(await bind(source,[line])).breakpoints[0].verified===false; }
          finally { await fs.writeFile(fixture.source,sourceText); }
          assert.equal((await bind(source,[line])).breakpoints.length,1);
          await dap.request('setExceptionBreakpoints',{filters:[]});
          await dap.request('configurationDone',{},25000);
          await attached;
          sessions.set(session.id,{ dap,pid:target.pid });
          for(const callback of starts) callback(session);
          return true;
        } catch(error){ await dap.close().catch(()=>{}); throw error; }
      },
      async stopDebugging(session) {
        const record=sessions.get(session.id);
        if (!record) return;
        sessions.delete(session.id);
        try { await record.dap.request('disconnect',{terminateDebuggee:false},3500).catch(()=>{}); }
        finally {
          record.dap.socket.destroy();
          for(const callback of ends)callback(session);
        }
      }
    } };
    const java={ start:async()=>{}, getState:()=>({...runtime,debugBuild:bundle.build}),workbench:{
      getSnapshot:()=>({projects:[project]})
    },debug:{ processes:discovery,verifiedLocalPid:session=>sessions.get(session.id)?.pid,
      registerGroovySourceLines(key,target,evidence) {
        assert.equal(evidence.format,'RocketbrainGroovySourceLines1');
        reviewPackets.set(key,{target,evidence});
        return {dispose:()=>reviewPackets.delete(key)};
      }
    } };
    service=createGroovyApplicationDebugger(vscode,java,{ projects:async()=>[project],
      configuration:()=>({javaHome,gradleHome}),trusted:trust,
      output:{append:chunk=>{logs=(logs+chunk).slice(-16000);},appendLine:line=>{logs=(logs+line+'\n').slice(-16000);} }
    });
    const stale=await guards(service,document,fixture.projectUri);
    editorText=sourceText+'\n// stale selection\n';
    version++;
    await fs.writeFile(fixture.source,editorText);
    await assert.rejects(service.start({id:stale.id,...approval}),/changed after review/u);
    editorText=sourceText;
    version++;
    await fs.writeFile(fixture.source,editorText);
    const live=await service.prepare({document,projectUri:fixture.projectUri});
    const attached=await service.start({id:live.id,...approval});
    assert.equal(attached.verifiedLoopback,true);
    const dap=sessions.get(attached.sessionId).dap;
    const request=dap.request.bind(dap);
    const breakEvent=await dap.event('stopped',0,20000);
    assert.equal(breakEvent.reason,'breakpoint');
    local=await verifyPaused(fixture,request,breakEvent,line);
    const firstCount=dap.events.length;
    await request('next',{threadId:breakEvent.threadId});
    const stepEvent=await dap.event('stopped',firstCount,15000);
    assert.equal(stepEvent.reason,'step');
    stepped=await verifyPaused(fixture,request,stepEvent,line+1);
    await request('continue',{threadId:stepEvent.threadId});
    const after=await resumed(fixture);
    await service.stop();
    await noPort(attached.port);
    await assert.rejects(service.start({id:live.id,...approval}),/one-use/u);
    assert.equal(unknownLineRefused,true);
    assert.equal(staleSourceRefused,true);
    return { ...after, local, stepped, exactSource:true, compiledGroovy:true, realJdtAttach:true,
      importedGradleEclipseModel:true, unknownLineRefused, staleSourceRefused,
      oneUse:true, reviewedInputDriftRejected:true, ownedShutdown:true };
  } catch(error) { if(logs)process.stderr.write(logs+'\n'); throw error; }
  finally {
    try { await service?.stop(); }
    finally {
      await lsp.close();
      const real=await fs.realpath(storagePath), found=await fs.lstat(real,{bigint:true});
      assert.equal(path.relative(parent,path.dirname(real)),'');
      assert.match(path.basename(real),/^rb-groovy-jdt-/u);
      assert.deepEqual([found.dev,found.ino],[storageIdentity.dev,storageIdentity.ino]);
      await fs.rm(real,{recursive:true,maxRetries:10,retryDelay:250});
    }
  }
}

module.exports = { runGroovyApplicationDebugChecks };
if(require.main===module) withOwnedDatabase(()=>ownedFixture(os.tmpdir(),runHeadless)).then(result=>
  console.log(JSON.stringify(result))).catch(error=>{ console.error(error); process.exitCode=1; });
