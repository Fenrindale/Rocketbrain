'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {pathToFileURL}=require('node:url');
const {createHash}=require('node:crypto');
const {registerJakartaWorkbench}=require('../src/java/jakarta-vscode');
const {listEarArtifacts}=require('../src/java/jakarta-war');
const {buildSpec}=require('../src/java/workbench-tasks');
const {execute}=require('../src/java/testing/provision');
const {importedSpring,jdbcReadback}=require('./java-source-analysis-host');
const {withOwnedDatabase,ownedDirectory,distributionState,runtimeBases}=require('./jakarta-wildfly-host');

const fixtures=path.resolve(__dirname,'fixtures/java/jakarta-ear');
const uri=file=>pathToFileURL(file).href;
const command='rocketbrain.jakarta.wildfly.deployEar';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');

async function stage(root,fixture) {
  await fs.cp(fixtures,root,{recursive:true,filter:file=>!['target','.project','.classpath','.settings','.mvn'].includes(path.basename(file))});
  const resources=path.join(root,'beans/src/main/resources');
  await fs.mkdir(resources);
  await fs.writeFile(path.join(resources,'wildfly-owned-database.properties'),[
    'url='+fixture.url,'username='+fixture.user,'password='+fixture.password,''
  ].join('\n'),{flag:'wx',mode:0o600});
  if(process.env.ROCKETBRAIN_JAKARTA_WILDFLY_EAR_MAVEN_REPO){
    const repository=await fs.realpath(process.env.ROCKETBRAIN_JAKARTA_WILDFLY_EAR_MAVEN_REPO);
    await fs.mkdir(path.join(root,'.mvn'));
    await fs.writeFile(path.join(root,'.mvn/maven.config'),'-Dmaven.repo.local='+repository+'\n');
  }
  const projects=['','contract','beans','web','application'].map(name=>{
    const folder=path.join(root,name);
    return {root:folder,uri:uri(folder),tool:'maven',name:name||'wildfly-ear-reactor'};
  });
  return {root,projects,reactor:projects[0],application:projects.at(-1)};
}

async function packageEar(workbench,reactor) {
  const input={projectUri:reactor.uri,allowProjectExecution:true};
  const task=(await workbench.discoverTasks(input)).find(row=>row.name==='package');
  assert.ok(task);
  const built=await workbench.runTask({...input,taskId:task.id});
  assert.equal(built.state,'succeeded');
}

async function exercise(jakarta,project,home,fixture) {
  const service=jakarta.wildfly, [archive]=listEarArtifacts(project);
  assert.ok(archive);
  assert.equal(listEarArtifacts(project).length,1);
  assert.deepEqual(service.status(),{state:'stopped'});
  const stock=await distributionState(home), before=new Set(await runtimeBases());
  const selection={projectUri:project.uri,earUri:archive.uri};
  await assert.rejects(service.reviewEar({...selection,context:'a-different-context'}),/context in its packaged application.xml/u);
  await assert.rejects(service.review({projectUri:project.uri,warUri:archive.uri}),/Import the Maven WAR/u);
  const bytes=await fs.readFile(archive.file);
  const plan=await service.reviewEar(selection);
  const original=structuredClone(plan.ear);
  assert.equal(plan.kind,'ear');
  assert.equal(plan.sha256,hash(bytes));
  assert.equal(plan.context,'rb-enterprise');
  assert.notEqual(plan.artifact.replace(/\.ear$/u,''),plan.context);
  assert.deepEqual([original.descriptorVersion,original.web.name,original.ejb.name],['11','inventory-web.war','inventory-beans.jar']);
  assert.ok(original.libraries.includes('lib/rocketbrain.fixture-wildfly-ear-contract-1.0.0.jar')||
    original.libraries.includes('lib/wildfly-ear-contract-1.0.0.jar'));
  for(const module of [original.web,original.ejb]){
    assert.ok(module.bytes>0);
    assert.match(module.sha256,/^[a-f0-9]{64}$/u);
  }
  const deploy=(review,allowDeploy=true)=>service.deploy({reviewId:review.id,allowDeploy});
  await assert.rejects(deploy(plan,false),/Approve the reviewed/u);
  const varied=Buffer.from(bytes);
  varied[varied.length-1]^=1;
  try{
    await fs.writeFile(archive.file,varied);
    await assert.rejects(deploy(plan),/EAR artifact changed while staging/u);
    await assert.rejects(deploy(plan),/Review the WildFly deployment again/u);
  }finally{await fs.writeFile(archive.file,bytes);}
  assert.deepEqual(service.status(),{state:'stopped'});
  assert.deepEqual((await runtimeBases()).filter(folder=>!before.has(folder)),[]);

  let started, base;
  try{
    const reviewed=await service.reviewEar(selection);
    reviewed.ear.web.name='changed-caller-copy.war';
    started=await deploy(reviewed);
    assert.equal(started.state,'running');
    assert.equal(started.kind,'ear');
    assert.equal(started.sha256,hash(bytes));
    assert.equal(started.artifact,archive.name);
    assert.deepEqual(started.ear,original);
    assert.deepEqual(service.status(),started);
    assert.match(started.url,/^http:\/\/127\.0\.0\.1:[0-9]{4,5}\/rb-enterprise$/u);
    const bases=(await runtimeBases()).filter(folder=>!before.has(folder));
    assert.equal(bases.length,1);
    [base]=bases;
    const staged=path.join(base,'deployments',archive.name);
    assert.equal(hash(await fs.readFile(staged)),started.sha256);
    assert.ok((await fs.lstat(staged+'.deployed')).isFile());
    await assert.rejects(service.reviewEar(selection),/Stop the active/u);
    const app=await fetch(started.url+'/ping',{redirect:'error',signal:AbortSignal.timeout(12000)});
    assert.equal(app.status,200);
    const {people,departments,rolledBackNames}=fixture.jdbc;
    assert.equal(await app.text(),['EAR','/rb-enterprise',people,departments,rolledBackNames,true,true].join(':'));
    assert.deepEqual(await jdbcReadback(),fixture.jdbc);
    assert.ok(!JSON.stringify([started,reviewed]).includes(fixture.password));
  }finally{assert.deepEqual(await service.stop(),{state:'stopped'});}
  await assert.rejects(fs.lstat(base),error=>error.code==='ENOENT');
  await assert.rejects(fetch(started.url+'/ping',{signal:AbortSignal.timeout(1500),redirect:'error'}));
  assert.deepEqual(await distributionState(home),stock);
  return {version:started.version,descriptorContext:true,explicitModulePair:true,commonContractLib:true,
    actualCrossModuleEjb:true,actualSpringJdbcTemplate:true,webAndEjbDistinctFromContractClassLoader:true,
    originalEarNameAndDigest:true,oneShotReviewedStagedArchive:true,contextOverrideRejected:true,reviewSnapshotIndependent:true,
    ownedCleanup:true,selectedStockUnmodified:true,fixtureCredentialAbsentFromReceipt:true,
    modules:[original.web.name,original.ejb.name],libraries:original.libraries.length};
}

