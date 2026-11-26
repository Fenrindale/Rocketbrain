'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {pathToFileURL,fileURLToPath}=require('node:url');
const {createHash}=require('node:crypto');
const mysql=require('mysql2/promise');
const {registerJakartaWorkbench}=require('../src/java/jakarta-vscode');
const {buildSpec}=require('../src/java/workbench-tasks');
const {execute}=require('../src/java/testing/provision');
const {importedSpring,jdbcReadback}=require('./java-source-analysis-host');

const fixture=path.join(__dirname,'fixtures/java/jakarta-wildfly');
const uri=file=>pathToFileURL(file).href;
const read=async file=>JSON.parse(await fs.readFile(file,'utf8'));
const digest=data=>createHash('sha256').update(data).digest('hex');
const commandIds=['deploy','status','stop'].map(name=>'rocketbrain.jakarta.wildfly.'+name);
const version='42.0.0.Final';

async function ownedDirectory(parent,work) {
  const boundary=await fs.realpath(parent), root=await fs.mkdtemp(path.join(boundary,'rb-wildfly-proof-'));
  const original=await fs.lstat(root,{bigint:true});
  try {return await work(root);}
  finally {
    const verified=await fs.realpath(root), identity=await fs.lstat(verified,{bigint:true});
    assert.equal(path.relative(boundary,path.dirname(verified)),'');
    assert.ok(path.basename(verified).startsWith('rb-wildfly-proof-'));
    assert.equal(path.relative(root,verified),'');
    assert.deepEqual([identity.dev,identity.ino],[original.dev,original.ino]);
    await fs.rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:250});
  }
}

async function withOwnedDatabase(work) {
  const runtime=await read(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG);
  const engine=process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE;
  assert.equal(runtime.dbEngine,engine);
  const ownerDir=path.dirname(await fs.realpath(runtime.dbConfigPath));
  const owner=await read(path.join(ownerDir,'owner.json'));
  const ownerKind={mysql:'RocketbrainDisposableOracleMysqlFixture-v1',
    mariadb:'RocketbrainDisposableMariaDbFixture-v1'}[engine];
  assert.ok(ownerKind);
  assert.deepEqual([owner.kind,owner.id],[ownerKind,path.basename(ownerDir)]);
  const db=await read(runtime.dbConfigPath);
  assert.deepEqual([db.host,db.database,db.user],['127.0.0.1','rocketbrain_fixture','rb_fixture']);
  assert.ok(Number.isInteger(db.port)&&db.port>=1024&&db.port<=65535);
  assert.ok(/^[A-Za-z0-9_-]{32}$/u.test(db.password),'Use the random disposable database password.');
  const connection=await mysql.createConnection(db);
  let databaseVersion;
  try {
    const [[row]]=await connection.query('SELECT @@datadir AS datadir, VERSION() AS version');
    const dataDirectory=await fs.realpath(row.datadir);
    assert.equal(path.relative(ownerDir,path.dirname(dataDirectory)),'');
    databaseVersion=row.version;
  } finally {await connection.end();}
  const jdbc=await jdbcReadback();
  const url='jdbc:'+engine+'://127.0.0.1:'+db.port+'/rocketbrain_fixture?connectTimeout=4000'+
    (engine==='mysql'?'&allowPublicKeyRetrieval=true&sslMode=DISABLED':'');
  return {engine,databaseVersion,jdbc,...await work({url,user:db.user,password:db.password,jdbc})};
}

async function stage(root,{url,user,password}) {
  await fs.cp(fixture,root,{recursive:true,filter:file=>!['target','.project','.classpath','.settings'].includes(path.basename(file))});
  const resources=path.join(root,'src/main/resources');
  await fs.mkdir(resources);
  await fs.writeFile(path.join(resources,'wildfly-owned-database.properties'),
    ['url='+url,'username='+user,'password='+password,''].join('\n'),{flag:'wx',mode:0o600});
  if (process.env.ROCKETBRAIN_JAKARTA_WILDFLY_MAVEN_REPO) {
    const repository=await fs.realpath(process.env.ROCKETBRAIN_JAKARTA_WILDFLY_MAVEN_REPO);
    await fs.mkdir(path.join(root,'.mvn'));
    await fs.writeFile(path.join(root,'.mvn/maven.config'),'-Dmaven.repo.local='+repository+'\n');
  }
  return {root,uri:uri(root),name:'jakarta-wildfly',tool:'maven'};
}

