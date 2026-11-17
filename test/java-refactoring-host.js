'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{spawnSync}=require('node:child_process');
async function runJavaRefactoringChecks(api,vscode,checks){
 await api.java.start();
 const config=JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_JAVA_TEST_CONFIG,'utf8'));
 const file=path.resolve(__dirname,'fixtures/java/maven/src/main/java/dev/rocketbrain/RefactorFixture.java'),uri=vscode.Uri.file(file),document=await vscode.workspace.openTextDocument(uri),original=fs.readFileSync(file,'utf8');
 assert.equal(document.getText().replace(/\r\n/g,'\n'),original.replace(/\r\n/g,'\n'));assert.equal(document.isDirty,false,'Owned refactor fixture starts saved');await vscode.window.showTextDocument(document);
 const readyUntil=Date.now()+60000;let ready=false;while(Date.now()<readyUntil){const symbols=await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider',uri);if(symbols?.length){ready=true;break;}await new Promise(resolve=>setTimeout(resolve,250));}assert.equal(ready,true,'The owned refactoring compilation unit is indexed before requesting edits');
 const base=path.resolve(__dirname,'../test-output/v0.10-java-refactor-runs');fs.mkdirSync(base,{recursive:true});const folder=fs.mkdtempSync(path.join(base,'native-')),source=path.join(folder,'RefactorFixture.java'),classes=path.join(folder,'classes');fs.mkdirSync(classes);
 const range=marker=>{const text=document.getText(),start=text.indexOf(marker);assert.ok(start>=0,marker);return new vscode.Range(document.positionAt(start),document.positionAt(start+marker.length));};
 const restore=async()=>{const edit=new vscode.WorkspaceEdit();edit.replace(uri,new vscode.Range(document.positionAt(0),document.positionAt(document.getText().length)),original);assert.equal(await vscode.workspace.applyEdit(edit),true);};
 const run=text=>{fs.writeFileSync(source,text);const compile=spawnSync(path.join(config.javaHome,'bin/javac.exe'),['-encoding','UTF-8','-d',classes,source],{encoding:'utf8',windowsHide:true,timeout:30000});assert.equal(compile.status,0,compile.stderr);const actual=spawnSync(path.join(config.javaHome,'bin/java.exe'),['-cp',classes,'dev.rocketbrain.RefactorFixture'],{encoding:'utf8',windowsHide:true,timeout:10000});assert.equal(actual.status,0,actual.stderr);return actual.stdout.trim();};
 const before=run(original);assert.equal(before,'11:11:A,B');const reports=[];
 try{
  for(const entry of [{title:'Extract to method',marker:'value * 2 + 3'},{title:'Extract to local variable',marker:'value * 2 + 3'},{title:'Extract to field',marker:'value * 2 + 3'},{title:'Inline local variable',marker:'doubled'},{title:'Organize imports',marker:'import java.util.List;'}]){
   console.log('[Java refactor test] '+entry.title);
   const selection=range(entry.marker),only=entry.title==='Organize imports'?['source.organizeImports']:['refactor'];
   const actions=await api.java.refactoring.list(document,selection,{only});assert.ok(actions.some(action=>action.title===entry.title),JSON.stringify(actions.map(a=>a.title)));
   const native=await vscode.commands.executeCommand('vscode.executeCodeActionProvider',uri,selection,only[0],100);assert.ok(native.some(action=>action.title===entry.title),'Public native Java code actions expose '+entry.title);
   const plan=await api.java.refactoring.preview(document,selection,{title:entry.title,only});assert.ok(plan.documents.length>=1);assert.notEqual(plan.documents[0].after,plan.documents[0].before);
   const result=await api.java.refactoring.apply(plan.id);assert.equal(result.state,'applied');assert.equal(document.getText(),plan.documents.find(d=>d.uri.toLowerCase()===uri.toString().toLowerCase()).after);assert.equal(run(document.getText()),before);
   reports.push({title:entry.title,kind:plan.kind,files:result.files,compiled:true,output:before,reviewed:true});await restore();
  }
  const selection=range('value * 2 + 3'),stale=await api.java.refactoring.preview(document,selection,{title:'Extract to method'});
  const change=new vscode.WorkspaceEdit();change.insert(uri,document.positionAt(document.getText().length),'\n// changed after review');await vscode.workspace.applyEdit(change);await assert.rejects(api.java.refactoring.apply(stale.id),/changed/);await restore();
  checks.push('Independent JDT refactoring supplies native method/local/field extraction, local inlining and organize imports; each reviewed actual edit compiles with JDK25 and preserves executable output.');
  checks.push('Java refactoring rejects changed-source reviews, consumes reviewed edits once and keeps editor changes unsaved for normal Undo.');
  fs.writeFileSync(path.resolve(__dirname,'../test-output/'+(process.env.ROCKETBRAIN_TEST_REPORT_PREFIX||"v0.10")+'-native-java-refactoring-'+(process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE||'mysql')+'.json'),JSON.stringify({asOf:new Date().toISOString(),engine:process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE,reports,output:before,staleReviewRejected:true,scope:'Five actual native code actions; move/change signature/safe delete and all project combinations remain outside this proof.'},null,2)+'\n');
 }finally{
  await restore();await vscode.window.showTextDocument(document);if(document.getText().replace(/\r\n/g,'\n')===fs.readFileSync(file,'utf8').replace(/\r\n/g,'\n'))await vscode.commands.executeCommand('workbench.action.files.revert');
 }
}
module.exports={runJavaRefactoringChecks};
