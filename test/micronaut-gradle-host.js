'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {promisify}=require('node:util');
const {execFile}=require('node:child_process');
const mysql=require('mysql2/promise');
const {BuildTasks}=require('../src/java/workbench-tasks');
const {collectProjects}=require('../src/java/workbench-model');
const {resolveLaunch,serverSettings}=require('../src/java/runtime');
const {registerMicronautWorkbench}=require('../src/java/micronaut-vscode');
const {StdioLsp,until}=require('./helpers/stdio-lsp');
const {jdbcReadback,importedSpring}=require('./java-source-analysis-host');

const run=promisify(execFile);
const read=async file=>JSON.parse(await fs.readFile(file,'utf8'));
const fixture=path.resolve(__dirname,'fixtures/java/micronaut-gradle');
const controller='src/main/java/micronautgradlefixture/FixtureController.java';
const properties='src/main/resources/application.properties';
const fixtures=['build','bin','.gradle','.project','.classpath','.settings'];
const approval={allowProjectExecution:true};

async function withOwnedDatabase(work){
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
  try{
    const [[row]]=await connection.query('SELECT @@datadir AS datadir, VERSION() AS version');
    assert.equal(path.relative(directory,path.dirname(await fs.realpath(row.datadir))),'');
    version=row.version;
    assert.equal(/mariadb/iu.test(version),config.dbEngine==='mariadb');
  }finally{await connection.end();}
  const jdbc=await jdbcReadback();
  assert.deepEqual(jdbc,{people:2,departments:1,rolledBackNames:0});
  const keys={
    RB_MICRONAUT_JDBC_URL:'jdbc:'+config.dbEngine+'://127.0.0.1:'+db.port+'/'+db.database+
      (config.dbEngine==='mysql'?'?allowPublicKeyRetrieval=true&sslMode=DISABLED':''),
    RB_MICRONAUT_JDBC_USER:db.user,RB_MICRONAUT_JDBC_PASSWORD:db.password
  };
  const previous=Object.fromEntries(Object.keys(keys).map(key=>[key,process.env[key]]));
  try{
    Object.assign(process.env,keys);
    return {engine:config.dbEngine,version,jdbc,...await work()};
  }finally{
    for(const [key,value] of Object.entries(previous)){
      if(value===undefined)delete process.env[key];else process.env[key]=value;
    }
  }
}

async function copyUnder(parent,fn){
  parent=await fs.realpath(parent);
  const room=await fs.mkdtemp(path.join(parent,'rb-micronaut-gradle-'));
  const root=path.join(room,'micronaut-gradle');
  const original=await fs.lstat(room,{bigint:true});
  try{
    await fs.cp(fixture,root,{recursive:true,filter:source=>!fixtures.includes(path.basename(source))});
    return await fn(root,room);
  }finally{
    const owned=await fs.realpath(room), stat=await fs.lstat(owned,{bigint:true});
    assert.equal(path.relative(parent,path.dirname(owned)),'');
    assert.match(path.basename(owned),/^rb-micronaut-gradle-/u);
    assert.deepEqual([stat.dev,stat.ino],[original.dev,original.ino]);
    await fs.rm(owned,{recursive:true,force:true,maxRetries:8,retryDelay:250});
  }
}

function verifySource(model){
  assert.deepEqual([model.tool,model.pluginVersion,model.platformVersion,model.mainClass,model.distribution],
    ['gradle','5.0.2','5.2.8','micronautgradlefixture.Application','micronaut-gradle']);
  assert.deepEqual(model.settings.map(item=>[item.key,item.type]),[['fixture.message','String']]);
  assert.deepEqual(model.configured.filter(item=>item.key==='fixture.message').map(item=>item.environment).sort(),['','dev','test']);
  assert.deepEqual(model.routes.map(item=>[item.verb,item.path]),[['GET','/rocketbrain/hello'],['GET','/rocketbrain/jdbc']]);
  assert.equal(model.bindings[0].state,'source-type');
  assert.doesNotMatch(JSON.stringify(model),/gradle-dev|gradle-test/u);
}

