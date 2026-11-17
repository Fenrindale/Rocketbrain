'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{pathToFileURL,fileURLToPath}=require('node:url');
const {registerJavaRefactoring}=require('../src/java/refactoring');
function fixture(){
 const base=path.resolve('test-output/'+(process.env.ROCKETBRAIN_TEST_REPORT_PREFIX||"v0.10")+'-refactor-unit');fs.mkdirSync(base,{recursive:true});const root=fs.mkdtempSync(path.join(base,'case-')),file=path.join(root,'Example.java'),text='class Example { int value() { return 2 + 3; } }\n';fs.writeFileSync(file,text);
 const uri=file=>({scheme:'file',fsPath:file,query:'',fragment:'',toString:()=>pathToFileURL(file).href}),document={uri:uri(file),version:1,languageId:'java',isClosed:false,getText:()=>document.text,text};
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
