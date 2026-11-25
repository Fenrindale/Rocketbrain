'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {SpringProjectTools}=require('../src/spring/project-tools');
const {sha}=require('../src/spring/project-client');
const {temporary}=require('./helpers/spring-project-tools-fixture');
const F=require('./helpers/spring-maven-bom-fixture');

const denied=code=>error=>error.code==='ROCKETBRAIN_SPRING_PROJECT_'+code;

async function verify(service,config,onReview,onApplied){
  const db=await F.readDatabase(config), runtime=await F.buildRuntime();
  const engine=config.dbEngine, driver=F.drivers[engine], other=engine==='mysql'?'mariadb':'mysql', opposite=F.drivers[other];
  await fs.mkdir(F.output,{recursive:true});
  const fixture=temporary();
  let catalog;
  try{
    const project=path.join(fixture.root,'bom-fixture'), source=path.join(project,'src','main','java','fixture','bom');
    await fs.mkdir(source,{recursive:true});
    await fs.copyFile(path.join(F.root,'test','fixtures','spring-maven-bom','BomProbeApplication.java'),path.join(source,'BomProbeApplication.java'));
    const pom=path.join(project,'pom.xml'), original=F.pomFor(engine), projectUri=pathToFileURL(project).href;
    await fs.writeFile(pom,original,{flag:'wx'});
    catalog=await F.serveCatalog();
    const input={projectUri,endpoint:catalog.url}, request={...input,add:['jdbc',engine],remove:['actuator']};
    const state=await service.inspectDependencies(input);
    assert.equal(state.bootVersion,F.boot);
    assert.equal(state.management.kind,'boot-bom-import');
    assert.equal(state.management.coordinate,'org.springframework.boot:spring-boot-dependencies');
    assert.equal(state.management.property,engine==='mysql'?'spring-boot.version':null);
    assert.equal(state.management.expression,engine==='mysql'?'${spring-boot.version}':F.boot);
    assert.deepEqual(state.management.overrides,[{coordinate:opposite.group+':'+opposite.artifact,version:opposite.version}]);
    const protectedDriver=state.choices.find(item=>item.id===other);
    assert.equal(protectedDriver.editable,false);
    assert.equal(protectedDriver.localManagementVersion,opposite.version);
    assert.equal(state.choices.find(item=>item.id===engine).editable,true);
    await assert.rejects(service.previewDependencies({...input,add:[other]}),denied('DEPENDENCY'));

    const stale=await service.previewDependencies(request);
    await fs.appendFile(pom,'\n<!-- external edit -->\n');
    await assert.rejects(service.apply({reviewId:stale.reviewId,allowWrite:true,allowProjectExecution:true}),denied('STALE'));
    await fs.writeFile(pom,original);
    service.discard(stale.reviewId);
    const reviewed=await service.previewDependencies(request);
    assert.equal(reviewed.before,original);
    assert.deepEqual(reviewed.management,state.management);
    assert.equal(reviewed.automaticBuildStartedByTool,false);
    for(const markup of ['properties','dependencyManagement','build']){
      const pattern=new RegExp('<'+markup+'>[\\s\\S]*?<\\/'+markup+'>');
      assert.equal(pattern.exec(reviewed.after)[0],pattern.exec(original)[0]);
    }
    assert.doesNotMatch(reviewed.after,/spring-boot-starter-actuator/);
    assert.match(reviewed.after,/spring-boot-starter-jdbc/);
    assert.equal(await fs.readFile(pom,'utf8'),original);
    await assert.rejects(fs.access(path.join(project,'target')));
    assert.ok(catalog.requests.filter(item=>item.path==='/dependencies').every(item=>item.bootVersion===F.boot));
    if(onReview)await onReview(reviewed);

    const expected=reviewed.afterSha256, after=reviewed.after;
    reviewed.after=original;
    await assert.rejects(service.apply({reviewId:reviewed.reviewId,allowWrite:false,allowProjectExecution:true}),denied('APPROVAL'));
    const applied=await service.apply({reviewId:reviewed.reviewId,allowWrite:true,allowProjectExecution:reviewed.requiresProjectExecutionApproval});
    assert.equal(applied.state,'applied');
    assert.equal(applied.explicitBuildStarted,false);
    assert.equal(sha(await fs.readFile(pom)),expected);
    await assert.rejects(fs.access(path.join(project,'target')));
    if(onApplied)await onApplied(pom,original,after);
    assert.equal(sha(await fs.readFile(pom)),expected);
    const saved=await service.inspectDependencies(input);
    assert.deepEqual(saved.management,state.management);
    assert.equal(saved.choices.find(item=>item.id===engine).selected,true);
    assert.equal(saved.choices.find(item=>item.id==='actuator').selected,false);

    const built=await F.mavenBuild(project,runtime);
    const effective=built.dependencies.find(item=>item.groupId===driver.group&&item.artifactId===driver.artifact);
    const jdbc=built.dependencies.find(item=>item.artifactId==='spring-boot-starter-jdbc');
    assert.equal(effective?.version,driver.version);
    assert.equal(effective.scope,'runtime');
    assert.equal(jdbc?.version,F.boot);
    assert.equal(built.dependencies.some(item=>item.artifactId==='spring-boot-starter-actuator'||item.artifactId===opposite.artifact),false);
    assert.ok(built.archive.includes('BOOT-INF/lib/'+driver.artifact+'-'+driver.version+'.jar'));
    assert.ok(built.archive.includes('BOOT-INF/lib/spring-boot-jdbc-'+F.boot+'.jar'));
    assert.equal(built.archive.some(item=>item.includes(opposite.artifact)||item.includes('spring-boot-actuator')),false);
    const observed=await F.runProbe(built.artifact,runtime,engine,db);
    assert.equal(observed.boot,F.boot);
    assert.equal(/mariadb/i.test(observed.version),engine==='mariadb');
    assert.equal(observed.people,2);
    assert.equal(observed.departments,1);
    return {engine,bootVersion:observed.boot,serverVersion:observed.version,source:state.management.property?'local-property':'literal',
      effectiveDriver:driver.artifact,effectiveVersion:effective.version,actuatorRemoved:true,overridePreserved:true,overriddenDriverProtected:true,
      exactDiffAndSavedBytes:true,staleGuard:true,explicitBuildOnly:true,mavenEffectivePom:true,bootJarExecuted:true,databaseRead:true,
      nativeUndo:applied.nativeUndo};
  }finally{await catalog?.close();fixture.close();}
}

