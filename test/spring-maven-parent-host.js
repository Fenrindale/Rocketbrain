'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const B=require('./helpers/spring-maven-bom-fixture');
const {SpringProjectTools}=require('../src/spring/project-tools');

const uri=file=>pathToFileURL(file).href;
const descriptor='<?xml version="1.0" encoding="UTF-8"?>\n<project xmlns="http://maven.apache.org/POM/4.0.0">\n  <modelVersion>4.0.0</modelVersion>\n';
const coordinates=(name,relative)=>['  <parent>','    <groupId>fixture.bom</groupId>',
  '    <artifactId>'+name+'</artifactId>','    <version>1.0.0</version>',
  ...(relative?['    <relativePath>'+relative+'</relativePath>']:[]),'  </parent>\n'].join('\n');
const plugins='  <artifactId>rocketbrain-maven-bom-fixture</artifactId>\n';
const actuator='  <dependencies>\n    <dependency>\n      <groupId>org.springframework.boot</groupId>\n'+
  '      <artifactId>spring-boot-starter-actuator</artifactId>\n    </dependency>\n  </dependencies>\n';

function ancestorInputs(engine){
  const grand=B.pomFor(engine).replace(plugins,
    '  <artifactId>rocketbrain-company-platform</artifactId>\n  <packaging>pom</packaging>\n')
    .replace(/    <dependency>\r?\n      <groupId>org.springframework.boot<\/groupId>\r?\n      <artifactId>spring-boot-starter-actuator<\/artifactId>\r?\n    <\/dependency>\r?\n/,'');
  assert.ok(grand.includes('<packaging>pom</packaging>') && !grand.includes('spring-boot-starter-actuator'));
  const layer=descriptor+coordinates('rocketbrain-company-platform')+
    '  <artifactId>rocketbrain-app-layer</artifactId>\n  <packaging>pom</packaging>\n</project>\n';
  const leaf=descriptor+coordinates('rocketbrain-app-layer','../pom.xml')+plugins+actuator+'</project>\n';
  return {grand,layer,leaf};
}

