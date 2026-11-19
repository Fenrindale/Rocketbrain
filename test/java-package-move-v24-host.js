'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {setTimeout:pause}=require('node:timers/promises');
const {waitPackageOutputs}=require('./java-package-move-v23-host');
const {expected}=require('./package-resource-v24-data');
const {buildPackageV24}=require('../scripts/refactoring-v24-package');
const {verifyRefactoringHttp}=require('../scripts/refactoring-spring');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');

async function runJavaPackageMoveV24Checks(api,vscode,checks) {
 const config=JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_MOVE_V24_PACKAGE_CONFIG));
 const java=JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_JAVA_TEST_CONFIG));
 const root=config.projectPath;
 const source=path.join(root,'src/main/java/fixture/packagev24/payload');
 const target=path.join(root,'src/main/java/fixture/packagev24/relocated');
 const custom=path.join(root,'src/package-assets/fixture/packagev24');
 const standard=path.join(root,'src/main/resources/fixture/packagev24');
 const controller=path.join(root,'src/main/java/fixture/packagev24/PackageController.java');
 const images=new Map(config.generatedImages.map(item=>[item.source,item]));
 const png=path.join(custom,'payload/pixel.png'),jpg=path.join(custom,'payload/nested/pixel.jpg');
 assert.deepEqual([...images.keys()].sort(),[png,jpg].sort());
 for(const item of images.values())assert.equal(hash(fs.readFileSync(item.source)),item.sha256);
 const dataFiles=[path.join(standard,'payload/root.txt'),path.join(standard,'payload/nested/rows.csv'),
  path.join(custom,'payload/labels.json'),path.join(custom,'payload/nested/labels.properties')];
 const files=new Set([...require('../src/java/move').projectFiles(root),...dataFiles,...images.keys(),path.join(root,'build.gradle'),path.join(root,'settings.gradle')]);
 const baseline=new Map([...files].map(file=>[file,fs.readFileSync(file)]));
 const destinations=[path.join(target,'RootValue.java'),path.join(target,'nested/NestedValue.java'),
  ...dataFiles.map(file=>file.replace(path.sep+'payload'+path.sep,path.sep+'relocated'+path.sep)),...config.generatedImages.map(item=>item.destination)];
 const engine=config.dbEngine;
 const report={version:'0.24.0',engine,operations:[],negative:[],classOutputReadiness:[]};
 const uri=file=>vscode.Uri.file(file);
 let plan,applied=false;

 function originalFiles() {
  for(const [file,bytes] of baseline)assert.deepEqual(fs.readFileSync(file),bytes,file);
  for(const file of destinations)assert.equal(fs.existsSync(file),false,file);
 }
 async function indexed(file) {
  const doc=await vscode.workspace.openTextDocument(uri(file));
  await vscode.window.showTextDocument(doc,{preview:false});
  const deadline=Date.now()+150000;
  while(Date.now()<deadline){
   if((await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider',doc.uri))?.length)return doc;
   await pause(350);
  }
  throw Error('The v0.24 package fixture was not indexed: '+path.basename(file));
 }
 async function prepare() {
  for(const file of [path.join(source,'RootValue.java'),path.join(source,'nested/NestedValue.java'),
   path.join(target,'DestinationMarker.java'),path.join(target,'nested/NestedMarker.java')])await indexed(file);
  await waitPackageOutputs({api,vscode,root,record:report.classOutputReadiness});
  return api.java.move.preparePackage(uri(source),uri(target));
 }
 async function documents(after,save=false) {
  for(const item of plan.documents){
   const location=vscode.Uri.parse(after&&item.resourceOperation==='rename'?item.newUri:item.uri);
   if(item.binary){assert.equal(hash(fs.readFileSync(location.fsPath)),item.resourceSha256);continue;}
   const doc=await vscode.workspace.openTextDocument(location);
   assert.equal(doc.getText(),after?item.after:item.before);
   if(save)assert.equal(await doc.save(),true);
  }
  for(const file of destinations)assert.equal(fs.existsSync(file),after,file);
 }
 async function history(command,after) {
  const doc=await vscode.workspace.openTextDocument(uri(path.join(after?source:target,'RootValue.java')));
  await vscode.window.showTextDocument(doc,{preview:false,preserveFocus:false});
  await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
  assert.equal(vscode.window.activeTextEditor.document,doc);
  await vscode.commands.executeCommand(command);
  await pause(150);
  await documents(after);
 }
 async function setText(doc,value) {
  const edit=new vscode.WorkspaceEdit();
  edit.replace(doc.uri,new vscode.Range(doc.positionAt(0),doc.positionAt(doc.getText().length)),value);
  assert.equal(await vscode.workspace.applyEdit(edit),true);
  assert.equal(await doc.save(),true);
  assert.equal(fs.readFileSync(doc.uri.fsPath,'utf8'),value);
 }

 try{
  originalFiles();
  const baselineResponse=await fetch(config.baseUrl+'/probe/package-v24',{signal:AbortSignal.timeout(5000)});
  assert.equal(baselineResponse.status,200);assert.deepEqual(await baselineResponse.json(),expected);
  for(const file of files){
   if(images.has(file))continue;
   await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri(file)),{preview:false});
  }
  plan=await prepare();
  const proof=plan.move.resourceProof;
  assert.equal(plan.move.movedJavaFiles,2);assert.equal(plan.move.movedResourceFiles,6);
  assert.equal(plan.move.semantic.beforeErrors,0);assert.equal(plan.move.semantic.afterErrors,0);
  assert.equal(proof.lookup.length,8);assert.equal(proof.lookup.filter(item=>item.loader==='classloader').length,3);
  assert.equal(proof.lookup.filter(item=>item.loader==='spring-class').length,2);
  assert.equal(proof.springProvider.version,'7.0.10');assert.equal(proof.springProvider.uniqueObservedProvider,true);
  assert.equal(proof.binaryTextModelsOpened,false);assert.equal(plan.documents.filter(item=>item.binary).length,2);
  originalFiles();
  assert.equal((await api.java.refactoring.apply(plan.id)).state,'applied');
  applied=true;
  await documents(true,true);
  const built=buildPackageV24(java);
  const resourceChecks=proof.files.map(item=>{
   assert.equal(fs.existsSync(item.file),false);
   const output=path.join(root,'build/resources/main',path.relative(item.resourceRoot,item.newFile));
   const oldOutput=path.join(root,'build/resources/main',path.relative(item.resourceRoot,item.file));
   assert.equal(fs.existsSync(oldOutput),false);
   assert.equal(hash(fs.readFileSync(item.newFile)),item.sha256);
   assert.equal(hash(fs.readFileSync(output)),item.sha256);
   return {bytes:item.bytes,sha256:item.sha256,binary:!!item.binary,destinationBytesIdentical:true};
  });
  const runtime=await verifyRefactoringHttp(config,{classpath:fs.readFileSync(built.classpathFile,'utf8').trim(),expectations:{'/probe/package-v24':expected}});
  assert.deepEqual(runtime.isolation,{people:2,departments:1,rolledBackNames:0});
  await history('undo',false);
  await history('redo',true);
  await history('undo',false);
  await documents(false,true);
  applied=false;
  originalFiles();
  report.operations.push({nativeUndo:true,nativeRedo:true,resourceChecks,freshSpringRuntime:runtime,
   lookupCount:proof.lookup.length,verifiedSpringProvider:proof.springProvider.version});

  const late=await prepare();
  try{
   fs.appendFileSync(png,Buffer.from([42]));
   await assert.rejects(api.java.refactoring.apply(late.id),/changed|bytes|resource/i);
   report.negative.push('late-image-bytes-refused');
  }finally{fs.writeFileSync(png,baseline.get(png));}
  const collision=await prepare(),pngTarget=images.get(png).destination;
  try{
   fs.writeFileSync(pngTarget,Buffer.from([42]),{flag:'wx'});
   await assert.rejects(api.java.refactoring.apply(collision.id),/changed|destination|exists|collides/i);
   report.negative.push('late-image-destination-refused');
  }finally{if(fs.existsSync(pngTarget))fs.unlinkSync(pngTarget);}
  const doc=await indexed(controller),old=doc.getText();
  const dynamic=old.replace('RootValue.class.getClassLoader()','Thread.currentThread().getContextClassLoader()');
  assert.notEqual(dynamic,old);
  try{
   await setText(doc,dynamic);
   await assert.rejects(prepare(),/Dynamic|custom|resource lookup/i);
   report.negative.push('context-classloader-refused');
  }finally{await setText(doc,old);}
  checks.push('Six resource moves preserve byte identity, checked class and classloader paths, Spring loader paths and fresh HTTP/database results. Native Undo/Redo restores the original package; late image changes, collisions and a context classloader are refused.');
 }finally{
  if(applied&&plan){
   if(fs.existsSync(path.join(target,'RootValue.java')))await history('undo',false);
   await documents(false,true);
  }
  originalFiles();
  const prefix=process.env.ROCKETBRAIN_TEST_REPORT_PREFIX||'v0.24';
  fs.writeFileSync(path.resolve(__dirname,'../test-output',`${prefix}-native-java-package-v24-${engine}.json`),JSON.stringify(report,null,2)+'\n');
 }
 return report;
}

module.exports={runJavaPackageMoveV24Checks};