async function runSpringMavenBomChecks(api,vscode,checks){
  const config=JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG,'utf8'));
  const report=await verify(api.springProjects,config,async review=>{
    const uri=kind=>vscode.Uri.parse('rocketbrain-spring-projects:/'+review.reviewId+'/'+kind);
    const doc=await vscode.workspace.openTextDocument(uri('review.md'));
    const before=await vscode.workspace.openTextDocument(uri('before')),after=await vscode.workspace.openTextDocument(uri('after'));
    assert.match(doc.getText(),/Direct Maven BOM import org\.springframework\.boot:spring-boot-dependencies/);
    assert.match(doc.getText(),/Protected local override/);
    assert.equal(before.getText(),review.before);
    assert.equal(after.getText(),review.after);
    await vscode.commands.executeCommand('vscode.diff',uri('before'),uri('after'),'Review Maven BOM starters');
  },async (pom,before,after)=>{
    const buildDoc=await vscode.workspace.openTextDocument(vscode.Uri.file(pom));
    await vscode.window.showTextDocument(buildDoc,{preview:false});
    assert.equal(buildDoc.getText(),after);
    await vscode.commands.executeCommand('undo');
    assert.equal(buildDoc.getText(),before);
    await vscode.commands.executeCommand('redo');
    assert.equal(buildDoc.getText(),after);
    assert.equal(await buildDoc.save(),true);
  });
  assert.equal(report.nativeUndo,true);
  checks.push('The installed Maven BOM starter editor previews exact changes, refuses local overrides and stale source, uses native WorkspaceEdit with Undo/Redo, and builds and runs the saved Spring application.');
  return {...report,nativeBomEdit:true,nativeUndoRedo:true};
}

async function headless(config){
  const tools=new SpringProjectTools({writeBuildFile:async edit=>{
    edit.guard();
    assert.equal(sha(await fs.readFile(edit.path)),edit.beforeSha256);
    await fs.writeFile(edit.path,edit.after);
    return {saved:true,nativeUndo:false};
  }});
  try{return {...await verify(tools,config),nativeBomEdit:false};}finally{tools.dispose();}
}

module.exports={runSpringMavenBomChecks,headless};
if(require.main===module)(async()=>{
  const config=JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG,'utf8'));
  console.log(JSON.stringify(await headless(config)));
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