function localWorkbench(staged,{javaHome,mavenHome,home},log) {
  const disposable=()=>({dispose(){}});
  const vscode={
    window:{createOutputChannel:()=>({append(chunk){log.value=(log.value+chunk).slice(-24000);},appendLine(){},dispose(){}})},
    workspace:{isTrusted:true,workspaceFolders:[uri(staged.root)],textDocuments:[],
      getConfiguration:()=>({get:key=>({'jakarta.wildflyHome':home,javaHome})[key]})},
    commands:{registerCommand:disposable},debug:{onDidStartDebugSession:disposable,onDidTerminateDebugSession:disposable}
  };
  const workbench={
    getSnapshot:()=>({projects:staged.projects}),
    discoverTasks:async()=>[{id:'package',name:'package'}],
    async runTask({projectUri}){
      assert.equal(projectUri,staged.reactor.uri);
      const spec=buildSpec(staged.reactor,{javaHome,mavenHome},['package']);
      const result=await execute(spec.command,spec.args,{cwd:spec.cwd,env:spec.env,timeoutMs:160000,maxOutputBytes:1024*1024});
      assert.equal(result.code,0,String(result.output).slice(-3000));
      return {state:'succeeded'};
    }
  };
  return {workbench,jakarta:registerJakartaWorkbench(vscode,{getState:()=>({javaHome}),workbench})};
}

async function runJakartaWildFlyEarChecks(api,vscode,checks) {
  const workspace=vscode.workspace.workspaceFolders[0].uri.fsPath;
  const home=await fs.realpath(process.env.ROCKETBRAIN_JAKARTA_WILDFLY_TEST_HOME);
  assert.equal(path.relative(home,await fs.realpath(vscode.workspace.getConfiguration('rocketbrain.java').get('jakarta.wildflyHome'))),'');
  assert.ok((await vscode.commands.getCommands(true)).includes(command));
  await importedSpring(api,workspace);
  return withOwnedDatabase(fixture=>ownedDirectory(workspace,async root=>{
    const staged=await stage(root,fixture);
    const java=api.java;
    try{
      const options={projectUri:staged.reactor.uri,allowProjectExecution:true};
      const imported=await java.workbench.resyncProject(options);
      assert.ok(imported.projects.some(row=>row.tool==='maven'&&!path.relative(row.root,staged.application.root)));
      await packageEar(java.workbench,staged.reactor);
      const proof=await exercise(java.jakarta,staged.application,home,fixture);
      checks.push('Reviewed and deployed a Maven EAR with separately loaded WAR, EJB and contract modules. An injected stateless bean returned actual Spring JDBC rows.');
      return {...proof,nativeView:true};
    }finally{
      await java.executeWorkspaceCommand('java.project.changeImportedProjects',[],[],
        staged.projects.map(project=>project.uri).reverse());
    }
  }));
}

async function headless() {
  const java=JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_JAVA_TEST_CONFIG,'utf8'));
  const mavenHome=await fs.realpath(process.env.ROCKETBRAIN_MAVEN_HOME);
  const home=await fs.realpath(process.env.ROCKETBRAIN_JAKARTA_WILDFLY_TEST_HOME);
  return withOwnedDatabase(fixture=>ownedDirectory(os.tmpdir(),async root=>{
    const staged=await stage(root,fixture), log={value:''};
    const service=localWorkbench(staged,{javaHome:java.javaHome,mavenHome,home},log);
    try{
      await packageEar(service.workbench,staged.reactor);
      return {...await exercise(service.jakarta,staged.application,home,fixture),nativeView:false};
    }catch(error){
      const bounded=log.value.split(/\r?\n/u).filter(line=>/\b(?:WFLY|MSC)[A-Z0-9]+:/u.test(line)).slice(-15).join('\n');
      error.message+='\n'+bounded.replaceAll(fixture.password,'[redacted]').replaceAll(fixture.user,'[fixture user]');
      throw error;
    }finally{await service.jakarta.dispose();}
  }));
}

module.exports={runJakartaWildFlyEarChecks};
if(require.main===module)headless().then(record=>console.log(JSON.stringify(record))).catch(error=>{
  console.error(error.stack);process.exitCode=1;
});