async function exercise(service,root,projectUri,{verifyTwoProfiles=true}={}){
  const options={projectUri,...approval};
  verifySource(await service.inspect(options));
  await assert.rejects(service.test({projectUri}),/Explicitly choose Micronaut tests/u);
  await assert.rejects(service.build({projectUri}),/Explicitly choose a Micronaut build/u);
  const tested=await service.test(options);
  assert.deepEqual([tested.state,tested.task],['succeeded',':test']);
  const xml=await fs.readFile(path.join(root,'build/test-results/test/TEST-micronautgradlefixture.FixtureControllerTest.xml'),'utf8');
  assert.match(xml,/<testsuite [^>]*tests="1"/u);
  assert.match(xml,/<testsuite [^>]*failures="0"/u);
  assert.match(xml,/<testsuite [^>]*errors="0"/u);
  const compiled=await fs.readdir(path.join(root,'build/classes/java/main/micronautgradlefixture'));
  assert.ok(compiled.includes('$GreetingConfiguration$Definition.class')&&compiled.includes('$FixtureController$Definition.class'));
  const build=await service.build(options);
  assert.deepEqual([build.state,build.task,build.tool,build.artifact],['succeeded',':installDist','gradle','build/install/micronaut-gradle']);
  const libs=await fs.readdir(path.join(root,build.artifact,'lib'));
  assert.equal(build.libraryCount,libs.length);
  assert.ok(libs.includes('micronaut-core-5.2.25.jar'));
  assert.ok(libs.includes('mysql-connector-j-26.7.0.jar')&&libs.includes('mariadb-java-client-3.5.10.jar'));
  await assert.rejects(service.run({projectUri}),/Explicitly run the Micronaut application/u);
  let sha;
  const profiles=verifyTwoProfiles?['dev','test']:['dev'];
  for(const environment of profiles){
    const started=await service.run({...options,environment});
    assert.deepEqual([started.state,started.kind,started.environment,started.artifact,started.libraryCount],
      ['running','gradle-distribution',environment,build.artifact,build.libraryCount]);
    assert.match(started.baseUrl,/^http:\/\/127\.0\.0\.1:\d+$/u);
    assert.match(started.sha256,/^[a-f0-9]{64}$/u);
    if(sha)assert.equal(started.sha256,sha);
    sha=started.sha256;
    assert.equal(service.getState().runId,started.runId);
    const get=route=>fetch(started.baseUrl+route,{redirect:'error',signal:AbortSignal.timeout(8000)});
    const greeting=await get('/rocketbrain/hello'), jdbc=await get('/rocketbrain/jdbc');
    assert.equal(greeting.status,200);assert.equal(await greeting.text(),'gradle-'+environment);
    assert.equal(jdbc.status,200);assert.equal(await jdbc.text(),'2');
    assert.equal((await service.stop()).state,'stopped');
    await assert.rejects(get('/rocketbrain/hello'));
  }
  return {tests:1,buildTask:build.task,libraryCount:build.libraryCount,ownedShutdown:true,artifactSha256:sha,profiles,
    micronautJdbc:true,drivers:{mysql:'26.7.0',mariadb:'3.5.10'},compileTimeBeans:true,sourceRoutes:true,literalSettings:true};
}

