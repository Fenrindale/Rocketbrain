'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {test}=require('node:test');
const {filterInlayHints,semanticTokenAt}=require('../src/java/code-hints');
const {resolveLaunch,serverSettings}=require('../src/java/runtime');
const {kotlinEditorLaunch,kotlinProtocolUri}=require('../src/java/kotlin-editor-runtime');
const {positionAt}=require('../src/spring/java');
const {StdioLsp,until}=require('./helpers/stdio-lsp');
const {javaHintsFixture,kotlinHintsFixture}=require('./helpers/code-hints-fixture');

const whole=text=>({start:{line:0,character:0},end:positionAt(text,text.length)});

test('inlay mode filters exact plain literals and stale provider positions and does not forward command-bearing labels',()=>{
  const text='call("yes", value, 1 + value, 2);\n';
  const inputs=[
    {position:{line:0,character:5},label:[{value:'caption:',command:{command:'example'}}]},
    {position:{line:0,character:12},label:'other:'},
    {position:{line:0,character:19},label:'number:'},
    {position:{line:0,character:30},label:'count:'},
    {position:{line:0,character:10},label:': Result'},
    {position:{line:9,character:0},label:'stale:'}
  ];
  const select=(parameters,types)=>filterInlayHints(inputs,{text,range:whole(text),language:'java',parameters,types});
  assert.deepEqual(select('all',false).map(item=>item.label),['caption:','other:','number:','count:']);
  assert.deepEqual(select('literals',false).map(item=>item.label),['caption:','count:']);
  assert.deepEqual(select('none',true).map(item=>item.label),[': Result']);
  assert.deepEqual(select('none',false),[]);
  assert.ok(!JSON.stringify(select('all',true)).includes('command'));
});

test('semantic classification decodes UTF-16 relative tokens with exact ranges and modifiers',()=>{
  const text='// line\r\nclass Example { int x; }\r\n';
  const legend={tokenTypes:['class','variable'],tokenModifiers:['declaration','readonly']};
  const data=Uint32Array.from([1,6,7,0,1,0,14,1,1,3]);
  assert.deepEqual(semanticTokenAt(text,{line:1,character:8},legend,data),{
    text:'Example',type:'class',modifiers:['declaration'],range:{start:{line:1,character:6},end:{line:1,character:13}}
  });
  assert.equal(semanticTokenAt(text,{line:1,character:15},legend,data),null);
  assert.equal(semanticTokenAt(text,{line:1,character:7},legend,Uint32Array.from([1,6,300,0,0])),null);
});

