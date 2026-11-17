'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{pathToFileURL}=require('node:url');
const {StdioLsp,until}=require('./helpers/stdio-lsp');
const {resolveLaunch,serverSettings}=require('../src/java/runtime');
(async()=>{
 const config=JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_JAVA_TEST_CONFIG||'test-output/v0.4-java-host-runtime.json'));
 const prefix=process.env.ROCKETBRAIN_TEST_REPORT_PREFIX||'v0.19',base=path.resolve('test-output',prefix+'-java-move-probe',crypto.randomUUID()),root=path.join(base,'project');
 const source=path.join(root,'src/main/java/fixture/source'),target=path.join(root,'src/main/java/fixture/target');fs.mkdirSync(source,{recursive:true});fs.mkdirSync(target,{recursive:true});
 fs.writeFileSync(path.join(root,'pom.xml'),'<project xmlns="http://maven.apache.org/POM/4.0.0"><modelVersion>4.0.0</modelVersion><groupId>fixture</groupId><artifactId>move</artifactId><version>1</version><properties><maven.compiler.release>25</maven.compiler.release></properties></project>');
 const file=path.join(source,'MoveMe.java'),destination=path.join(target,'MoveMe.java'),caller=path.join(target,'Caller.java');
 fs.writeFileSync(file,'package fixture.source; public class MoveMe { public static int value() { return 42; } }\n');
 fs.writeFileSync(caller,'package fixture.target; import fixture.source.MoveMe; public class Caller { public static void main(String[] args) { System.out.println(MoveMe.value()); } }\n');
 const rootUri=pathToFileURL(root).href,uri=pathToFileURL(file).href,lsp=new StdioLsp(resolveLaunch({javaHome:config.javaHome,serverPath:config.serverPath,storagePath:path.join(base,'jdt')}));
 try{
  const init=await lsp.request('initialize',{processId:process.pid,rootUri,workspaceFolders:[{uri:rootUri,name:'move-probe'}],capabilities:{workspace:{configuration:true,applyEdit:false,workspaceEdit:{documentChanges:true,resourceOperations:['rename','create','delete']},fileOperations:{willRename:true}},textDocument:{}},initializationOptions:{bundles:[],workspaceFolders:[rootUri],settings:serverSettings([{name:'JavaSE-25',path:config.javaHome,default:true}])}},90000);lsp.notify('initialized',{});
  lsp.notify('textDocument/didOpen',{textDocument:{uri,languageId:'java',version:1,text:fs.readFileSync(file,'utf8')}});
  await until(async()=>{const d=await lsp.request('textDocument/documentSymbol',{textDocument:{uri}});return d?.length?d:false;});
  const metadata=await lsp.request('workspace/executeCommand',{command:'java.project.getSettings',arguments:[uri,['org.eclipse.jdt.ls.core.sourcePaths']]});
  const classpaths=await lsp.request('workspace/executeCommand',{command:'java.project.getClasspaths',arguments:[uri,{scope:'runtime'}]});
  const edit=await lsp.request('workspace/willRenameFiles',{files:[{oldUri:uri,newUri:pathToFileURL(destination).href}]});
  const report={asOf:new Date().toISOString(),root,source:file,destination,caller,capabilities:init.capabilities,metadata,classpaths,edit};fs.writeFileSync(path.resolve('test-output',prefix+'-java-move-probe.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({root,metadata,classpaths,edit}));
 }finally{await lsp.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