async function headless(){
  const config=await read(process.env.ROCKETBRAIN_JAVA_TEST_CONFIG), out=path.resolve(__dirname,'../test-output');
  const javaHome=await fs.realpath(process.env.ROCKETBRAIN_SPRING_JAVA_HOME||config.javaHome);
  const gradleHome=await fs.realpath(process.env.ROCKETBRAIN_MICRONAUT_GRADLE_HOME);
  const cache=await fs.realpath(process.env.GRADLE_USER_HOME);
  return copyUnder(out,async(root,room)=>{
    const uri=pathToFileURL(root).href, storage=path.join(room,'jdt-storage');
    await fs.mkdir(storage);
    const launch=resolveLaunch({javaHome,serverPath:config.serverPath,storagePath:storage});
    launch.options.env.GRADLE_USER_HOME=cache;
    const lsp=new StdioLsp(launch), executed=[];
    let service, log='';
    try{
      const settings=serverSettings([{name:'JavaSE-25',path:javaHome,default:true}],{gradleHome,gradleJavaHome:javaHome});
      settings.java.import.gradle.wrapper.enabled=false;
      settings.java.import.gradle.offline={enabled:true};
      await lsp.request('initialize',{processId:process.pid,rootUri:uri,workspaceFolders:[{uri,name:'micronaut-gradle'}],
        capabilities:{workspace:{configuration:true,workspaceFolders:true}},initializationOptions:{workspaceFolders:[uri],settings}},90000);
      lsp.notify('initialized',{});
      const source=path.join(root,controller);
      lsp.notify('textDocument/didOpen',{textDocument:{uri:pathToFileURL(source).href,languageId:'java',version:1,text:await fs.readFile(source,'utf8')}});
      const project=await until(async()=>{
        const snapshot=await collectProjects({request:(command,args)=>lsp.request('workspace/executeCommand',{command,arguments:args}),folders:[uri]});
        const found=snapshot.projects.find(item=>!path.relative(item.root,root));
        return found?.sourceRoots.some(item=>!path.relative(item.path,path.join(root,'src/main/java')))&&found;
      },150000);
      assert.equal(project.tool,'gradle');
      assert.ok(project.natures.some(nature=>nature.includes('buildship')));
      const tasks=new BuildTasks({storagePath:storage,tools:()=>({javaHome,gradleHome}),runner:{
        async execute(spec,{timeoutMs}){
          try{
            await run(spec.command,spec.args,{cwd:spec.cwd,env:spec.env,windowsHide:true,timeout:timeoutMs,maxBuffer:1024*1024*8});
            return {code:0};
          }catch(error){
            process.stderr.write(String(error.stderr||error.stdout||error.message).slice(-2500)+'\n');
            return {code:error.code||1};
          }
        }
      }});
      const disposable=()=>({dispose(){}});
      const java={getState:()=>({javaHome}),workbench:{getSnapshot:()=>({projects:[project]}),
        discoverTasks:options=>tasks.discover(project,options),async runTask(options){
          assert.equal(options.projectUri,uri);
          const result=await tasks.run(project,options.taskId,options);
          executed.push(result.task);
          return result;
        }}};
      service=registerMicronautWorkbench({
        workspace:{isTrusted:true,textDocuments:[],workspaceFolders:[{uri:{scheme:'file',toString:()=>uri}}],
          getConfiguration:()=>({get:()=>javaHome})},
        window:{createOutputChannel:()=>({append(value){log=(log+value).slice(-5000);},appendLine(){},dispose(){}})},
        commands:{registerCommand:disposable},languages:{registerCompletionItemProvider:disposable,registerDefinitionProvider:disposable}
      },java);
      const proof=await exercise(service,root,uri);
      assert.deepEqual(executed,[':test',':installDist',':installDist',':installDist']);
      return {platform:'5.2.8',core:'5.2.25',gradlePlugin:'5.0.2',realBuildshipImport:true,executed,nativeView:false,...proof};
    }catch(error){
      if(log)process.stderr.write(log+'\n');
      throw error;
    }finally{
      try{await service?.dispose();}
      finally{await lsp.close();}
    }
  });
}

async function runMicronautGradleChecks(api,vscode,checks){
  const expected=await fs.realpath(process.env.ROCKETBRAIN_MICRONAUT_GRADLE_HOME);
  assert.equal(await fs.realpath(vscode.workspace.getConfiguration('rocketbrain.java').get('gradleHome')),expected);
  const workspace=vscode.workspace.workspaceFolders[0].uri.fsPath;
  await importedSpring(api,workspace);
  const result=await withOwnedDatabase(()=>copyUnder(workspace,async root=>{
    const service=api.java.micronaut, projectUri=vscode.Uri.file(root).toString();
    assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.micronaut.build'));
    try{
      const imported=await api.java.workbench.resyncProject({projectUri,...approval});
      assert.ok(imported.projects.some(project=>project.tool==='gradle'&&!path.relative(project.root,root)));
      const document=await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root,properties)));
      const at=document.positionAt(document.getText().indexOf('fixture.message')+11);
      const completion=await vscode.commands.executeCommand('vscode.executeCompletionItemProvider',document.uri,at);
      assert.ok(completion.items.some(item=>item.label==='fixture.message'&&item.detail==='Micronaut · String'));
      const definitions=await vscode.commands.executeCommand('vscode.executeDefinitionProvider',document.uri,at);
      assert.ok(definitions.some(location=>path.basename((location.uri||location.targetUri).fsPath)==='GreetingConfiguration.java'));
      return {...await exercise(service,root,projectUri,{verifyTwoProfiles:false}),nativeView:true,configurationNavigation:true};
    }finally{
      await service.stop();
      await api.java.executeWorkspaceCommand('java.project.changeImportedProjects',[],[],[projectUri]).catch(()=>{});
    }
  }));
  checks.push('Micronaut Gradle used the installed Java project import, completed and navigated a setting, ran a real HTTP test, built its distribution, and stopped the owned JVM after a real JDBC read.');
  return result;
}

module.exports={runMicronautGradleChecks};
if(require.main===module)withOwnedDatabase(headless).then(value=>console.log(JSON.stringify(value))).catch(error=>{
  console.error(error.stack);process.exitCode=1;
});
