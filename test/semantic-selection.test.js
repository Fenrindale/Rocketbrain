'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {test}=require('node:test');
const {pathToFileURL}=require('node:url');
const {resolveLaunch,serverSettings}=require('../src/java/runtime');
const {kotlinEditorLaunch,kotlinProtocolUri}=require('../src/java/kotlin-editor-runtime');
const {positionAt}=require('../src/spring/java');
const {protocolAncestors,selectionLadder,kotlinSelectionAncestors,sqlSelectionAncestors}=require('../src/java/semantic-selection');
const {registerSemanticSelection,COMMANDS}=require('../src/java/semantic-selection-vscode');
const {StdioLsp,until}=require('./helpers/stdio-lsp');

const range=(text,start,end)=>({start:positionAt(text,start),end:positionAt(text,end)});
const slices=(text,ladder)=>ladder.map(span=>text.slice(span.start,span.end));

test('range ladders reject stale boundaries and distinguish acronym, number and identifier',()=>{
  const text='clientHTTP2Response',point=7;
  const raw={range:range(text,0,text.length)};
  const ladder=selectionLadder(text,{start:point,end:point},protocolAncestors(text,raw,point),point);
  assert.deepEqual(slices(text,ladder),['','HTTP',text]);
  assert.deepEqual(protocolAncestors(text,{...raw,parent:{range:range(text,2,text.length)}},point),[]);
  assert.deepEqual(protocolAncestors(text,{range:{start:{line:0,character:0},end:{line:5,character:0}}},point),[]);
});

test('MySQL/MariaDB ranges stay in one statement and follow qualified names, calls and clauses',()=>{
  const text='SELECT 1;\nSELECT UPPER(person.display_name) AS heading FROM people person WHERE person.id > 1;';
  const point=text.indexOf('display_name')+9,initial={start:point,end:point};
  const ladder=slices(text,selectionLadder(text,initial,sqlSelectionAncestors(text,point),point));
  assert.deepEqual(ladder.slice(0,5),['','name','display_name','person.display_name','(person.display_name)']);
  assert.ok(ladder.includes('UPPER(person.display_name)'));
  assert.ok(ladder.includes('SELECT UPPER(person.display_name) AS heading'));
  assert.ok(!ladder.some(item=>item.startsWith('SELECT 1')));
  assert.throws(()=>sqlSelectionAncestors('SELECT "mode-sensitive";',8),/ANSI_QUOTES/);
});

test('owned commands restore multiple cursors and refuse stale versions or provider responses',async()=>{
  const text='oneHTTPValue twoHTTPValue',commands=new Map();
  let pending,modified=false;
  const doc={uri:{scheme:'file'},languageId:'java',version:1,getText:()=>text,
    positionAt:point=>({line:0,character:point}),offsetAt:position=>position.character};
  class Selection {
    constructor(anchor,active) {Object.assign(this,{anchor,active});}
  }
  const selection=(a,b=a)=>new Selection(doc.positionAt(a),doc.positionAt(b));
  const editor={document:doc,selections:[selection(5),selection(18)]};
  const vscode={Selection,CancellationTokenSource:class {token={};cancel(){}dispose(){}},
    workspace:{isTrusted:true,getWorkspaceFolder:()=>({})},
    window:{activeTextEditor:editor,onDidChangeTextEditorSelection:()=>({dispose(){}}),
      showInformationMessage:message=>{pending=message;}},
    commands:{registerCommand(id,run){commands.set(id,run);return {dispose(){}};}}};
  const service=registerSemanticSelection(vscode,{java:{},readJava:async(_document,points)=>{
    if(modified)doc.version++;
    return points.map(point=>({range:point.character<13?range(text,0,12):range(text,13,text.length)}));
  }});
  try {
    const run=mode=>commands.get(COMMANDS[mode])();
    const spans=()=>editor.selections.map(({anchor,active})=>text.slice(anchor.character,active.character));
    assert.equal(await run('expand'),true);assert.deepEqual(spans(),['HTTP','HTTP']);
    assert.equal(await run('expand'),true);assert.deepEqual(spans(),['oneHTTPValue','twoHTTPValue']);
    assert.equal(await run('shrink'),true);assert.deepEqual(spans(),['HTTP','HTTP']);
    assert.equal(await run('shrink'),true);assert.deepEqual(editor.selections,[selection(5),selection(18)]);
    editor.selections=[selection(6,4)];
    assert.equal(await run('expand'),true);assert.deepEqual(editor.selections,[selection(7,3)]);
    assert.equal(await run('shrink'),true);assert.deepEqual(editor.selections,[selection(6,4)]);
    editor.selections=[selection(6)];
    modified=true;
    assert.equal(await run('expand'),false);assert.match(pending,/editor selection changed/);
    assert.equal(await run('shrink'),false);
  } finally {service.dispose();}
});

