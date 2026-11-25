'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{pathToFileURL,fileURLToPath}=require('node:url');
const {registerJavaRefactoring}=require('../src/java/refactoring');
function fixture(languageId='java'){
 const base=path.resolve('test-output/'+(process.env.ROCKETBRAIN_TEST_REPORT_PREFIX||"v0.10")+'-refactor-unit');fs.mkdirSync(base,{recursive:true});const root=fs.mkdtempSync(path.join(base,'case-')),file=path.join(root,languageId==='kotlin'?'Example.kt':'Example.java'),text=languageId==='kotlin'?'class Example { fun value() = 5 }\n':'class Example { int value() { return 2 + 3; } }\n';fs.writeFileSync(file,text);
 const uri=file=>({scheme:'file',fsPath:file,query:'',fragment:'',toString:()=>pathToFileURL(file).href}),document={uri:uri(file),version:1,languageId,isClosed:false,getText:()=>document.text,text};
 const action={title:'Extract local',kind:'refactor.extract.variable',edit:{changes:{[document.uri.toString()]:[{range:{start:{line:0,character:37},end:{line:0,character:42}},newText:'5'}]}}};
 const vscode={Uri:{parse:value=>uri(fileURLToPath(value))},Range:class {constructor(sl,sc,el,ec){this.start={line:sl,character:sc};this.end={line:el,character:ec};}},TextEdit:class{constructor(range,newText){Object.assign(this,{range,newText});}},WorkspaceEdit:class{entries=[];set(uri,edits){this.entries.push([uri,edits]);}},workspace:{isTrusted:true,getWorkspaceFolder:value=>path.dirname(value.fsPath)===root?{uri:uri(root)}:undefined,openTextDocument:async()=>document,applyEdit:async()=>true,registerTextDocumentContentProvider:()=>({dispose(){}})},commands:{registerCommand:()=>({dispose(){}})}};
 const range={start:{line:0,character:37},end:{line:0,character:42}},api=registerJavaRefactoring({},vscode,{request:async()=>[action]});return {api,vscode,document,file,action,range};
}
test('Java refactoring previews real edits and rejects modified buffers before applying',async()=>{
 const h=fixture();try{const plan=await h.api.preview(h.document,h.range,{title:'Extract local'});assert.notEqual(plan.documents[0].before,plan.documents[0].after);h.document.text+='// user edit';h.document.version++;await assert.rejects(h.api.apply(plan.id),/changed/);}finally{await h.api.dispose();}
});
test('Java refactoring detects external disk changes after a review',async()=>{
 const h=fixture();try{const plan=await h.api.preview(h.document,h.range,{title:'Extract local'});fs.appendFileSync(h.file,'// external writer');await assert.rejects(h.api.apply(plan.id),/changed/);}finally{await h.api.dispose();}
});
test('Java refactoring rejects file operations and arbitrary command execution',async()=>{
 const h=fixture();try{h.action.command={command:'arbitrary'};await assert.rejects(h.api.preview(h.document,h.range),/not integrated/);delete h.action.command;h.action.edit={documentChanges:[{kind:'delete',uri:h.document.uri.toString()}]};await assert.rejects(h.api.preview(h.document,h.range),/separate review/);}finally{await h.api.dispose();}
});
test('reviewed Java edits are consumed once and workspace trust is required',async()=>{
 const h=fixture();try{const plan=await h.api.preview(h.document,h.range),result=await h.api.apply(plan.id);assert.equal(result.state,'applied');assert.equal(result.savedToDisk,false);await assert.rejects(h.api.apply(plan.id),/expired/);h.vscode.workspace.isTrusted=false;await assert.rejects(h.api.list(h.document,h.range),/Trust/);}finally{await h.api.dispose();}
});
test('a first file changed while opening a second file cannot pass a multi-file review',async()=>{
 const h=fixture(),file=path.join(path.dirname(h.file),'Second.java');fs.writeFileSync(file,h.document.text);
 const uri={scheme:'file',fsPath:file,query:'',fragment:'',toString:()=>pathToFileURL(file).href},second={uri,version:1,isClosed:false,text:h.document.text,getText:()=>second.text};let change=false;
 h.action.edit.changes[uri.toString()]=h.action.edit.changes[h.document.uri.toString()];h.vscode.workspace.openTextDocument=async value=>{if(value.fsPath===file){if(change){h.document.text+='// changed';h.document.version++;}return second;}return h.document;};
 try{const plan=await h.api.preview(h.document,h.range);change=true;await assert.rejects(h.api.apply(plan.id),/changed/);}finally{await h.api.dispose();}
});
test('a Java formatting review applies explicit EOL changes with the existing text edit group',async()=>{
 const h=fixture(),uri=h.document.uri.toString(),edit={documentChanges:[{textDocument:{uri,version:h.document.version},edits:[]}]};
 h.vscode.EndOfLine={LF:1,CRLF:2};
 h.vscode.TextEdit.setEndOfLine=newEol=>({newEol});
 let applied;
 h.vscode.workspace.applyEdit=async change=>{applied=change;return true;};
 try{
  await assert.rejects(h.api.previewWorkspaceEdit(edit,{anchorDocument:h.document,formattingEndOfLine:'crlf'}),/one reviewed Java or Kotlin formatting document/);
  const plan=await h.api.previewWorkspaceEdit(edit,{kind:'source.format.java',anchorDocument:h.document,formattingEndOfLine:'crlf'});
  assert.equal(plan.documents[0].after,h.document.text.replace(/\n/g,'\r\n'));
  assert.equal((await h.api.apply(plan.id)).state,'applied');
  assert.deepEqual(applied.entries[0][1],[{newEol:2}]);
 }finally{await h.api.dispose();}
});
test('a Kotlin formatting review only permits text edits to its anchored Kotlin document',async()=>{
 const h=fixture('kotlin'),uri=h.document.uri.toString(),other=path.join(path.dirname(h.file),'Other.kt');
 fs.writeFileSync(other,h.document.text);
 const edits=[{range:{start:{line:0,character:0},end:{line:0,character:0}},newText:'// format\n'}];
 const edit={documentChanges:[{textDocument:{uri,version:h.document.version},edits}]};
 const options={kind:'source.format.kotlin',anchorDocument:h.document};
 try{
  await assert.rejects(h.api.previewWorkspaceEdit(edit,{anchorDocument:h.document}),/local Java source/);
  const unrelated={...edit,documentChanges:[...edit.documentChanges,{textDocument:{uri:pathToFileURL(other).href},edits}]};
  await assert.rejects(h.api.previewWorkspaceEdit(unrelated,options),/one anchored text-only/);
  await assert.rejects(h.api.previewWorkspaceEdit(edit,{...options,allowedResourceOperations:['delete']}),/one anchored text-only/);
  const plan=await h.api.previewWorkspaceEdit(edit,options);
  assert.equal(plan.documents.length,1);
  assert.equal(plan.documents[0].kotlinFormatting,true);
  assert.equal(plan.documents[0].after,'// format\n'+h.document.text);
  assert.equal((await h.api.apply(plan.id)).state,'applied');
 }finally{await h.api.dispose();}
});
