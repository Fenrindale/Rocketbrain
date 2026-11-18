'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {setTimeout:pause}=require('node:timers/promises');
const {buildV23,routes}=require('../scripts/refactoring-v23-build');
const {verifyRefactoringHttp}=require('../scripts/refactoring-spring');

async function runJavaBuildContractV23Checks(api,vscode,checks) {
 const config=JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_BUILD_V23_CONFIG));
 const java=JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_JAVA_TEST_CONFIG));
 const root=config.buildV23Root;
 const source=path.join(config.projectPath,'src/main/java/fixture/buildv23/MoveRoute.java');
 const target=path.join(root,'v23-core/src/main/java/fixture/buildv23/library/MoveRoute.java');
 const marker=path.join(path.dirname(target),'LibraryMarker.java');
 const alternate=path.join(root,'v23-alternate/build.gradle');
 const originalAlternate=fs.readFileSync(alternate);
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
  throw Error('The v0.23 build fixture did not finish importing: '+path.basename(file));
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
  if(fs.existsSync(target)&&!fs.existsSync(source)){
   const edit=new vscode.WorkspaceEdit();
   edit.renameFile(uri(target),uri(source));
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
  const sourceDoc=await indexed(source);
  plan=await api.java.move.prepareCrossProject(sourceDoc,uri(target));
  const proof=plan.move.buildProof;
  assert.equal(proof.dynamicContracts.scenarioCount,3);
  assert.equal(proof.dynamicContracts.executedBuildCode,false);
  assert.ok(proof.clientContracts.reviewedClients.every(client=>!client.sourceExposedInAnyScenario||client.destinationExposedInEveryScenario));
  assert.equal(plan.move.semantic.beforeErrors,0);
  assert.equal(plan.move.semantic.afterErrors,0);
  for(const [file,bytes] of baseline)assert.deepEqual(fs.readFileSync(file),bytes,'Preview must preserve the disk snapshot.');
  assert.equal((await api.java.refactoring.apply(plan.id)).state,'applied');
  await checkDocuments(true);
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri(target)),{preview:false});
  await vscode.commands.executeCommand('undo');
  await checkDocuments(false);
  await vscode.commands.executeCommand('redo');
  await checkDocuments(true,{save:true});
  for(const route of Object.keys(routes)){
   const classpath=fs.readFileSync(buildV23(java,route),'utf8').trim();
   const runtime=await verifyRefactoringHttp(config,{classpath,expectations:{'/probe/build-v23':{value:42}}});
   assert.deepEqual(runtime.isolation,{people:2,departments:1,rolledBackNames:0});
   routeReports.push({route,value:runtime.extra['/probe/build-v23'].value,database:runtime.isolation});
  }
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri(target)),{preview:false});
  await vscode.commands.executeCommand('undo');
  await checkDocuments(false,{save:true});
  try{
   fs.writeFileSync(alternate,originalAlternate.toString('utf8').replace('api project','implementation project'));
   await assert.rejects(api.java.move.prepareCrossProject(await indexed(source),uri(target)),/compile-exposed dependency/);
  }finally{fs.writeFileSync(alternate,originalAlternate);}
 }finally{await restore();}
 checks.push('Compound Gradle conditions retained all three source-only scenarios. Native cross-project Move and Undo/Redo preserved the Spring endpoint and live database queries for each actual Gradle route.');
 return {routes:routeReports,nativeUndoRedo:true,unsafeAlternateExposureRefused:true};
}

module.exports={runJavaBuildContractV23Checks};
