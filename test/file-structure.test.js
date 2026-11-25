'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {test}=require('node:test');
const {normalizeStructure,filterStructure,currentSymbol}=require('../src/java/file-structure');
const {registerFileStructure}=require('../src/java/file-structure-vscode');
const {rangeAt}=require('../src/spring/java');
const {resolveLaunch,serverSettings}=require('../src/java/runtime');
const {kotlinEditorLaunch,kotlinProtocolUri}=require('../src/java/kotlin-editor-runtime');
const {StdioLsp,until}=require('./helpers/stdio-lsp');
const {javaStructureSource,kotlinStructureSource}=require('./helpers/file-structure-fixture');

function span(text,marker,shift=0,length=marker.length) {
  const start=text.indexOf(marker)+shift;
  return rangeAt(text,start,start+length);
}

test('file structure recovers a source-confirmed malformed parent and refuses stale, foreign and duplicate spans',()=>{
  const text='class Example {\r\n  int value = 2;\r\n  int read() { return value; }\r\n}\r\n';
  const selectionRange=span(text,'Example');
  const malformed={name:'Example',kind:5,range:span(text,'class'),selectionRange};
  const field={name:'value',kind:8,range:span(text,'int value = 2;'),selectionRange:span(text,'value')};
  const method={name:'read()',kind:6,range:span(text,'int read() { return value; }'),selectionRange:span(text,'read')};
  malformed.children=[field,method,{...method,name:'stale'},method,{...method,location:{uri:'file:///foreign.java'}}];
  const inspected=normalizeStructure([malformed],text,{language:'java',sameFile:()=>false});
  assert.equal(inspected.stats.recovered,1);
  assert.equal(inspected.stats.skipped,2);
  assert.equal(inspected.stats.duplicates,1);
  assert.deepEqual(inspected.rows.map(row=>row.name),['Example','value','read()']);
  assert.deepEqual(inspected.rows[0].range,selectionRange);
  assert.deepEqual(filterStructure(inspected.rows,'members').map(row=>row.name),['value']);
  assert.equal(currentSymbol(inspected.rows,text.indexOf('return')).name,'read()');
});

test('the owned action filters symbols and reveals their exact active source, native conversion stays ranged',async()=>{
  let callback,shown,selections=0,changedDuringRequest=false;
  const uri={scheme:'file',fsPath:path.resolve('Example.java'),toString:()=>pathToFileURL(path.resolve('Example.java')).href};
  const text='class Example {\n  int read() { return 2; }\n}\n';
  const document={uri,languageId:'java',version:1,isClosed:false,getText:()=>text};
  const range={start:{line:1,character:6},end:{line:1,character:10}};
  const read={name:'read()',kind:6,range,selectionRange:range};
  const raw=[{name:'Example',kind:5,range:span(text,'class'),selectionRange:span(text,'Example'),children:[read]}];
  const vscode={Range:class {constructor(a,b,c,d){this.start={line:a,character:b};this.end={line:c,character:d};}},
    DocumentSymbol:class {constructor(name,_detail,_kind,range,selection){
      assert.ok(range.start.line<=selection.start.line && selection.end.line<=range.end.line);
      assert.ok(range.start.line<selection.start.line || range.start.character<=selection.start.character);
      Object.assign(this,{name,range,selectionRange:selection});
    }},CancellationTokenSource:class {token={isCancellationRequested:false};cancel(){} dispose(){}},
    ProgressLocation:{Notification:1},workspace:{isTrusted:true,getWorkspaceFolder:()=>({})},
    commands:{registerCommand(_id,run){callback=run;return {dispose(){}};}},window:{activeTextEditor:{document,selection:{active:range.start}},
      showQuickPick:async items=>items[selections++===0?items.findIndex(item=>item.group==='callables'):0],
      withProgress:(_options,work)=>work(),showErrorMessage:assert.fail,showInformationMessage:assert.fail,
      async showTextDocument(doc,options){shown={doc,options};return shown;}}};
  const service=registerFileStructure(vscode,{java:{start:async()=>({state:'running'})},readJava:async()=>{
    if(changedDuringRequest)document.version++;
    return raw;
  },output:{appendLine:assert.fail}});
  try {
    const outline=await service.outline(document,undefined,()=>assert.fail('owned source must cross the checked symbol bridge'));
    assert.deepEqual(outline.map(node=>node.name),['Example','read()']);
    assert.deepEqual(outline[0].range.start,outline[0].selectionRange.start);
    const result=await callback();
    assert.equal(result.group,'callables');
    assert.equal(result.members[0].label,'read()');
    assert.equal(result.currentId,result.members[0].id);
    assert.equal(shown.doc,document);
    assert.deepEqual(shown.options.selection.start,range.start);
    await assert.rejects(service.reveal({...result},result.members[0].id),/known file structure member/);
    document.version++;
    await assert.rejects(service.reveal(result,result.members[0].id),/source changed/);
    changedDuringRequest=true;
    await assert.rejects(service.inspect({document}),/source changed/);
  } finally {service.dispose();}
});

const javaConfig=process.env.ROCKETBRAIN_JAVA_TEST_CONFIG, kotlinServer=process.env.ROCKETBRAIN_KOTLIN_EDITOR_HOME;

