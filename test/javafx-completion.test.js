'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {pathToFileURL} = require('node:url');
const {test} = require('node:test');
const {fxmlCompletionContext} = require('../src/java/javafx-completion-context');
const {fxmlComponent} = require('../src/java/javafx-class-index');
const {registerFxmlCompletion} = require('../src/java/javafx-completion');
const {resolveLaunch,serverSettings} = require('../src/java/runtime');
const {StdioLsp,until} = require('./helpers/stdio-lsp');
const {createFixture,buildFixture,exerciseCompletion,runtimeLoad} = require('./helpers/javafx-completion-fixture');

function at(marked) {
  return fxmlCompletionContext(marked.replace('|',''),marked.indexOf('|'));
}

test('FXML completion spans never replace quotes, imports outside their PI, or existing property values',()=>{
  const importHole=at('<?import javafx.scene.control.La|bel ?>');
  assert.deepEqual([importHole.start,importHole.end,importHole.prefix],[9,35,'javafx.scene.control.La']);
  const next=at('<?import javafx.scene.control.*?><Label wr|apText = "old" text="Retained"/>');
  assert.equal(next.equals,true);
  assert.deepEqual([...next.seen],['text']);
  assert.equal(next.prefix,'wr');
  const value=at('<Label text="a > b" wrapText="f|alse" />');
  assert.equal(value.kind,'value');
  assert.equal(value.end-value.start,5);
  for (const text of ['<Label text="x| y"/>','<!-- <Lab| /> -->','<Label xmlns:fx|="x"/>',
    '<Label wrapText="${x|}"/>','<!DOCTYPE x><La|bel/>','<Label></La|bel>','<Label text="x" text="y" wrap|/>']) {
    assert.equal(at(text),undefined,text);
  }
});

const config = process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;
const libs = process.env.ROCKETBRAIN_FXML_COMPLETION_LIBS;
const gradleCache = process.env.ROCKETBRAIN_FXML_COMPLETION_GRADLE_CACHE;
const mysql = process.env.ROCKETBRAIN_FXML_COMPLETION_MYSQL_SPRING;
const mariadb = process.env.ROCKETBRAIN_FXML_COMPLETION_MARIADB_SPRING;
const uri = file => pathToFileURL(file).href;

async function springProof(file, engine) {
  const runtime=JSON.parse(await fs.readFile(file,'utf8'));
  assert.equal(runtime.dbEngine,engine);
  assert.match(runtime.baseUrl,/^http:\/\/127\.0\.0\.1:\d+$/u);
  const response=await fetch(runtime.baseUrl+'/probe/testing-state',{signal:AbortSignal.timeout(6000)});
  assert.equal(response.ok,true);
  const jdbc=await response.json();
  assert.deepEqual(jdbc,{people:2,departments:1,rolledBackNames:0});
  return {engine,jdbc};
}