const config=process.env.ROCKETBRAIN_JAVA_TEST_CONFIG,kotlinHome=process.env.ROCKETBRAIN_KOTLIN_EDITOR_HOME;
for(const language of ['java','kotlin'])test('actual '+language+' provider classifies code and supplies argument and inferred type hints',{
  skip:!config||language==='kotlin'&&!kotlinHome,timeout:155000
},async t=>{
  const {javaHome,serverPath,gradleHome}=JSON.parse(await fs.readFile(config,'utf8'));
  const kotlin=language==='kotlin',parent=await fs.realpath(os.tmpdir()),root=await fs.mkdtemp(path.join(parent,'rb-code-hints-'));
  t.after(async()=>{
    const verified=await fs.realpath(root);
    assert.equal(path.dirname(verified),parent);assert.match(path.basename(verified),/^rb-code-hints-/);
    await fs.rm(verified,{recursive:true,force:true,maxRetries:10,retryDelay:250});
  });
  const project=path.join(root,'project'),dir=path.join(project,kotlin?'src/main/kotlin/editor/fixture':'src/main/java/editor/fixture');
  if(kotlin)await fs.cp(path.join(__dirname,'fixtures/java/kotlin-editor'),project,{recursive:true});
  await fs.mkdir(dir,{recursive:true});
  if(!kotlin)await fs.copyFile(path.join(__dirname,'fixtures/java/debugger/pom.xml'),path.join(project,'pom.xml'));
  const file=path.join(dir,kotlin?'KotlinHints.kt':'JavaHints.java');
  const text=kotlin?kotlinHintsFixture:javaHintsFixture('editor.fixture','JavaHints');
  await fs.writeFile(file,text,{flag:'wx'});
  const uriFor=kotlin?kotlinProtocolUri:file=>pathToFileURL(file).href,uri=uriFor(file),rootUri=uriFor(project);
  const settings=kotlin?{kotlin:{inlayHints:{typeHints:true,parameterHints:true,chainedHints:false}}}:
    serverSettings([{name:'JavaSE-25',path:javaHome,default:true}]);
  const launch=kotlin?await kotlinEditorLaunch({serverHome:kotlinHome,javaHome,gradleHome,root:project,
    gradleUserHome:process.env.ROCKETBRAIN_KOTLIN_EDITOR_GRADLE_HOME||path.join(root,'gradle'),storageRoot:path.join(root,'storage')}):
    resolveLaunch({javaHome,serverPath,storagePath:path.join(root,'storage')});
  const lsp=new StdioLsp(launch);
  try {
    const initialize=await lsp.request('initialize',{processId:process.pid,rootUri,rootPath:project,
      workspaceFolders:[{uri:rootUri,name:'Code Hints Fixture'}],capabilities:{workspace:{configuration:true,workspaceFolders:true},
        textDocument:{inlayHint:{dynamicRegistration:false},semanticTokens:{requests:{full:true},tokenTypes:[],tokenModifiers:[],formats:['relative']}}},
      initializationOptions:{workspaceFolders:[rootUri],settings}},75000);
    const legend=initialize.capabilities.semanticTokensProvider?.legend;
    assert.ok(initialize.capabilities.inlayHintProvider&&legend);
    lsp.notify('initialized',{});
    lsp.notify('workspace/didChangeConfiguration',{settings});
    lsp.notify('textDocument/didOpen',{textDocument:{uri,languageId:language,version:1,text}});
    const range=whole(text),textDocument={uri};
    const raw=await until(async()=>{
      const hints=await lsp.request('textDocument/inlayHint',{textDocument,range},25000);
      return hints?.length?hints:undefined;
    },60000);
    const group=(parameters,types)=>filterInlayHints(raw,{text,range,language,parameters,types});
    const all=group('all',true),literals=group('literals',false),onlyTypes=group('none',true);
    assert.ok(literals.some(hint=>/^caption:\s*$/.test(hint.label)),JSON.stringify(raw));
    assert.ok(literals.some(hint=>/^count:\s*$/.test(hint.label)),JSON.stringify(raw));
    assert.equal(all.filter(hint=>hint.kind===2&&/^(?:caption|count):\s*$/.test(hint.label)).length,4,JSON.stringify(raw));
    assert.equal(literals.length,2);
    assert.ok(onlyTypes.some(hint=>/\bString\b/.test(hint.label)),JSON.stringify(raw));
    if(!kotlin)assert.ok(onlyTypes.some(hint=>hint.label==='String'),JSON.stringify(raw));
    const point=positionAt(text,text.indexOf('renderHint("literal"')+2);
    const token=await until(async()=>{
      const response=await lsp.request('textDocument/semanticTokens/full',{textDocument},25000);
      return semanticTokenAt(text,point,legend,response?.data)||undefined;
    },50000);
    assert.equal(token.text,'renderHint');
    assert.match(token.type,/method|function/);
    const evidence=process.env.ROCKETBRAIN_HINT_RECEIPTS;
    if(evidence)await fs.writeFile(path.join(evidence,'v76-'+language+'-code-hints.json'),JSON.stringify({language,
      all:all.map(item=>item.label),literals:literals.map(item=>item.label),types:onlyTypes.map(item=>item.label),token},null,2)+'\n');
  }finally{try{await lsp.close();}finally{await launch.dispose?.();}}
});
