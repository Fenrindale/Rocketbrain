'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {buildObserver}=require('../../scripts/jpa-observer-build');
const sources=require('./observer-sources.json');
const {pathToFileURL}=require('node:url');
async function prepareObserver(context,vscode,options={}){
  if(!vscode.workspace.isTrusted)throw new Error('Trust this workspace before preparing a Java agent.');
  const javaHome=options.javaHome||vscode.workspace.getConfiguration('rocketbrain.java').get('javaHome');
  if(!javaHome)throw new Error('Set Rocketbrain Java Home to an independent full JDK25 or newer.');
  const root=path.join(context.globalStorageUri.fsPath,'jpa-observer'),target=path.join(root,'0.7.0');
  const built=await buildObserver({target,javaHome,sources});
  const instance=path.join(root,'launch-'+crypto.randomUUID());await fs.mkdir(instance,{recursive:true});
  const tokenFile=path.join(instance,'token'),descriptorFile=path.join(instance,'connection.json'),configFile=path.join(instance,'observer.json');
  await fs.writeFile(tokenFile,crypto.randomBytes(32).toString('hex'),{flag:'wx',mode:0o600});
  await fs.writeFile(configFile,JSON.stringify({tokenFile,descriptorFile,port:0,queries:false,validate:true},null,2),{flag:'wx',mode:0o600});
  return {jar:built.jarPath,sha256:built.sha256,requiresJava:25,jvmArguments:['-javaagent:'+built.jarPath+'=config='+pathToFileURL(configFile).href,'--add-modules=jdk.httpserver'],configFile,tokenFile,descriptorFile,queryCaptureEnabled:false,
    instructions:'Add the JVM argument to your application launch and restart it. Read connection.json for the local URL; connect using the private token. Set queries=true before launch only to capture query text. Bound values are never collected. Validation invokes the configured provider compiler; custom provider callbacks can run. No universal arbitrary-code analysis is claimed.'};
}
module.exports={prepareObserver};
