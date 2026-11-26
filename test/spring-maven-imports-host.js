'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {createHash,randomUUID}=require('node:crypto');
const {pathToFileURL}=require('node:url');
const fixture=require('./helpers/spring-maven-bom-fixture');
const {SpringProjectTools}=require('../src/spring/project-tools');

const sha=content=>createHash('sha256').update(content).digest('hex');
const groupId='fixture.rocketbrain', version='1.0.0';
function localRepository(){
  const folder=process.env.ROCKETBRAIN_MAVEN_BOM_TEST_REPOSITORY;
  assert.ok(path.isAbsolute(folder));
  assert.equal(path.basename(folder),'spring-maven-bom-repository');
  return folder;
}

async function newBom(groupFolder,starter){
  const artifactId='rb-supplemental-'+randomUUID(), artifactRoot=path.resolve(groupFolder,artifactId);
  assert.equal(path.dirname(artifactRoot),groupFolder);
  const file=path.join(artifactRoot,version,artifactId+'-'+version+'.pom');
  const xml=`<project xmlns="http://maven.apache.org/POM/4.0.0"><modelVersion>4.0.0</modelVersion>
  <groupId>${groupId}</groupId><artifactId>${artifactId}</artifactId><version>${version}</version><packaging>pom</packaging>
  <properties><fixture.boot>${fixture.boot}</fixture.boot></properties>
  <dependencyManagement><dependencies><dependency>
    <groupId>org.springframework.boot</groupId><artifactId>${starter}</artifactId><version>\${fixture.boot}</version>
  </dependency></dependencies></dependencyManagement>
</project>`;
  await fs.mkdir(path.dirname(file),{recursive:true});
  await fs.writeFile(file,xml,{flag:'wx'});
  const declaration=`<dependency><groupId>${groupId}</groupId><artifactId>${artifactId}</artifactId>
    <version>${version}</version><type>pom</type><scope>import</scope></dependency>`;
  return {artifactRoot,file,xml,declaration,pin:{groupId,artifactId,version,sha256:sha(xml)}};
}