async function verify(root,config,service,nativeReview){
  const model=ancestorInputs(config.dbEngine);
  const project=path.join(root,'layer','service');
  const source=path.join(project,'src/main/java/fixture/bom');
  const grand=path.join(root,'pom.xml'),layer=path.join(root,'layer','pom.xml'),leaf=path.join(project,'pom.xml');
  await fs.mkdir(source,{recursive:true});
  await fs.writeFile(grand,model.grand,{flag:'wx'});
  await fs.writeFile(layer,model.layer,{flag:'wx'});
  await fs.writeFile(leaf,model.leaf,{flag:'wx'});
  await fs.copyFile(path.join(B.root,'test/fixtures/spring-maven-bom/BomProbeApplication.java'),
    path.join(source,'BomProbeApplication.java'));
  const server=await B.serveCatalog();
  try{
    const input={projectUri:uri(project),endpoint:server.url};
    const read=await service.inspectDependencies(input);
    assert.equal(read.management.kind,'inherited-boot-bom');
    assert.equal(read.bootVersion,B.boot);
    assert.deepEqual(read.management.chain.map(row=>row.coordinate),[
      'fixture.bom:rocketbrain-app-layer:1.0.0','fixture.bom:rocketbrain-company-platform:1.0.0'
    ]);
    assert.deepEqual(read.sources.map(row=>row.name),['../pom.xml','../../pom.xml']);
    const web=read.choices.find(dep=>dep.artifactId==='spring-boot-starter-webmvc');
    assert.equal(web.inherited,true);
    assert.equal(web.selected,true);
    assert.equal(web.editable,false);
    await assert.rejects(service.previewDependencies({...input,remove:[web.id]}),/unversioned ordinary direct declaration/);
    const change={...input,add:['jdbc',config.dbEngine],remove:['actuator']};
    const stale=await service.previewDependencies(change);
    await fs.appendFile(grand,'<!-- changed parent after review -->\n');
    try {
      await assert.rejects(service.apply({reviewId:stale.reviewId,allowWrite:true,allowProjectExecution:true}),
        {code:'ROCKETBRAIN_SPRING_PROJECT_STALE'});
      assert.equal(await fs.readFile(leaf,'utf8'),model.leaf);
    } finally { await fs.writeFile(grand,model.grand); service.discard(stale.reviewId); }
    const reviewed=await service.previewDependencies(change);
    if(nativeReview) await nativeReview(reviewed);
    const result=await service.apply({reviewId:reviewed.reviewId,allowWrite:true,allowProjectExecution:true});
    assert.equal(result.state,'applied');
    assert.equal(result.explicitBuildStarted,false);
    assert.equal(await fs.readFile(grand,'utf8'),model.grand);
    assert.equal(await fs.readFile(layer,'utf8'),model.layer);
    assert.equal(await fs.readFile(leaf,'utf8'),reviewed.after);
    assert.match(reviewed.after,/spring-boot-starter-jdbc/);
    assert.doesNotMatch(reviewed.after,/spring-boot-starter-webmvc|spring-boot-starter-actuator/);
    assert.match(reviewed.after,new RegExp(B.drivers[config.dbEngine].artifact));
    const build=await B.buildRuntime(),db=await B.readDatabase(config);
    const {artifact,archive,dependencies}=await B.mavenBuild(project,build);
    const selected=B.drivers[config.dbEngine];
    assert.ok(dependencies.some(dep=>dep.artifactId===selected.artifact && dep.version===selected.version));
    assert.ok(dependencies.some(dep=>dep.artifactId==='spring-boot-starter-webmvc' && dep.version===B.boot));
    assert.ok(!dependencies.some(dep=>dep.artifactId==='spring-boot-starter-actuator'));
    assert.ok(archive.includes('BOOT-INF/lib/'+selected.artifact+'-'+selected.version+'.jar'));
    const probe=await B.runProbe(artifact,build,config.dbEngine,db);
    assert.equal(probe.boot,B.boot);
    assert.deepEqual([probe.people,probe.departments],[2,1]);
    return {engine:config.dbEngine,maven:'3.9.11',boot:probe.boot,driver:selected.artifact,
      version:probe.version,parents:2,inheritedDependencyProtected:true,staleParentRefused:true,parentBytesUnchanged:true,
      effectivePomAndBootJar:true,nativeUndo:result.nativeUndo,springJdbc:2};
  }finally{await server.close();}
}

async function runSpringMavenParentChecks(api,vscode,checks){
  const config=JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG,'utf8'));
  const workspace=await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
  const root=await fs.mkdtemp(path.join(workspace,'rb-maven-parent-'));
  const result=await verify(root,config,api.springProjects,async review=>{
    const related=vscode.Uri.parse('rocketbrain-spring-projects:/'+review.reviewId+'/review.md');
    const document=await vscode.workspace.openTextDocument(related);
    assert.match(document.getText(),/Inherited Maven BOM import/);
    assert.match(document.getText(),/Local parent fixture\.bom:rocketbrain-company-platform/);
    await vscode.commands.executeCommand('vscode.diff',vscode.Uri.parse('rocketbrain-spring-projects:/'+review.reviewId+'/before'),
      vscode.Uri.parse('rocketbrain-spring-projects:/'+review.reviewId+'/after'),'Review inherited Spring starter edits');
  });
  assert.equal(result.nativeUndo,true);
  checks.push('Reviewed starter edits in a Maven child, preserved the two physical parents, refused drift, and verified the effective POM, packaged Spring app and JDBC connection.');
  return result;
}

module.exports={runSpringMavenParentChecks,ancestorInputs};
if(require.main===module)(async()=>{
  const config=JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG,'utf8'));
  await fs.mkdir(B.output,{recursive:true});
  const root=await fs.mkdtemp(path.join(B.output,'rb-maven-parent-'));
  const service=new SpringProjectTools({getWorkspaceRoots:()=>[root],writeBuildFile:async change=>{
    change.guard();
    await fs.writeFile(change.path,change.after);
    return {saved:true};
  }});
  try{console.log(JSON.stringify(await verify(root,config,service)));}
  finally{service.dispose();}
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
