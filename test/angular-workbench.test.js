'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {EventEmitter}=require('node:events');
const {createRequire}=require('node:module');
const {pathToFileURL}=require('node:url');
const {test}=require('node:test');
const {registerAngularWorkbench}=require('../src/web/angular-vscode');
const {validRange,definitionsOf}=require('../src/web/angular-lsp');
const {ownedAngularFixture}=require('./helpers/angular-workspace-fixture');
const {exerciseAngular}=require('./angular-workbench-host');
const {jdbcReadback}=require('./java-source-analysis-host');

test('Angular editor rejects reversed, external, and out-of-document locations',async()=>{
  const point=(line,character)=>({line,character});
  assert.equal(validRange({start:point(0,2),end:point(1,3)},'hi\r\nend'),true);
  assert.equal(validRange({start:point(0,3),end:point(0,4)},'hi\nend'),false);
  assert.equal(validRange({start:point(0,2),end:point(0,1)},'hi\nend'),false);
  assert.deepEqual(await definitionsOf([{targetUri:'https://example.invalid/redirect.ts'},{uri:'untitled:/workspace.ts'},
    {uri:pathToFileURL(__filename).href,range:{start:point(0,1),end:point(0,2)}}],
    {root:path.resolve(__dirname,'fixtures/angular-workbench')},new Map()),[]);
});

function headless(root,node) {
  const events=new EventEmitter(), commands=new Map(), documents=[], problems=new Map();
  const noop={dispose(){}};
  const uri=file=>({scheme:'file',authority:'',fsPath:file,toString:()=>pathToFileURL(file).href});
  const approved={uri:uri(root),name:path.basename(root)};
  const listen=(type,action)=>{
    events.on(type,action);
    return {dispose(){events.removeListener(type,action);}};
  };
  class Range {
    constructor(a,b,c,d) {
      this.start=typeof a==='number'?{line:a,character:b}:a;
      this.end=typeof a==='number'?{line:c,character:d}:b;
    }
  }
  const vscode={
    Range,Uri:{file:uri},RelativePattern:class{},
    DiagnosticSeverity:{Error:0,Warning:1,Information:2},
    Diagnostic:class{constructor(range,message,severity){Object.assign(this,{range,message,severity});}},
    Location:class{constructor(uri,range){Object.assign(this,{uri,range});}},
    Hover:class{constructor(value){this.contents=[value];}},
    MarkdownString:class{value='';appendText(text){this.value+=text;}},
    ProgressLocation:{Notification:1},
    workspace:{
      isTrusted:true,workspaceFolders:[approved],textDocuments:documents,
      getWorkspaceFolder(value){const rel=path.relative(root,value.fsPath);return rel==='..'||rel.startsWith('..'+path.sep)?undefined:approved;},
      getConfiguration:()=>({get:()=>node}),
      createFileSystemWatcher:()=>({onDidCreate:()=>noop,onDidChange:()=>noop,onDidDelete:()=>noop,dispose(){}}),
      onDidChangeTextDocument:action=>listen('change',action),
      onDidCloseTextDocument:action=>listen('close',action),
      onDidChangeWorkspaceFolders:action=>listen('folders',action),
      async openTextDocument(value){
        const present=documents.find(item=>item.uri.fsPath===value.fsPath);
        if(present)return present;
        let content=await fs.readFile(value.fsPath,'utf8');
        const offsetAt=({line,character})=>content.split('\n').slice(0,line).reduce((sum,line)=>sum+line.length+1,0)+character;
        const document={uri:value,version:1,isClosed:false,isDirty:false,
          getText:range=>range?content.slice(offsetAt(range.start),offsetAt(range.end)):content,offsetAt,
          positionAt(offset){const lines=content.slice(0,offset).split('\n');return {line:lines.length-1,character:lines.at(-1).length};},
          apply(range,text){content=content.slice(0,offsetAt(range.start))+text+content.slice(offsetAt(range.end));
            this.version++;this.isDirty=true;events.emit('change',{document:this});},
          async save(){await fs.writeFile(value.fsPath,content);this.isDirty=false;return true;}
        };
        documents.push(document);
        return document;
      }
    },
    window:{
      showTextDocument:async document=>({document,async edit(operation){operation({replace:(range,text)=>document.apply(range,text)});return true;}}),
      showInformationMessage:async(_message,_options,choice)=>choice,
      showErrorMessage:message=>{throw Error(message);},
      withProgress:async(_options,operation)=>operation(undefined,{})
    },
    languages:{
      getDiagnostics:value=>problems.get(value.toString())||[],
      createDiagnosticCollection:()=>({clear(){problems.clear();},set(groups){for(const [uri,records] of groups)problems.set(uri.toString(),records);},dispose(){problems.clear();}}),
      registerDefinitionProvider(_selector,provider){commands.set('vscode.executeDefinitionProvider',async(value,position)=>
        provider.provideDefinition(await vscode.workspace.openTextDocument(value),position,{}));return noop;},
      registerHoverProvider(_selector,provider){commands.set('vscode.executeHoverProvider',async(value,position)=>{
        const result=await provider.provideHover(await vscode.workspace.openTextDocument(value),position,{});
        return result?[result]:[];
      });return noop;}
    },
    commands:{registerCommand(name,action){commands.set(name,action);return noop;},
      executeCommand(name,...args){return commands.get(name)(...args);}}
  };
  return vscode;
}

const fixture=process.env.ROCKETBRAIN_ANGULAR_FIXTURE,node=process.env.ROCKETBRAIN_ANGULAR_NODE_PATH;
test('reviewed Angular normal providers use the installed vendor service and strict compiler in the real Spring workflow',{
  skip:!fixture||!node||!process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, timeout:90000
},async t=>{
  const root=await ownedAngularFixture(fixture);
  const vscode=headless(root,node), protocol=createRequire(require.resolve('vscode-languageclient/node'))('vscode-languageserver-protocol/node');
  const service=registerAngularWorkbench({subscriptions:[]},vscode,{protocol:()=>protocol});
  t.after(()=>service.dispose());
  const uri=vscode.Uri.file(path.join(root,'src/dashboard.component.html'));
  await assert.rejects(service.start({uri}),/Review and start/u);
  await assert.rejects(service.start({uri,allowAnalysis:true,expectedFingerprint:'changed'}),/changed after review/u);
  vscode.workspace.isTrusted=false;
  await assert.rejects(service.start({uri,allowAnalysis:true}),/Trust this local workspace/u);
  vscode.workspace.isTrusted=true;
  const result=await exerciseAngular(service,vscode,root), jdbc=await jdbcReadback();
  assert.ok(jdbc);
  const receipt=process.env.ROCKETBRAIN_ANGULAR_TEST_RECEIPT;
  if(receipt)await fs.writeFile(receipt,JSON.stringify({...result,jdbc,headlessProvider:true,
    ownedLanguageServerStopped:true,engine:process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE,sourceCommit:process.env.GITHUB_SHA},null,2)+'\n',{flag:'wx'});
});
