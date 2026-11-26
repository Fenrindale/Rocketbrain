'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const fixture=require('./helpers/spring-maven-bom-fixture');
const {SpringProjectTools}=require('../src/spring/project-tools');
const {inspect}=require('../src/spring/project-build');

const selected='spring-jdbc', other='health-check';
const starter=artifact=>`<dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-${artifact}</artifactId></dependency>`;
const actuator=/    <dependency>\n      <groupId>org.springframework.boot<\/groupId>\n      <artifactId>spring-boot-starter-actuator<\/artifactId>\n    <\/dependency>\n/;
function withProfiles(engine){
  return fixture.pomFor(engine).replace(actuator,'').replace('</project>',`  <profiles>
    <profile><id>${selected}</id><dependencies/></profile>
    <profile><id>${other}</id><dependencies>${starter('actuator')}</dependencies></profile>
  </profiles>
</project>`);
}

async function verify(project,config,service,nativeReview){
  const source=path.join(project,'src/main/java/fixture/bom'),pom=path.join(project,'pom.xml');
  await fs.mkdir(source,{recursive:true});
  await fs.copyFile(path.join(fixture.root,'test/fixtures/spring-maven-bom/BomProbeApplication.java'),path.join(source,'BomProbeApplication.java'));
  const before=withProfiles(config.dbEngine);
  await fs.writeFile(pom,before,{flag:'wx'});
  const catalog=await fixture.serveCatalog();
  try {
    const input={projectUri:pathToFileURL(project).href,endpoint:catalog.url};
    const initial=await service.inspectDependencies(input);
    assert.deepEqual(initial.mavenProfiles,[selected,other]);
    assert.equal(initial.mavenProfile,undefined);
    await assert.rejects(service.inspectDependencies({...input,mavenProfile:'unknown'}),/explicit Maven profile/);
    const scope={...input,mavenProfile:selected,expectedSourceSha256:initial.sourceSha256};
    const selectedModel=await service.inspectDependencies(scope);
    assert.equal(selectedModel.choices.find(row=>row.id==='actuator').editable,false);
    assert.equal(selectedModel.choices.find(row=>row.id==='web').editable,false);
    await assert.rejects(service.previewDependencies({...scope,remove:['actuator']}),/unversioned ordinary direct declaration/);
    assert.throws(()=>inspect(before.replace('<id>spring-jdbc</id>','<id>spring-jdbc</id><activation><activeByDefault>true</activeByDefault></activation>'),
      'pom.xml',{mavenProfile:selected}),/literal Maven profiles/);
    const changes={...scope,add:['jdbc',config.dbEngine]};
    await fs.appendFile(pom,'<!-- changed while selecting -->\n');
    try { await assert.rejects(service.previewDependencies(changes),{code:'ROCKETBRAIN_SPRING_PROJECT_STALE'}); }
    finally { await fs.writeFile(pom,before); }
    const review=await service.previewDependencies(changes);
    assert.equal(review.mavenProfile,selected);
    const selectedBlock=review.after.match(/<profile><id>spring-jdbc<\/id><dependencies>([\s\S]+?)<\/dependencies><\/profile>/)[1];
    const driver=fixture.drivers[config.dbEngine];
    assert.match(selectedBlock,/spring-boot-starter-jdbc/);
    assert.ok(selectedBlock.includes(driver.artifact));
    assert.equal(review.after.replace(selectedBlock,'').replace('<id>spring-jdbc</id><dependencies></dependencies>',
      '<id>spring-jdbc</id><dependencies/>'),before);
    if(nativeReview) await nativeReview(review);
    const result=await service.apply({reviewId:review.reviewId,allowWrite:true,allowProjectExecution:true});
    assert.equal(result.state,'applied');
    assert.equal(await fs.readFile(pom,'utf8'),review.after);
    const runtime=await fixture.buildRuntime();
    const {artifact,archive,dependencies}=await fixture.mavenBuild(project,runtime,{profile:selected});
    assert.ok(dependencies.some(row=>row.artifactId===driver.artifact&&row.version===driver.version));
    assert.ok(dependencies.some(row=>row.artifactId==='spring-boot-starter-jdbc'&&row.version===fixture.boot));
    assert.ok(!dependencies.some(row=>row.artifactId==='spring-boot-starter-actuator'));
    assert.ok(archive.includes('BOOT-INF/lib/'+driver.artifact+'-'+driver.version+'.jar'));
    const probe=await fixture.runProbe(artifact,runtime,config.dbEngine,await fixture.readDatabase(config));
    assert.deepEqual([probe.boot,probe.people,probe.departments],[fixture.boot,2,1]);
    return {engine:config.dbEngine,version:probe.version,boot:probe.boot,maven:'3.9.11',explicitProfile:selected,
      otherProfileAndRootPreserved:true,activeEffectivePomAndBootJar:true,unknownAndImplicitActivationRefused:true,
      staleSelectionRefused:true,protectedNeighborRefused:true,springJdbc:probe.people,nativeUndo:result.nativeUndo};
  } finally { await catalog.close(); }
}

async function runSpringMavenProfileChecks(api,vscode,checks){
  const config=JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG,'utf8'));
  const workspace=await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
  const project=await fs.mkdtemp(path.join(workspace,'rb-maven-profile-'));
  const result=await verify(project,config,api.springProjects,async review=>{
    const uri=part=>vscode.Uri.parse('rocketbrain-spring-projects:/'+review.reviewId+'/'+part);
    assert.match((await vscode.workspace.openTextDocument(uri('review.md'))).getText(),/Maven profile spring-jdbc/);
    await vscode.commands.executeCommand('vscode.diff',uri('before'),uri('after'),'Review Maven profile starter edits');
  });
  assert.equal(result.nativeUndo,true);
  checks.push('The installed starter editor edited the explicit Maven profile, preserved the other POM content and confirmed the selected effective model with Spring JDBC.');
  return result;
}

module.exports={runSpringMavenProfileChecks,withProfiles};
if(require.main===module)(async()=>{
  const config=JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG,'utf8'));
  await fs.mkdir(fixture.output,{recursive:true});
  const project=await fs.mkdtemp(path.join(fixture.output,'rb-maven-profile-'));
  const service=new SpringProjectTools({getWorkspaceRoots:()=>[project],writeBuildFile:async change=>{
    change.guard();
    await fs.writeFile(change.path,change.after);
    return {saved:true};
  }});
  try { console.log(JSON.stringify(await verify(project,config,service))); }
  finally { service.dispose(); }
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
