'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');
const { targetsIn, propertyReplacement } = require('../src/java/javafx-preview-properties');
const { registerJavaFx } = require('../src/java/javafx-vscode');
const { exerciseJavaFxProperties, runJavaFxPropertyChecks } = require('./javafx-properties-host');

test('FX property editing uses exact single or double quoted literal value spans only', () => {
  const xml = '<Pane xmlns:fx="http://javafx.com/fxml/1" fx:controller="demo.Demo" stylesheets="@theme.css">' +
    '<Label fx:id="label" text=\'old &amp; new\' onMouseClicked="#test"/>' +
    '<Rectangle fx:id="body" layoutX="1" width="16" fill="#0088ff"/>' +
    '<Rectangle fx:id="duplicate" width="3"/><Label fx:id="duplicate" text="First"/>' +
    '<Text fx:id="bound" text="${bindings.title}"/><fx:include fx:id="sub" source="another.fxml"/>' +
    '<Label xmlns="urn:demo" fx:id="foreign" text="Custom"/></Pane>';
  assert.deepEqual(targetsIn(xml).map(({id,properties})=>[id,properties.map(({name})=>name)]),
    [['label',['text']], ['body',['layoutX','width','fill']]]);
  const text = propertyReplacement(xml,{id:'label',property:'text',value:'A\' & B < C > D'});
  assert.equal(text.text,xml.replace('old &amp; new','A&apos; &amp; B &lt; C &gt; D'));
  assert.equal(text.before,'old & new');
  const moved = propertyReplacement(xml,{id:'body',property:'layoutX',value:'-20.5'});
  assert.equal(moved.text,xml.replace('layoutX="1"','layoutX="-20.5"'));
  for (const [id,property,value] of [
    ['body','width','1e6'], ['body','width','-1'], ['body','width','4097'], ['body','fill','url(remote)'],
    ['body','fill','#ff0000\n'], ['body','fx:id','x'], ['label','text','@asset'], ['label','text','\tx'],
    ['label','text','${other}'], ['label','onMouseClicked','#other'], ['label','text','a'.repeat(513)],
    ['duplicate','text','Second'], ['bound','text','literal'], ['sub','source','other.fxml']
  ]) assert.throws(()=>propertyReplacement(xml,{id,property,value}),/supported existing static FXML property/u);
});

function headlessHost(folder, javaHome) {
  const documents = [], handlers = new Map();
  const disposable = () => ({dispose(){}});
  const noop = disposable;
  const file = filename => ({scheme:'file',authority:'',fsPath:filename,toString:()=>pathToFileURL(filename).href});
  const uri = file(folder), root = {uri};
  const errors = [];
  return {
    errors, Uri:{file}, ViewColumn:{Beside:1}, ProgressLocation:{Notification:1}, DiagnosticSeverity:{Warning:1},
    Diagnostic: class { constructor(range, message){Object.assign(this,{range,message});} },
    Range: class { constructor(start, end){Object.assign(this,{start,end});} },
    workspace:{
      isTrusted:true, workspaceFolders:[root], textDocuments:documents, getWorkspaceFolder:()=>root,
      getConfiguration:()=>({get:()=>javaHome}), onDidChangeWorkspaceFolders:noop,
      onDidCloseTextDocument:noop, onDidSaveTextDocument:noop, onDidOpenTextDocument:noop,
      async openTextDocument(uri) {
        const opened = documents.find(item=>item.uri.fsPath===uri.fsPath);
        if (opened) return opened;
        let contents = await fs.readFile(uri.fsPath,'utf8');
        const document = {uri,fileName:uri.fsPath,version:1,isDirty:false,isClosed:false,
          positionAt:offset=>offset,getText:()=>contents,
          replace(start,end,value){contents=contents.slice(0,start)+value+contents.slice(end);document.version++;document.isDirty=true;},
          async save(){await fs.writeFile(uri.fsPath,contents);document.isDirty=false;return true;}};
        documents.push(document);
        return document;
      }
    },
    languages:{
      createDiagnosticCollection:()=>({set(){},delete(){},...disposable()}),
      registerDefinitionProvider:noop, registerDocumentSymbolProvider:noop
    },
    commands:{
      registerCommand(name,invoke){handlers.set(name,invoke);return disposable();},
      executeCommand(name,...args){return handlers.get(name)(...args);}
    },
    window:{
      tabGroups:{all:[]},
      showErrorMessage(message){errors.push(message);},
      async showTextDocument(document){
        return {document,edit:async callback=>{
          callback({replace:(range,value)=>document.replace(range.start,range.end,value)});
          return true;
        }};
      },
      showQuickPick:async items=>items.find(item=>item.label==='fill'),
      showInputBox:async()=> '#44cc66',
      withProgress:async (_,run)=>run(undefined,{}),
      createWebviewPanel(viewType,_title,_location,options){
        assert.equal(options.enableScripts,false);
        let dispose;
        return {viewType,webview:{html:''},onDidDispose(onDispose){dispose=onDispose;},dispose:()=>dispose?.()};
      }
    }
  };
}

test('normal preview review/apply uses real OpenJFX and the owned Spring database fixture', {
  skip:process.platform!=='win32'||process.arch!=='x64'||
    !process.env.ROCKETBRAIN_JAVAFX_PREVIEW_GLOBAL_STORAGE||!process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG||
    !process.env.ROCKETBRAIN_JAVA_TEST_CONFIG, timeout:190000
}, async t => {
  const parent = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(parent,'rb-fxml-headless-'));
  t.after(async()=>{
    const actual = await fs.realpath(root);
    assert.equal(path.dirname(actual),parent);
    assert.ok(path.basename(actual).startsWith('rb-fxml-headless-'));
    await fs.rm(actual,{recursive:true,force:true,maxRetries:8,retryDelay:250});
  });
  const storage = process.env.ROCKETBRAIN_JAVAFX_PREVIEW_GLOBAL_STORAGE;
  const { javaHome } = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_JAVA_TEST_CONFIG,'utf8'));
  const host = headlessHost(root,javaHome);
  const fx = registerJavaFx(host,{java:{getState:()=>({javaHome})},context:{globalStorageUri:{fsPath:storage}}});
  t.after(()=>fx.dispose());
  const ui = await exerciseJavaFxProperties(fx,host,root,{normalEditLink:true});
  assert.equal(host.errors.length,0);
  const nativeHook = await runJavaFxPropertyChecks({java:{fx}},host,[]);
  assert.deepEqual(nativeHook.jdbc,{people:2,departments:1,rolledBackNames:0});
  assert.equal(nativeHook.layoutImage,ui.layoutImage);
  const receipt = process.env.ROCKETBRAIN_JAVAFX_PROPERTY_RECEIPT;
  if (receipt) await fs.writeFile(receipt,JSON.stringify({...nativeHook,headlessCommandRoutes:true,
    engine:process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE,sourceCommit:process.env.GITHUB_SHA},null,2)+'\n',{flag:'wx'});
});