for (const language of ['java','kotlin']) test('real '+language+' provider delivers precise nested, overloaded and refreshed source symbols',{
  skip:!javaConfig || language==='kotlin'&&!kotlinServer,timeout:164000
},async t=>{
  const kotlin=language==='kotlin';
  const parent=await fs.realpath(os.tmpdir()),root=await fs.mkdtemp(path.join(parent,'rb-structure-'));
  t.after(async()=>{
    const actual=await fs.realpath(root);
    assert.equal(actual,root); assert.equal(path.dirname(actual),parent); assert.match(path.basename(actual),/^rb-structure-/);
    await fs.rm(actual,{recursive:true,force:true,maxRetries:8,retryDelay:250});
  });
  const {javaHome,serverPath,gradleHome}=JSON.parse(await fs.readFile(javaConfig,'utf8'));
  const project=path.join(root,'project'),dir=path.join(project,kotlin?'src/main/kotlin/editor/fixture':'src/main/java/editor/fixture');
  if(kotlin)await fs.cp(path.join(__dirname,'fixtures/java/kotlin-editor'),project,{recursive:true});
  await fs.mkdir(dir,{recursive:true});
  if(!kotlin)await fs.copyFile(path.join(__dirname,'fixtures/java/debugger/pom.xml'),path.join(project,'pom.xml'));
  const file=path.join(dir,kotlin?'Sample.kt':'Sample.java');
  const source=kotlin?kotlinStructureSource('editor.fixture','Sample'):javaStructureSource('editor.fixture','Sample',{bulk:360});
  await fs.writeFile(file,source,{flag:'wx'});
  const uriFor=kotlin?kotlinProtocolUri:file=>pathToFileURL(file).href,uri=uriFor(file),rootUri=uriFor(project);
  const settings=serverSettings([{name:'JavaSE-25',path:javaHome,default:true}]);
  const launch=kotlin?await kotlinEditorLaunch({serverHome:kotlinServer,javaHome,gradleHome,root:project,
    gradleUserHome:process.env.ROCKETBRAIN_KOTLIN_EDITOR_GRADLE_HOME||path.join(root,'gradle'),storageRoot:path.join(root,'storage')}):
    resolveLaunch({javaHome,serverPath,storagePath:path.join(root,'storage')});
  const lsp=new StdioLsp(launch),proof={language};
  try{
    const initialized=await lsp.request('initialize',{processId:process.pid,rootUri,rootPath:project,
      workspaceFolders:[{uri:rootUri,name:'File structure fixture'}],capabilities:{workspace:{configuration:true,workspaceFolders:true},
        textDocument:{documentSymbol:{hierarchicalDocumentSymbolSupport:true}}},initializationOptions:{workspaceFolders:[rootUri],settings}},90000);
    assert.ok(initialized.capabilities.documentSymbolProvider);
    lsp.notify('initialized',{});
    if(!kotlin)lsp.notify('workspace/didChangeConfiguration',{settings});
    lsp.notify('textDocument/didOpen',{textDocument:{uri,languageId:language,version:1,text:source}});
    const params={textDocument:{uri}};
    const raw=await until(async()=>{
      const actual=await lsp.request('textDocument/documentSymbol',params,45000);
      return actual?.length?actual:undefined;
    },70000);
    const model=normalizeStructure(raw,source,{language,sameFile:value=>value===uri});
    assert.equal(model.stats.skipped,0);
    const calls=filterStructure(model.rows,'callables');
    assert.equal(calls.filter(row=>row.name.startsWith('display')).length,2);
    assert.equal(calls.find(row=>row.name.startsWith(kotlin?'visible':'len')).path,(kotlin?'Sample':'Sample<T>')+' · Inner');
    if(kotlin) {
      assert.ok(calls.some(row=>row.name==='spaced name'));
      assert.ok(model.rows.some(row=>row.name==='FLAG'&&row.path.endsWith('Companion')));
      assert.ok(calls.some(row=>row.name==='Sample'&&row.kind===9));
    } else assert.equal(filterStructure(model.rows,'members').filter(row=>row.name.startsWith('modelField')).length,360);
    const edited=source.replace('display','reviewedDisplay');
    lsp.notify('textDocument/didChange',{textDocument:{uri,version:2},contentChanges:[{text:edited}]});
    const changed=await until(async()=>{
      const response=await lsp.request('textDocument/documentSymbol',params,45000);
      const latest=normalizeStructure(response,edited,{language,sameFile:value=>value===uri});
      return latest.rows.some(row=>row.name.startsWith('reviewedDisplay'))?latest:undefined;
    },50000);
    assert.equal(changed.rows.filter(row=>row.name.startsWith('display')).length,1);
    Object.assign(proof,{symbols:model.rows.length,overloads:2,nested:true,updatedUnsaved:true,provider:launch.serverVersion||'JDT 1.63.0'});
  } finally {try{await lsp.close();}finally{await launch.dispose?.();}}
  const evidence=process.env.ROCKETBRAIN_STRUCTURE_RECEIPT_DIRECTORY;
  if(evidence)await fs.writeFile(path.join(evidence,language+'-structure-proof.json'),JSON.stringify(proof,null,2)+'\n');
});