async function distributionState(home) {
  const stock=path.join(home,'standalone');
  const snapshot={};
  for (const relative of ['configuration/standalone.xml','configuration','deployments','log','tmp','data']) {
    const file=path.join(stock,relative);
    try {
      const stat=await fs.lstat(file);
      snapshot[relative]=stat.isDirectory()?(await fs.readdir(file)).sort():digest(await fs.readFile(file));
    } catch (error) {
      if (error.code!=='ENOENT') throw error;
      snapshot[relative]=null;
    }
  }
  return snapshot;
}

async function runtimeBases() {
  const parent=await fs.realpath(os.tmpdir());
  const entries=await fs.readdir(parent,{withFileTypes:true});
  return entries.filter(entry=>entry.isDirectory()&&/^rb-wildfly-[A-Za-z0-9]{6}$/u.test(entry.name))
    .map(entry=>path.join(parent,entry.name));
}

async function exercise(jakarta,project,home,fixture) {
  const service=jakarta.wildfly;
  assert.ok(service);
  assert.deepEqual(service.status(),{state:'stopped'});
  const stock=await distributionState(home);
  const priorBases=new Set(await runtimeBases());
  const built=await jakarta.buildWar({projectUri:project.uri,allowProjectExecution:true});
  assert.equal(built.state,'succeeded');
  assert.equal(built.artifacts.length,1);
  const archive=built.artifacts[0], file=fileURLToPath(archive.uri), bytes=await fs.readFile(file);
  const inputs={projectUri:project.uri,warUri:archive.uri,context:'rb-ejb-inventory'};
  const review=overrides=>service.review({...inputs,...overrides});
  const deploy=(plan,allowDeploy=true)=>service.deploy({reviewId:plan.id,allowDeploy});
  const initial=await review();
  assert.equal(initial.version,version);
  assert.equal(initial.sha256,digest(bytes));
  assert.equal(initial.context,inputs.context);
  await assert.rejects(deploy(initial,false),/Approve the reviewed/u);
  assert.deepEqual(service.status(),{state:'stopped'});

  const changed=Buffer.from(bytes);
  changed[changed.length-1]^=1;
  try {
    await fs.writeFile(file,changed);
    await assert.rejects(deploy(initial),/changed while staging/u);
    await assert.rejects(deploy(initial),/Review the WildFly deployment again/u);
  } finally {await fs.writeFile(file,bytes);}
  assert.deepEqual(service.status(),{state:'stopped'});
  assert.deepEqual((await runtimeBases()).filter(folder=>!priorBases.has(folder)),[]);

  const buildPlan=await review(), pom=path.join(project.root,'pom.xml'), pomBytes=await fs.readFile(pom);
  try {
    await fs.appendFile(pom,'\n');
    await assert.rejects(deploy(buildPlan),/Maven module changed/u);
  } finally {await fs.writeFile(pom,pomBytes);}
  const cancelled=await review();
  await assert.rejects(service.deploy({reviewId:cancelled.id,allowDeploy:true,cancellation:AbortSignal.abort()}),/cancelled/u);

  let active, ownBase;
  try {
    const selected=await review();
    active=await deploy(selected);
    assert.equal(active.state,'running');
    assert.equal(active.version,version);
    assert.equal(active.sha256,selected.sha256);
    assert.match(active.url,/^http:\/\/127\.0\.0\.1:[0-9]{4,5}\/rb-ejb-inventory$/u);
    assert.deepEqual(service.status(),active);
    const bases=(await runtimeBases()).filter(folder=>!priorBases.has(folder));
    assert.equal(bases.length,1);
    [ownBase]=bases;
    const copy=path.join(ownBase,'deployments','rb-ejb-inventory.war');
    assert.equal(digest(await fs.readFile(copy)),active.sha256);
    assert.ok((await fs.lstat(copy+'.deployed')).isFile());
    await assert.rejects(review(),/Stop the active WildFly deployment/u);
    await assert.rejects(deploy(selected),/Review the WildFly deployment again/u);
    const address=active.url+'/ping';
    const result=await fetch(address,{redirect:'error',signal:AbortSignal.timeout(12000)});
    assert.equal(result.status,200);
    const expected=fixture.jdbc;
    assert.equal(await result.text(),'EJB:/rb-ejb-inventory:'+expected.people+':'+expected.departments+':'+expected.rolledBackNames);
    assert.ok(!JSON.stringify([active,selected]).includes(fixture.password));
    assert.deepEqual(await jdbcReadback(),expected);
  } finally {assert.deepEqual(await service.stop(),{state:'stopped'});}
  await assert.rejects(fs.lstat(ownBase),error=>error.code==='ENOENT');
  await assert.rejects(fetch(active.url+'/ping',{redirect:'error',signal:AbortSignal.timeout(1800)}));
  assert.deepEqual(await distributionState(home),stock);
  return {version,pinnedPhysicalRuntime:true,importedMavenWar:true,actualStatelessEjb:true,actualSpringJdbcTemplate:true,
    localHttp:true,retainedDigest:true,staleWarAndPomRefused:true,unapprovedCancelAndReplayRefused:true,
    ownedCleanup:true,selectedStockUnmodified:true,fixtureCredentialAbsentFromReceipt:true};
}