const config=process.env.ROCKETBRAIN_JAVA_TEST_CONFIG,kotlinHome=process.env.ROCKETBRAIN_KOTLIN_EDITOR_HOME;
for(const language of ['java','kotlin'])test('real '+language+' provider returns source-confirmed semantic selection parents',{
  skip:!config||language==='kotlin'&&!kotlinHome,timeout:135000
},async t=>{
  const kotlin=language==='kotlin',parent=await fs.realpath(os.tmpdir()),root=await fs.mkdtemp(path.join(parent,'rb-selection-'));
  t.after(async()=>{
    const verified=await fs.realpath(root);
    assert.equal(path.dirname(verified),parent);assert.match(path.basename(verified),/^rb-selection-/);
    await fs.rm(verified,{recursive:true,force:true,maxRetries:8,retryDelay:250});
  });
  const metadata=JSON.parse(await fs.readFile(config,'utf8')),project=path.join(root,'project');
  const dir=path.join(project,kotlin?'src/main/kotlin/editor/fixture':'src/main/java/editor/fixture');
  if(kotlin)await fs.cp(path.join(__dirname,'fixtures/java/kotlin-editor'),project,{recursive:true});
  await fs.mkdir(dir,{recursive:true});
  if(!kotlin)await fs.copyFile(path.join(__dirname,'fixtures/java/debugger/pom.xml'),path.join(project,'pom.xml'));
  const file=path.join(dir,kotlin?'Selection.kt':'Selection.java');
  const text=kotlin?'package editor.fixture\nfun example() { val orderHTTP2Value = 1; println(orderHTTP2Value) }\n':
    'package editor.fixture;\nclass Selection { void example() { int orderHTTP2Value = 1; System.out.println(orderHTTP2Value); } }\n';
  await fs.writeFile(file,text,{flag:'wx'});
  const uriFor=kotlin?kotlinProtocolUri:file=>pathToFileURL(file).href,uri=uriFor(file),rootUri=uriFor(project);
  const settings=serverSettings([{name:'JavaSE-25',path:metadata.javaHome,default:true}]);
  const launch=kotlin?await kotlinEditorLaunch({serverHome:kotlinHome,javaHome:metadata.javaHome,gradleHome:metadata.gradleHome,root:project,
    gradleUserHome:process.env.ROCKETBRAIN_KOTLIN_EDITOR_GRADLE_HOME||path.join(root,'gradle'),storageRoot:path.join(root,'storage')}):
    resolveLaunch({javaHome:metadata.javaHome,serverPath:metadata.serverPath,storagePath:path.join(root,'storage')});
  const lsp=new StdioLsp(launch);
  try {
    const initialized=await lsp.request('initialize',{processId:process.pid,rootUri,rootPath:project,
      workspaceFolders:[{uri:rootUri,name:'Selection'}],capabilities:{workspace:{configuration:true,workspaceFolders:true},
        textDocument:{selectionRange:{dynamicRegistration:false},documentSymbol:{hierarchicalDocumentSymbolSupport:true}}},
      initializationOptions:{workspaceFolders:[rootUri],settings}},75000);
    lsp.notify('initialized',{});
    if(!kotlin)lsp.notify('workspace/didChangeConfiguration',{settings});
    lsp.notify('textDocument/didOpen',{textDocument:{uri,languageId:language,version:1,text}});
    const point=text.lastIndexOf('HTTP')+1,initial={start:point,end:point};
    let spans,provider;
    if(initialized.capabilities.selectionRangeProvider) {
      provider='selectionRange';
      const response=await until(async()=>{
        const value=await lsp.request('textDocument/selectionRange',{textDocument:{uri},positions:[positionAt(text,point)]},30000);
        const confirmed=protocolAncestors(text,value?.[0],point);
        return confirmed.length?confirmed:undefined;
      },50000);
      spans=slices(text,selectionLadder(text,initial,response,point));
      assert.deepEqual(spans.slice(0,3),['','HTTP','orderHTTP2Value']);
      assert.ok(spans.some(item=>item.includes('println(orderHTTP2Value)')));
    }else{
      assert.equal(kotlin,true);
      provider='documentSymbol';
      const response=await until(async()=>{
        const nodes=await lsp.request('textDocument/documentSymbol',{textDocument:{uri}},30000);
        return nodes?.length?nodes:undefined;
      },50000);
      const [ancestors]=kotlinSelectionAncestors(text,response,[point],value=>value===uri);
      spans=slices(text,selectionLadder(text,initial,ancestors,point));
      assert.deepEqual(spans.slice(0,3),['','HTTP','orderHTTP2Value']);
      assert.ok(spans.some(item=>item.includes('fun example()')));
    }
    const output=process.env.ROCKETBRAIN_SELECTION_RECEIPT_DIR;
    if(output)await fs.writeFile(path.join(output,'v73-'+language+'-selection.json'),JSON.stringify({language,provider,spans},null,2)+'\n');
  }finally{try{await lsp.close();}finally{await launch.dispose?.();}}
});
