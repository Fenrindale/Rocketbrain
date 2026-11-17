'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{pathToFileURL}=require('node:url');
const {StdioLsp,positionOf,until}=require('./helpers/stdio-lsp');
const {resolveLaunch,serverSettings}=require('../src/java/runtime');
async function probe(){
 const prefix=process.env.ROCKETBRAIN_TEST_REPORT_PREFIX||'v0.19',base=path.resolve('test-output/'+prefix+'-signature-probe'),root=path.join(base,'project');
 fs.mkdirSync(path.join(root,'src/main/java/fixture'),{recursive:true});fs.copyFileSync(path.resolve('test/fixtures/java/maven/pom.xml'),path.join(root,'pom.xml'));
 const file=path.join(root,'src/main/java/fixture/Signature.java'),text='package fixture;\npublic final class Signature {\n public static String render(String label, int count) { return label + count; }\n public static String caller() { return render("value", 3); }\n}\n';fs.writeFileSync(file,text);
 const config=JSON.parse(fs.readFileSync(path.resolve(process.env.ROCKETBRAIN_JAVA_TEST_CONFIG||'test-output/v0.4-java-host-runtime.json'))),rootUri=pathToFileURL(root).href,uri=pathToFileURL(file).href;
 const lsp=new StdioLsp(resolveLaunch({javaHome:config.javaHome,serverPath:config.serverPath,storagePath:path.join(base,'jdt')}));
 try{
  await lsp.request('initialize',{processId:process.pid,rootUri,workspaceFolders:[{uri:rootUri,name:'signature-fixture'}],capabilities:{workspace:{configuration:true,applyEdit:false,workspaceEdit:{documentChanges:true}},textDocument:{documentSymbol:{hierarchicalDocumentSymbolSupport:true}}},initializationOptions:{bundles:[],workspaceFolders:[rootUri],settings:serverSettings([{name:'JavaSE-25',path:config.javaHome,default:true}])}},90000);lsp.notify('initialized',{});lsp.notify('textDocument/didOpen',{textDocument:{uri,languageId:'java',version:1,text}});
  const symbols=await until(async()=>{const x=await lsp.request('textDocument/documentSymbol',{textDocument:{uri}});return x?.length?x:false;});
  const start=positionOf(text,'render(String'),context={textDocument:{uri},range:{start,end:start},context:{diagnostics:[]}};
  const info=await lsp.request('java/getChangeSignatureInfo',context);assert.ok(info?.methodIdentifier,JSON.stringify(info));
  const reordered=[info.parameters[1],info.parameters[0]],added=[...info.parameters,{type:'String',name:'suffix',defaultValue:'"!"',originalIndex:-1}];const results=[];
  for(const [name,parameters]of [['reorder',reordered],['add',added],['remove',[info.parameters[0]]]]){const response=await lsp.request('java/getRefactorEdit',{command:'changeSignature',context,commandArguments:[info.methodIdentifier,false,info.methodName,info.modifier,info.returnType,parameters,info.exceptions,true]});results.push({name,response});}
  const report={asOf:new Date().toISOString(),apiVersion:'Eclipse JDT LS 1.63.0',symbols,info,results,notifications:lsp.notifications.filter(x=>x.method==='window/showMessage')};fs.writeFileSync(path.resolve('test-output/'+prefix+'-java-change-signature-probe.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
 }finally{await lsp.close();}
}
if(require.main===module)probe().catch(e=>{console.error(e);process.exitCode=1;});
module.exports={probe};