function localWorkbench(root,project,{javaHome,mavenHome,home},logs) {
  const disposable=()=>({dispose(){}});
  const vscode={
    window:{createOutputChannel:()=>({append(value){logs.value=(logs.value+value).slice(-24000);},appendLine(){},dispose(){}})},
    workspace:{isTrusted:true,workspaceFolders:[uri(root)],textDocuments:[],
      getConfiguration:()=>({get:key=>({'jakarta.wildflyHome':home,javaHome})[key]})},
    commands:{registerCommand:disposable},debug:{onDidStartDebugSession:disposable,onDidTerminateDebugSession:disposable}
  };
  return registerJakartaWorkbench(vscode,{getState:()=>({javaHome}),workbench:{
    getSnapshot:()=>({projects:[project]}),
    discoverTasks:async()=>[{id:'package',name:'package'}],
    async runTask(){
      const spec=buildSpec(project,{javaHome,mavenHome},['package']);
      const result=await execute(spec.command,spec.args,{cwd:spec.cwd,env:spec.env,timeoutMs:120000,maxOutputBytes:1024*1024});
      assert.equal(result.code,0,String(result.output).slice(-3000));
      return {state:'succeeded'};
    }
  }});
}

async function runJakartaWildFlyChecks(api,vscode,checks) {
  const workspace=vscode.workspace.workspaceFolders[0].uri.fsPath;
  const home=await fs.realpath(process.env.ROCKETBRAIN_JAKARTA_WILDFLY_TEST_HOME);
  assert.equal(path.relative(home,await fs.realpath(vscode.workspace.getConfiguration('rocketbrain.java').get('jakarta.wildflyHome'))),'');
  const registered=await vscode.commands.getCommands(true);
  assert.ok(commandIds.every(id=>registered.includes(id)));
  await importedSpring(api,workspace);
  return withOwnedDatabase(data=>ownedDirectory(workspace,async root=>{
    const project=await stage(root,data);
    try {
      const result=await api.java.workbench.resyncProject({projectUri:project.uri,allowProjectExecution:true});
      assert.ok(result.projects.some(item=>item.tool==='maven'&&!path.relative(item.root,root)));
      const record=await exercise(api.java.jakarta,project,home,data);
      checks.push('The installed Jakarta workbench ran a reviewed WAR on stock WildFly through real stateless EJB injection and Spring JDBC against the owned database.');
      return {...record,nativeView:true};
    } finally {await api.java.executeWorkspaceCommand('java.project.changeImportedProjects',[],[],[project.uri]);}
  }));
}

async function headless() {
  const {javaHome}=await read(process.env.ROCKETBRAIN_JAVA_TEST_CONFIG);
  const mavenHome=await fs.realpath(process.env.ROCKETBRAIN_MAVEN_HOME);
  const home=await fs.realpath(process.env.ROCKETBRAIN_JAKARTA_WILDFLY_TEST_HOME);
  return withOwnedDatabase(data=>ownedDirectory(os.tmpdir(),async root=>{
    const project=await stage(root,data), logs={value:''};
    const service=localWorkbench(root,project,{javaHome,mavenHome,home},logs);
    try {return {...await exercise(service,project,home,data),nativeView:false};}
    catch (error) {
      const vendor=logs.value.split(/\r?\n/u).filter(line=>/WFLYSRV|WFLYUT|WFLYDS/u.test(line)).slice(-12).join('\n');
      error.message+='\n'+vendor.replaceAll(data.password,'[redacted]').replaceAll(data.user,'[fixture user]');
      throw error;
    } finally {await service.dispose();}
  }));
}

module.exports={runJakartaWildFlyChecks,headless};
if (require.main===module) headless().then(record=>console.log(JSON.stringify(record))).catch(error=>{
  console.error(error.stack);process.exitCode=1;
});
