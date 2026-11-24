'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {setTimeout:pause}=require('node:timers/promises');
const {buildMavenV27,routes}=require('../scripts/refactoring-v27-maven');
const {verifyRefactoringHttp}=require('../scripts/refactoring-spring');

async function runJavaMavenExternalV27Checks(api,vscode,checks) {
 const config=JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_MAVEN_V27_CONFIG));
 const java=JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_JAVA_TEST_CONFIG));
 const root=config.mavenV27Root;
 const selected=path.join(config.projectPath,'src/main/java/fixture/mavenv27/MoveProbe.java');
 const target=path.join(root,'rb27-core/src/main/java/fixture/mavenv27/core/MoveProbe.java');
 const marker=path.join(path.dirname(target),'Marker.java');
 const consumer=path.join(root,'rb27-consumer/src/main/java/fixture/mavenv27/client/Consumer.java');
 const testConsumer=path.join(root,'rb27-consumer/src/test/java/fixture/mavenv27/client/TestMoveUsage.java');
 const pom=path.join(root,'rb27-consumer/pom.xml');
 const bom=path.join(root,'.rocketbrain-maven-models.json');
 const baseline=new Map(require('../src/java/move').projectFiles(root).map(file=>[file,fs.readFileSync(file)]));
 const uri=file=>vscode.Uri.file(file);
 let plan;

 async function indexed(file) {
  const doc=await vscode.workspace.openTextDocument(uri(file));
  await vscode.window.showTextDocument(doc,{preview:false});
  const deadline=Date.now()+150000;
  while(Date.now()<deadline){
   if((await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider',doc.uri))?.length)return doc;
   await pause(400);
  }
  throw Error('The v0.27 Maven fixture did not finish importing: '+path.basename(file));
 }
 async function checkDocuments(after,{save=false}={}) {
  for(const entry of plan.documents){
   const location=after&&entry.resourceOperation==='rename'?entry.newUri:entry.uri;
   const doc=await vscode.workspace.openTextDocument(vscode.Uri.parse(location));
   assert.equal(doc.getText(),after?entry.after:entry.before);
   if(save)assert.equal(await doc.save(),true);
  }
  assert.equal(fs.existsSync(target),after);
 }
 async function restore() {
  if(fs.existsSync(target)&&!fs.existsSync(selected)){
   const edit=new vscode.WorkspaceEdit();
   edit.renameFile(uri(target),uri(selected));
   assert.equal(await vscode.workspace.applyEdit(edit),true);
  }
  for(const [file,bytes] of baseline){
   const doc=vscode.workspace.textDocuments.find(item=>item.uri.fsPath===file);
   const text=bytes.toString('utf8');
   if(doc&&doc.getText()!==text){
    const edit=new vscode.WorkspaceEdit();
    edit.replace(doc.uri,new vscode.Range(doc.positionAt(0),doc.positionAt(doc.getText().length)),text);
    assert.equal(await vscode.workspace.applyEdit(edit),true);
    assert.equal(await doc.save(),true);
   }
   assert.deepEqual(fs.readFileSync(file),bytes,file);
  }
  assert.equal(fs.existsSync(target),false);
 }
 const routeReports=[];
 try{
  await indexed(marker);
  await indexed(consumer);
  await indexed(testConsumer);
  const source=await indexed(selected);
  const originalPom=fs.readFileSync(pom);
  const narrowed=originalPom.toString('utf8').replace(/(<artifactId>rb27-core<\/artifactId><version>1\.0\.0<\/version><scope>)compile/,(_match,prefix)=>prefix+'runtime');
  assert.notEqual(narrowed,originalPom.toString('utf8'));
  try{
   fs.writeFileSync(pom,narrowed);
   await assert.rejects(api.java.move.prepareCrossProject(source,uri(target)),/compile client rb27-consumer/);
  }finally{fs.writeFileSync(pom,originalPom);}
  const before=buildMavenV27(java,'base');
  const baselineApp=await verifyRefactoringHttp(config,{classpath:before.classpath,expectations:{'/probe/maven-v27':{value:42}}});
  assert.deepEqual(baselineApp.isolation,{people:2,departments:1,rolledBackNames:0});
  const stale=await api.java.move.prepareCrossProject(source,uri(target));
  const bomDoc=await vscode.workspace.openTextDocument(uri(bom));
  const originalBom=bomDoc.getText();
  async function editBom(text) {
   const edit=new vscode.WorkspaceEdit();
   edit.replace(bomDoc.uri,new vscode.Range(bomDoc.positionAt(0),bomDoc.positionAt(bomDoc.getText().length)),text);
   assert.equal(await vscode.workspace.applyEdit(edit),true);
   assert.equal(await bomDoc.save(),true);
  }
  try{
   await editBom(originalBom+'\n');
   await assert.rejects(api.java.refactoring.apply(stale.id),/changed/);
  }finally{await editBom(originalBom);}
  assert.equal(fs.readFileSync(bom,'utf8'),originalBom);
  plan=await api.java.move.prepareCrossProject(source,uri(target));
  const proof=plan.move.buildProof;
  assert.equal(proof.kind,'maven-reactor');
  assert.equal(proof.dynamicContracts.scenarioCount,4);
  assert.equal(proof.dynamicContracts.executedBuildCode,false);
  const inherited = proof.mavenModel.find(module => module.module === 'rb27-app');
  assert.deepEqual(inherited.inheritedDependencies, ['org.rocketbrain.fixture.v27:rb27-core']);
  assert.deepEqual(inherited.managedFields, [{identity:'org.rocketbrain.fixture.v27:rb27-core',fields:['version','scope']}]);
  assert.deepEqual(inherited.parentChain,['rb27-project-parent','rb27-reactor','org.rocketbrain.fixture.v27.external:rb27-company-parent:1.0.0']);
  assert.deepEqual(inherited.bomImports.map(item=>item.module),['rb27-base-bom','rb27-conflict-bom'].map(id=>'org.rocketbrain.fixture.v27.external:'+id+':1.0.0'));
  const pins=JSON.parse(originalBom).models;
  assert.equal(proof.externalMavenModels.length,4);
  for(const pin of pins){
   assert.ok(proof.externalMavenModels.some(model=>model.coordinate===[pin.groupId,pin.artifactId,pin.version].join(':')&&model.sha256===pin.sha256));
   assert.ok(!plan.documents.some(entry=>path.relative(config.externalModelFiles[pin.artifactId],vscode.Uri.parse(entry.uri).fsPath)===''));
  }
  assert.equal(inherited.bomImportDepth,2);
  const client=proof.clientContracts.reviewedClients.find(item=>item.project==='rb27-consumer');
  assert.deepEqual(client.sourceExposureByScenario,[true,false,true,true]);
  assert.deepEqual(client.destinationExposureByScenario,[true,true,true,true]);
  assert.deepEqual(client.sourceTestExposureByScenario,[true,true,true,true]);
  assert.deepEqual(client.destinationTestExposureByScenario,[true,true,true,true]);
  assert.ok(plan.documents.some(entry=>path.relative(testConsumer,vscode.Uri.parse(entry.uri).fsPath)===''&&entry.after.includes('import fixture.mavenv27.core.MoveProbe;')));
  assert.equal(plan.move.semantic.beforeErrors,0);
  assert.equal(plan.move.semantic.afterErrors,0);
  for(const [file,bytes] of baseline)assert.deepEqual(fs.readFileSync(file),bytes,'Preview must preserve disk bytes.');
  assert.equal((await api.java.refactoring.apply(plan.id)).state,'applied');
  await checkDocuments(true);
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri(target)),{preview:false});
  await vscode.commands.executeCommand('undo');
  await checkDocuments(false);
  await vscode.commands.executeCommand('redo');
  await checkDocuments(true,{save:true});
  for(const route of Object.keys(routes)){
   const built=buildMavenV27(java,route);
   const runtime=await verifyRefactoringHttp(config,{classpath:built.classpath,expectations:{'/probe/maven-v27':{value:42}}});
   assert.deepEqual(runtime.isolation,baselineApp.isolation);
   routeReports.push({route,effective:built.effective,testClientCompiled:built.testClientCompiled,value:runtime.move,database:runtime.isolation});
  }
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri(target)),{preview:false});
  await vscode.commands.executeCommand('undo');
  await checkDocuments(false,{save:true});
 }finally{await restore();}
 checks.push('Native Maven cross-project Move and Undo/Redo preserve the Spring endpoint and live database results under all four actual profile combinations. Apache Maven effective POMs agree across the pinned external parent and BOM closure. A narrowed inherited classpath and a changed model pin file both refuse the move.');
 return {routes:routeReports,nativeUndoRedo:true,hiddenClientRefused:true,stalePinsRefused:true,externalPinsVerified:4};
}

module.exports={runJavaMavenExternalV27Checks};
