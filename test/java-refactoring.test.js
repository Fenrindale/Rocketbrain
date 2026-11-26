'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{pathToFileURL,fileURLToPath}=require('node:url');
const {createHash}=require('node:crypto');
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
test('saved type-rename dependencies can survive eviction without reopening hidden editors',async()=>{
 const h=fixture(),workspace=h.vscode.workspace,root=path.dirname(h.file);
 const sha=value=>createHash('sha256').update(value).digest('hex');
 const files=['First.java','Second.java'].map((name,index)=>{
  const file=path.join(root,name),disk=Buffer.from('class Guard'+index+' {\r\n int x;\n}\n');
  fs.writeFileSync(file,disk);
  const text=disk.toString().replace(/\r\n/g,'\n'),uri=pathToFileURL(file).href;
  return {file,disk,text,uri,diskGuard:{diskHash:sha(disk),hash:sha(text)}};
 });
 const {uri,file,disk,text}=files[0];
 let hidden,opens=0,applied=0;
 workspace.textDocuments=[h.document];
 workspace.openTextDocument=async value=>{
  if(value.fsPath===h.file)return h.document;
  const fixture=files.find(entry=>entry.file===value.fsPath);
  if(hidden)hidden.isClosed=true;
  hidden={uri:value,isClosed:false,isDirty:false,version:++opens,getText:()=>fixture.text};
  return hidden;
 };
 workspace.applyEdit=async()=>{applied++;return true;};
 const preview=(guards,options={})=>h.api.previewWorkspaceEdit(h.action.edit,
  {kind:'refactor.rename.java.type',anchorDocument:h.document,guards,...options});
 const guards=files.map(({uri,diskGuard})=>({uri,diskGuard}));
 try {
  await assert.rejects(preview(files.map(({uri})=>({uri}))),/source file changed after review/);
  const previousOpens=opens;
  const first=await preview(guards);
  assert.equal(first.guardCount,2);
  assert.equal((await h.api.apply(first.id)).state,'applied');
  assert.equal(opens,previousOpens);

  const diskReview=await preview(guards);
  fs.writeFileSync(file,text);
  await assert.rejects(h.api.apply(diskReview.id),/type rename dependency changed/);
  fs.writeFileSync(file,disk);

  const clean={uri:h.vscode.Uri.parse(uri),isClosed:false,isDirty:false,version:11,getText:()=>text};
  const dirty={...clean,isDirty:true};
  const dirtyReview=await preview(guards,{preApply:()=>workspace.textDocuments.push(dirty)});
  workspace.textDocuments.push(clean);
  await assert.rejects(h.api.apply(dirtyReview.id),/type rename dependency changed/);
  assert.equal(opens,previousOpens);
  assert.equal(applied,1);
 }finally{await h.api.dispose();}
});
test('type rename still requires an initially open guard and edited buffer to keep their reviewed versions',async()=>{
 const h=fixture(),workspace=h.vscode.workspace,source=h.document;
 const file=path.join(path.dirname(h.file),'AlreadyOpen.java');
 fs.writeFileSync(file,'class AlreadyOpen {}');
 const uri=h.vscode.Uri.parse(pathToFileURL(file).href);
 const guard={uri,isClosed:false,isDirty:false,version:1,getText:()=>fs.readFileSync(file,'utf8')};
 workspace.textDocuments=[source,guard];
 workspace.openTextDocument=async value=>value.fsPath===h.file?source:guard;
 const preview=()=>h.api.previewWorkspaceEdit(h.action.edit,{kind:'refactor.rename.java.type',
  anchorDocument:source,guards:[{uri:uri.toString()}]});
 try{
  const openReview=await preview();
  guard.version++;
  await assert.rejects(h.api.apply(openReview.id),/source file changed after review/);
  const editedReview=await preview();
  source.version++;
  await assert.rejects(h.api.apply(editedReview.id),/source file changed after review/);
 }finally{await h.api.dispose();}
});
test('a Java formatting review closes prior history before an independent editor EOL edit',async()=>{
 const h=fixture(),uri=h.document.uri.toString(),edit={documentChanges:[{textDocument:{uri,version:h.document.version},edits:[]}]};
 h.vscode.EndOfLine={LF:1,CRLF:2};
 h.document.eol=1;
 const applied=[];
 h.vscode.window={showTextDocument:async()=>({document:h.document,edit:async(callback,options)=>{
  callback({setEndOfLine:eol=>applied.push({eol,options})});return true;
 }})};
 try{
  await assert.rejects(h.api.previewWorkspaceEdit(edit,{anchorDocument:h.document,formattingEndOfLine:'crlf'}),/one reviewed Java or Kotlin formatting document/);
  const plan=await h.api.previewWorkspaceEdit(edit,{kind:'source.format.java',anchorDocument:h.document,formattingEndOfLine:'crlf'});
  assert.equal(plan.documents[0].after,h.document.text.replace(/\n/g,'\r\n'));
  assert.equal((await h.api.apply(plan.id)).state,'applied');
  assert.deepEqual(applied,[{eol:1,options:{undoStopBefore:true,undoStopAfter:true}},
    {eol:2,options:{undoStopBefore:false,undoStopAfter:true}}]);
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

test('an optional comment selection cannot drop a mandatory edit or add Java tokens',async()=>{
 const h=fixture(),root=path.dirname(h.file),workspace=h.vscode.workspace;
 const noteFile=path.join(root,'Note.java'),target=path.join(root,'Reviewed.java');
 const noteText='class Note {} // TODO Example\n';
 fs.writeFileSync(noteFile,noteText);
 const noteUri=h.vscode.Uri.parse(pathToFileURL(noteFile).href);
 const noteDoc={uri:noteUri,version:1,isClosed:false,isDirty:false,getText:()=>noteText};
 workspace.textDocuments=[h.document,noteDoc];
 workspace.openTextDocument=async address=>address.fsPath===h.file?h.document:noteDoc;
 let applied=0,child;
 workspace.applyEdit=async()=>{applied++;return true;};
 const source=h.document.uri.toString(),destination=pathToFileURL(target).href;
 const move={kind:'rename',oldUri:source,newUri:destination};
 const required={textDocument:{uri:source,version:1},edits:h.action.edit.changes[source]};
 const options={kind:'refactor.rename.java.type',anchorDocument:h.document,allowedResourceOperations:['rename'],
  guards:[{uri:noteUri.toString()}],validate:()=>{},preApply:()=>{}};
 const prepare=omitMandatory=>h.api.previewWorkspaceEdit({documentChanges:[required,move]},{
  ...options,commentChoices:{groups:[{id:'1',uri:noteUri.toString(),count:1}],async select(){
   const note={textDocument:{uri:noteUri.toString(),version:1},edits:[{
    range:{start:{line:0,character:0},end:{line:0,character:5}},newText:'interface'
   }]};
   const entries=omitMandatory?[note,move]:[required,note,move];
   child=await h.api.previewWorkspaceEdit({documentChanges:entries},options);
   return child;
  }}
 });
 try{
  for(const omitMandatory of [true,false]){
   const plan=await prepare(omitMandatory);
   await assert.rejects(h.api.selectOptionalComments(plan.id,['1']),/mandatory edit or reviewed source/u);
   await assert.rejects(h.api.apply(plan.id),/expired/u);
   await assert.rejects(h.api.apply(child.id),/expired/u);
  }
  assert.equal(applied,0);
  assert.equal(fs.readFileSync(noteFile,'utf8'),noteText);
 }finally{await h.api.dispose();}
});