async function verify(project,config,service,nativeReview){
  const repository=await fs.realpath(localRepository()), groupFolder=path.join(repository,'fixture','rocketbrain');
  const models=[], pom=path.join(project,'pom.xml'), lock=path.join(project,'.rocketbrain-maven-models.json');
  const source=path.join(project,'src/main/java/fixture/bom');
  await fs.mkdir(source,{recursive:true});
  await fs.copyFile(path.join(fixture.root,'test/fixtures/spring-maven-bom/BomProbeApplication.java'),path.join(source,'BomProbeApplication.java'));
  const server=await fixture.serveCatalog();
  try{
    for(const starter of ['spring-boot-starter-webmvc','spring-boot-starter-actuator'])models.push(await newBom(groupFolder,starter));
    const statements=models.map(item=>item.declaration).join('\n');
    const before=fixture.pomFor(config.dbEngine).replace('<dependencyManagement>\n    <dependencies>',
      '<dependencyManagement>\n    <dependencies>\n'+statements);
    await fs.writeFile(pom,before,{flag:'wx'});
    const input={projectUri:pathToFileURL(project).href,endpoint:server.url};
    await assert.rejects(service.inspectDependencies(input),/exact SHA-256 pin/);
    const pins=JSON.stringify({version:1,models:models.map(item=>item.pin)});
    await fs.writeFile(lock,pins,{flag:'wx'});
    const listed=await service.inspectDependencies(input);
    assert.equal(listed.management.supplemental.length,2);
    const actuator=listed.choices.find(item=>item.artifactId==='spring-boot-starter-actuator');
    assert.equal(actuator.selected,true);
    assert.equal(actuator.editable,false);
    assert.equal(actuator.localManagementVersion,fixture.boot);
    await assert.rejects(service.previewDependencies({...input,remove:[actuator.id]}),/management override/);
    const plan={...input,add:['jdbc',config.dbEngine]};
    const stale=await service.previewDependencies(plan);
    await fs.appendFile(models[0].file,'<!-- changed after review -->\n');
    try {
      await assert.rejects(service.apply({reviewId:stale.reviewId,allowWrite:true,allowProjectExecution:true}),
        {code:'ROCKETBRAIN_SPRING_PROJECT_STALE'});
      assert.equal(await fs.readFile(pom,'utf8'),before);
    } finally { await fs.writeFile(models[0].file,models[0].xml); service.discard(stale.reviewId); }
    const review=await service.previewDependencies(plan);
    assert.equal(review.management.supplemental.length,2);
    assert.match(review.after,/spring-boot-starter-jdbc/);
    for(const model of models)assert.ok(review.after.includes(model.declaration));
    if(nativeReview) await nativeReview(review);
    const result=await service.apply({reviewId:review.reviewId,allowWrite:true,allowProjectExecution:true});
    assert.equal(result.state,'applied');
    assert.equal(await fs.readFile(lock,'utf8'),pins);
    for(const model of models)assert.equal(await fs.readFile(model.file,'utf8'),model.xml);
    const build=await fixture.buildRuntime(), driver=fixture.drivers[config.dbEngine];
    const {artifact,archive,dependencies}=await fixture.mavenBuild(project,build);
    assert.ok(dependencies.some(row=>row.artifactId===driver.artifact&&row.version===driver.version));
    assert.ok(dependencies.some(row=>row.artifactId==='spring-boot-starter-actuator'&&row.version===fixture.boot));
    assert.ok(archive.includes('BOOT-INF/lib/'+driver.artifact+'-'+driver.version+'.jar'));
    const probe=await fixture.runProbe(artifact,build,config.dbEngine,await fixture.readDatabase(config));
    assert.deepEqual([probe.boot,probe.people,probe.departments],[fixture.boot,2,1]);
    return {engine:config.dbEngine,version:probe.version,maven:'3.9.11',boot:probe.boot,additionalBoms:2,
      unpinnedBomRefused:true,changedBomRefused:true,pinnedBomsAndLockPreserved:true,managedDependencyProtected:true,
      effectivePomAndBootJar:true,springJdbc:probe.people,nativeUndo:result.nativeUndo};
  }finally{
    await server.close();
    for(const item of models){
      assert.equal(path.dirname(await fs.realpath(item.artifactRoot)),await fs.realpath(groupFolder));
      await fs.rm(item.artifactRoot,{recursive:true,maxRetries:6,retryDelay:100});
    }
  }
}

async function runSpringMavenImportChecks(api,vscode,checks){
  const config=JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG,'utf8'));
  const workspace=vscode.workspace.workspaceFolders[0].uri;
  const project=await fs.mkdtemp(path.join(await fs.realpath(workspace.fsPath),'rb-maven-imports-'));
  const settings=vscode.workspace.getConfiguration('rocketbrain.spring',workspace), scope=vscode.ConfigurationTarget.WorkspaceFolder;
  const key='mavenModelRepository', previous=settings.inspect(key)?.workspaceFolderValue;
  try {
    await settings.update(key,localRepository(),scope);
    const result=await verify(project,config,api.springProjects,async review=>{
      const uri=part=>vscode.Uri.parse('rocketbrain-spring-projects:/'+review.reviewId+'/'+part);
      const summary=await vscode.workspace.openTextDocument(uri('review.md'));
      assert.equal((summary.getText().match(/Supplemental Maven BOM fixture\.rocketbrain:/g)||[]).length,2);
      await vscode.commands.executeCommand('vscode.diff',uri('before'),uri('after'),'Review starters with pinned Maven BOMs');
    });
    assert.equal(result.nativeUndo,true);
    checks.push('Reviewed two pinned supplemental Maven BOMs, refused drift, protected managed dependencies and rebuilt the Spring application against physical JDBC.');
    return result;
  } finally { await settings.update(key,previous,scope); }
}

module.exports={runSpringMavenImportChecks};
if(require.main===module)(async()=>{
  const config=JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG,'utf8'));
  await fs.mkdir(fixture.output,{recursive:true});
  const project=await fs.mkdtemp(path.join(fixture.output,'rb-maven-imports-'));
  const service=new SpringProjectTools({getWorkspaceRoots:()=>[project],getMavenRepository:localRepository,writeBuildFile:async change=>{
    change.guard();
    await fs.writeFile(change.path,change.after);
    return {saved:true};
  }});
  try { console.log(JSON.stringify(await verify(project,config,service))); }
  finally { service.dispose(); }
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
