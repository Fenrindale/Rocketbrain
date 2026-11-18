'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function runJavaMoveV22StateChecks(api,vscode,checks){
 const file=process.env.ROCKETBRAIN_MOVE_STATE_V22_CONFIG;if(!file)throw Error('Run the owned v0.22 stateful Move fixture wrapper before native checks.');
 const config=JSON.parse(fs.readFileSync(file)),java=JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_JAVA_TEST_CONFIG)),project=config.stateRoot,base=path.join(project,'src/main/java/fixture/statev22'),prefix=process.env.ROCKETBRAIN_TEST_REPORT_PREFIX||'v0.22',engine=process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE||'mysql',report={version:'0.22.0',asOf:new Date().toISOString(),engine,project,operations:[],negative:[],executedProjectCodeDuringAnalysis:false};
 const files=[...require('../src/java/move').projectFiles(project),path.join(project,'settings.gradle')],original=new Map(files.map(name=>[name,fs.readFileSync(name,'utf8')]));
 await api.java.start();
 async function indexed(name){const uri=vscode.Uri.file(path.join(base,name+'.java')),doc=await vscode.workspace.openTextDocument(uri);await vscode.window.showTextDocument(doc,{preview:false});const deadline=Date.now()+150000;while(Date.now()<deadline){if((await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider',uri))?.length)return doc;await pause(300);}throw Error('The stateful Move fixture did not finish importing.');}
 async function savePlan(plan,after){for(const entry of plan.documents){const doc=await vscode.workspace.openTextDocument(vscode.Uri.parse(entry.uri));assert.equal(doc.getText(),after?entry.after:entry.before);await doc.save();}}
 async function prepare(owner,destination,name){const doc=await indexed(owner),target=await indexed(destination),at=doc.getText().indexOf(name);return api.java.memberMove.prepareInstance(doc,new vscode.Range(doc.positionAt(at),doc.positionAt(at+name.length)),target,{targetParameter:'target'});}
 async function restore(){for(const [name,text]of original){const doc=await vscode.workspace.openTextDocument(vscode.Uri.file(name));if(doc.getText()!==text){const edit=new vscode.WorkspaceEdit();edit.replace(doc.uri,new vscode.Range(doc.positionAt(0),doc.positionAt(doc.getText().length)),text);assert.equal(await vscode.workspace.applyEdit(edit),true);}await doc.save();}}
 async function exercise(owner,destination,name,receiverKind){let plan,applied=false;try{
  plan=await prepare(owner,destination,name);for(const [name,text]of original)assert.equal(fs.readFileSync(name,'utf8'),text,'Preview must not change source or state.');assert.equal(plan.memberMove.receiverKind,receiverKind);assert.equal(plan.memberMove.immutableState.immutableFieldsPreserved,true);assert.equal(plan.memberMove.immutableState.ownerOnlyLiteralCallsPreserved,true);assert.equal(plan.memberMove.immutableState.returnExpressionPreserved,true);
  assert.equal(plan.memberMove.normalization.receiverVisibilityRestored,receiverKind==='field');assert.equal((await api.java.refactoring.apply(plan.id)).state,'applied');applied=true;await savePlan(plan,true);
  require('../scripts/refactoring-v22-state').buildStateV22(java);const fresh=await require('../scripts/refactoring-spring').verifyRefactoringHttp(config,{expectations:{'/probe/move-state-v22':{field:42,parameter:42}}});assert.deepEqual(fresh.isolation,{people:2,departments:1,rolledBackNames:0});
  const anchor=await indexed(owner);await vscode.window.showTextDocument(anchor,{preview:false});await vscode.commands.executeCommand('undo');await pause(100);for(const entry of plan.documents)assert.equal((await vscode.workspace.openTextDocument(vscode.Uri.parse(entry.uri))).getText(),entry.before);
  await vscode.commands.executeCommand('redo');await pause(100);for(const entry of plan.documents)assert.equal((await vscode.workspace.openTextDocument(vscode.Uri.parse(entry.uri))).getText(),entry.after);
  await vscode.commands.executeCommand('undo');await pause(100);applied=false;await savePlan(plan,false);
  report.operations.push({name,receiverKind,nativeUndo:true,nativeRedo:true,changedJavaFiles:plan.documents.length,detail:plan.memberMove,semantic:plan.memberMove.semantic,freshSpringRuntime:fresh});
 }finally{if(applied&&plan){await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(base,owner+'.java'))),{preview:false});await vscode.commands.executeCommand('undo');await pause(100);}await restore();}}
 try{
  await exercise('FieldSource','FieldTarget','fieldTotal','field');
  await exercise('ParameterSource','ParameterTarget','parameterTotal','parameter');
  const stale=await prepare('FieldSource','FieldTarget','fieldTotal'),source=path.join(base,'FieldSource.java'),bytes=fs.readFileSync(source);try{fs.writeFileSync(source,bytes.toString('utf8').replace('retainedState = 7','retainedState = 8'));await assert.rejects(api.java.refactoring.apply(stale.id),/source|changed|disk/i);report.negative.push('late-immutable-state-source-change-refused');}finally{fs.writeFileSync(source,bytes);}
  const doc=await indexed('FieldSource'),target=await indexed('FieldTarget'),at=doc.getText().indexOf('fieldTotal');await assert.rejects(api.java.memberMove.prepareInstance(doc,new vscode.Range(doc.positionAt(at),doc.positionAt(at+10)),target,{targetParameter:'unobserved'}),/target|parameter|receiver/i);report.negative.push('unobserved-field-receiver-refused');
  checks.push('Real JDT immutable-state and final-field receiver moves retain private field ownership, exact pure calls/body and state initializers; fresh Spring with MySQL/MariaDB retains42, native Undo/Redo restores sources, and late state or unknown receivers are refused.');
 }finally{for(const [name,text]of original)assert.equal(fs.readFileSync(name,'utf8'),text);fs.writeFileSync(path.resolve(__dirname,'../test-output',prefix+'-native-java-move-state-v22-'+engine+'.json'),JSON.stringify(report,null,2)+'\n');}
 return report;
}
module.exports={runJavaMoveV22StateChecks};