test('FXML completion observes actual Gradle and Eclipse JDT metadata with both actual Spring databases',{
  skip:process.platform!=='win32'||process.arch!=='x64'||!config||!libs||!gradleCache||!mysql||!mariadb,
  timeout:220000
},async t=>{
  const parent=await fs.realpath(os.tmpdir()), owned=await fs.mkdtemp(path.join(parent,'rb-fxml-completion-live-'));
  let lsp;
  t.after(async()=>{
    await lsp?.close();
    const verified=await fs.realpath(owned);
    assert.equal(path.dirname(verified),parent);
    assert.ok(path.basename(verified).startsWith('rb-fxml-completion-live-'));
    await fs.rm(verified,{recursive:true,force:true,maxRetries:10,retryDelay:400});
  });
  const workspace=path.join(owned,'workspace'), root=path.join(workspace,'owned-fxml-module');
  const {javaHome,gradleHome,serverPath}=JSON.parse(await fs.readFile(config,'utf8'));
  const fixture=await createFixture(root,libs);
  const compiled=await buildFixture(fixture,{javaHome,gradleHome,gradleCache});
  const launch=resolveLaunch({javaHome,serverPath,storagePath:path.join(owned,'jdt')});
  const settings=serverSettings([{name:'JavaSE-25',path:javaHome,default:true}],{gradleHome,gradleJavaHome:javaHome});
  settings.java.import.gradle.wrapper.enabled=false;
  launch.options.env.GRADLE_USER_HOME=gradleCache;
  lsp=new StdioLsp(launch);
  const initialize=await lsp.request('initialize',{processId:process.pid,rootUri:uri(workspace),
    workspaceFolders:[{uri:uri(workspace),name:'fxml-completion'}],capabilities:{workspace:{workspaceFolders:true},textDocument:{}},
    initializationOptions:{bundles:[],workspaceFolders:[uri(workspace)],settings}},70000);
  assert.match(initialize.serverInfo?.name||'JDT',/JDT|Java/iu);
  lsp.notify('initialized',{});
  const request=(command,args)=>lsp.request('workspace/executeCommand',{command,arguments:args},20000);
  const ready=await until(()=>fxmlComponent({filename:fixture.files.get('custom-tag').file,workspace,request}),75000);
  assert.equal(path.relative(ready.root,root),'');
  assert.equal(ready.modules.length,4);
  const build=await lsp.request('java/buildWorkspace',true,75000);
  assert.ok(build===0||build===1,'Exact imported Gradle Java build returned '+build);
  let provider;
  const service=registerFxmlCompletion({
    workspace:{isTrusted:true,textDocuments:[],getWorkspaceFolder:()=>({uri:{scheme:'file',toString:()=>uri(workspace)}}),
      getConfiguration:()=>({get:()=>javaHome})},
    languages:{registerCompletionItemProvider(_selector,value){provider=value;return {dispose(){}};}},
    Range:class {constructor(start,end){Object.assign(this,{start,end});}},
    CompletionItemKind:{Class:7,Property:10,Value:12}, CompletionItem:class {constructor(label,kind){Object.assign(this,{label,kind});}},
    SnippetString:class {constructor(value){this.value=value;}}
  },{requestWorkspaceCommand:request,getState:()=>({javaHome})},{scheme:'file',pattern:'**/*.fxml'});
  t.after(()=>service.dispose());
  async function complete(item) {
    const items=await provider.provideCompletionItems({
      uri:{scheme:'file',authority:'',fsPath:item.file},isClosed:false,fileName:item.file,version:1,
      getText:()=>item.text,offsetAt:position=>position,positionAt:offset=>offset
    },item.offset);
    return items.map(entry=>({name:entry.label,start:entry.range.start,end:entry.range.end,
      text:typeof entry.insertText==='string'?entry.insertText:entry.insertText.value}));
  }
  const available=await until(async()=> (await complete(fixture.files.get('custom-tag'))).find(entry=>entry.name==='RocketLabel'),35000);
  assert.equal(available.text,'RocketLabel');
  const hydrated=await exerciseCompletion(fixture,complete);
  await runtimeLoad(hydrated,fixture,compiled,javaHome);
  const prior=await fs.readFile(fixture.source,'utf8');
  await fs.writeFile(fixture.source,prior+'\n// Owned source changed after compile\n');
  const future=new Date(Date.now()+5000);
  await fs.utimes(fixture.source,future,future);
  assert.deepEqual(await complete(fixture.files.get('custom-tag')),[]);
  assert.ok((await complete(fixture.files.get('builtin-tag'))).some(item=>item.name==='Label'));
  const paired=await Promise.all([springProof(mysql,'mysql'),springProof(mariadb,'mariadb')]);
  const receipt=process.env.ROCKETBRAIN_FXML_COMPLETION_RECEIPT;
  if (receipt) await fs.writeFile(receipt,JSON.stringify({headless:true,runtime:'26.0.2+3',actualGradle:true,
    actualJdt:true,loadedCompletedBuiltIn:true,loadedCompletedCustom:true,exactRanges:true,booleanValue:true,
    readOnlyAndInvalidContextsRefused:true,staleWorkspaceClassRefused:true,openJfxClassStillOffered:true,
    paired,sourceCommit:process.env.GITHUB_SHA},null,2)+'\n',{flag:'wx'});
});
