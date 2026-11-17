'use strict';
const fs=require('node:fs'),path=require('node:path'),{pathToFileURL}=require('node:url');
const {StdioLsp,positionOf,until}=require('./helpers/stdio-lsp');
const {resolveLaunch,serverSettings}=require('../src/java/runtime');
(async()=>{
 const config=JSON.parse(fs.readFileSync(path.resolve('test-output/v0.4-java-host-runtime.json'))),root=path.resolve('test/fixtures/java/maven'),rootUri=pathToFileURL(root).href;
 const lsp=new StdioLsp(resolveLaunch({javaHome:config.javaHome,serverPath:config.serverPath,storagePath:path.resolve('test-output/v0.10-java-refactor-probe')}));
 try{
  const init=await lsp.request('initialize',{processId:process.pid,rootUri,workspaceFolders:[{uri:rootUri,name:'refactor-fixture'}],capabilities:{workspace:{configuration:true,applyEdit:true,workspaceEdit:{documentChanges:true}},textDocument:{codeAction:{codeActionLiteralSupport:{codeActionKind:{valueSet:['quickfix','refactor','refactor.extract','refactor.inline','refactor.rewrite','source','source.organizeImports']}},resolveSupport:{properties:['edit']}}}},initializationOptions:{bundles:[],workspaceFolders:[rootUri],settings:serverSettings([{name:'JavaSE-25',path:config.javaHome,default:true}]),extendedClientCapabilities:{advancedExtractRefactoringSupport:false,advancedOrganizeImportsSupport:false}}},90000);
  lsp.notify('initialized',{});const file=path.join(root,'src/main/java/dev/rocketbrain/RefactorFixture.java'),uri=pathToFileURL(file).href,text=fs.readFileSync(file,'utf8');lsp.notify('textDocument/didOpen',{textDocument:{uri,languageId:'java',version:1,text}});
  await until(async()=>{const d=await lsp.request('textDocument/documentSymbol',{textDocument:{uri}});return d?.length?d:false;});
  const results=[];
  for(const [name,marker,only]of [['extract','value * 2 + 3',['refactor']],['inline','doubled =',['refactor.inline']],['imports','import java.util.List;',['source.organizeImports']]]){
   const start=positionOf(text,marker),end={line:start.line,character:start.character+(name==='extract'?marker.length:name==='inline'?7:0)};
   const actions=await lsp.request('textDocument/codeAction',{textDocument:{uri},range:{start,end},context:{diagnostics:[],only}});const entries=[];
   for(let action of actions||[]){if(action.data&&!action.edit)try{action=await lsp.request('codeAction/resolve',action);}catch(error){entries.push({title:action.title,error:error.message});continue;}entries.push({title:action.title,kind:action.kind,command:action.command,edit:action.edit,data:action.data});}
   results.push({name,actions:entries});
  }
  fs.writeFileSync(path.resolve('test-output/'+(process.env.ROCKETBRAIN_TEST_REPORT_PREFIX||"v0.10")+'-java-refactor-probe.json'),JSON.stringify({capabilities:init.capabilities,results},null,2)+'\n');console.log(JSON.stringify(results.map(r=>({name:r.name,actions:r.actions.map(a=>({title:a.title,kind:a.kind,command:a.command,hasEdit:!!a.edit,error:a.error}))}))));
 }finally{await lsp.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
