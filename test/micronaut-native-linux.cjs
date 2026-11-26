'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');
const { COMMANDS, registerMicronautWorkbench } = require('../src/java/micronaut-vscode');
const { nativeElfHeader } = require('../src/java/linux-native-executable');
const { sha256, assertNoCredential, readProbe, startSpring } = require('./quarkus-native-linux.cjs');

const fixture=path.resolve(__dirname,'fixtures/java/micronaut-native-linux');
const springRoot=path.resolve(__dirname,'fixtures/java/quarkus-native-linux/spring');
const output=path.resolve(__dirname,'../test-output/micronaut-native-linux');

function workbench(project,tools,log) {
  const disposable=()=>({dispose(){}}), commands=new Map(), errors=[];
  const uri={scheme:'file',fsPath:project.root};
  let approved=false;
  const vscode={
    Uri:{parse:()=>uri},ProgressLocation:{Notification:15},
    workspace:{isTrusted:true,workspaceFolders:[project.uri],textDocuments:[],getConfiguration:()=>({get:key=>tools[key]})},
    window:{activeTextEditor:{document:{uri}},createOutputChannel:()=>({append:log,appendLine:line=>log(line+'\n'),show(){},dispose(){}}),
      withProgress:(_options,operation)=>operation({},new AbortController().signal),
      showQuickPick:async items=>items[0],showWarningMessage:async(_prompt,_options,action)=>approved?action:undefined,
      showInformationMessage:async()=>undefined,showErrorMessage:async message=>{errors.push(message);}},
    commands:{registerCommand(name,operation){commands.set(name,operation);return disposable();}},
    languages:{registerCompletionItemProvider:disposable,registerDefinitionProvider:disposable}
  };
  const service=registerMicronautWorkbench(vscode,{workbench:{getSnapshot:()=>({projects:[project]})}});
  async function execute(command) {
    assert.ok(commands.has(command));
    const result=await commands.get(command)();
    if (errors.length) throw Error(errors.shift());
    return result;
  }
  return {service,execute,approve(){approved=true;},trust(value){vscode.workspace.isTrusted=value;}};
}

async function main() {
  assert.deepEqual([process.platform,process.arch,process.env.ROCKETBRAIN_NATIVE_LINUX_FIXTURE],['linux','x64','1']);
  const graalHome=await fs.realpath(process.env.ROCKETBRAIN_GRAALVM_HOME);
  const mavenHome=await fs.realpath(process.env.ROCKETBRAIN_MAVEN_HOME);
  const user=process.env.RB_NATIVE_DB_USER, password=process.env.RB_NATIVE_DB_PASSWORD;
  assert.equal(user,'rb_native');
  assert.ok(password&&password.length>=16);
  delete process.env.RB_NATIVE_DB_USER;
  delete process.env.RB_NATIVE_DB_PASSWORD;
  const root=await fs.realpath(fixture), uri=pathToFileURL(root).href;
  const springJar=path.join(springRoot,'target','spring-native-comparison-1.0.0.jar');
  let log='';
  const host=workbench({root,uri,tool:'maven',name:'Micronaut native fixture',jdk:graalHome},
    {micronautGraalvmHome:graalHome,mavenHome},chunk=>{log=(log+chunk).slice(-26000);});
  const {service}=host, input={projectUri:uri,allowProjectExecution:true};
  let spring;
  try {
    assert.equal(await host.execute(COMMANDS.buildNative),undefined);
    await assert.rejects(fs.lstat(path.join(root,'target')),{code:'ENOENT'});
    host.trust(false);
    await assert.rejects(service.buildNative(input),/Trust the local workspace/u);
    host.trust(true);
    await assert.rejects(service.runNative(input),/native image changed/u);
    host.approve();
    const built=await host.execute(COMMANDS.buildNative);
    assert.equal(built.micronautVersion,'5.2.8');
    assert.match(built.nativeImageVersion,/25\.(?:5\.5|0\.5)\.0\.3/u);
    assert.deepEqual([built.state,built.platform,built.architecture],['succeeded','linux','x64']);
    assert.equal(path.basename(built.artifact),'micronaut-native-linux');
    assert.match(path.basename(path.dirname(built.artifact)),/^rocketbrain-micronaut-native-/u);
    assert.equal(path.dirname(path.dirname(built.artifact)),path.join(root,'target'));
    assert.equal(await sha256(built.artifact),built.sha256);
    const file=await fs.open(built.artifact,'r');
    try {
      const header=Buffer.alloc(64);
      assert.equal((await file.read(header,0,header.length,0)).bytesRead,header.length);
      assert.ok(nativeElfHeader(header,'x64'));
    } finally { await file.close(); }
    await assert.rejects(service.runNative({...input,buildId:'wrong build'}),/native image changed/u);
    await assert.rejects(service.runNative({...input,environment:'dev,other'}),/literal Micronaut environment/u);

    Object.assign(process.env,{RB_NATIVE_DB_USER:user,RB_NATIVE_DB_PASSWORD:password,
      RB_NATIVE_MYSQL_URL:'jdbc:mysql://127.0.0.1:43306/rocketbrain_native?allowPublicKeyRetrieval=true&sslMode=DISABLED',
      RB_NATIVE_MARIADB_URL:'jdbc:mariadb://127.0.0.1:43307/rocketbrain_native?sslMode=disable'});
    spring=await startSpring(path.join(graalHome,'bin','java'),springJar,springRoot);
    const engines=['mysql','mariadb'], seeded=await Promise.all(engines.map(engine=>readProbe(spring.baseUrl,engine)));
    const app=await host.execute(COMMANDS.runNative);
    assert.deepEqual([app.mode,app.state,app.environment,app.listenerVerified],['native','running','dev',true]);
    assert.equal(app.sha256,built.sha256);
    assert.equal(await fs.realpath('/proc/'+app.pid+'/exe'),built.artifact);
    const environment=await fetch(app.baseUrl+'/probe/environment',{signal:AbortSignal.timeout(5000)});
    assert.equal(environment.status,200);
    assert.equal((await environment.text()).trim(),'dev');
    assert.equal(service.getState().pid,app.pid);
    const native=await Promise.all(engines.map(engine=>readProbe(app.baseUrl,engine)));
    for (const [index,engine] of engines.entries()) {
      assert.equal(seeded[index].runtime,'spring',engine);
      assert.deepEqual(native[index],{...seeded[index],runtime:'runtime'},engine);
    }
    assert.equal((await host.execute(COMMANDS.stop)).state,'stopped');
    assert.throws(()=>process.kill(app.pid,0),{code:'ESRCH'});
    await assert.rejects(fetch(app.baseUrl+'/probe/mysql',{signal:AbortSignal.timeout(1500)}));
    await spring.stop();
    spring=undefined;

    await fs.mkdir(output,{recursive:true});
    const image=path.join(output,'micronaut-native-linux-x64'), springOutput=path.join(output,'spring-jdbc-fixture.jar');
    await fs.copyFile(built.artifact,image);
    await fs.copyFile(springJar,springOutput);
    await Promise.all([assertNoCredential(image,password),assertNoCredential(springOutput,password)]);
    assert.equal(await sha256(image),built.sha256);
    const modified=await fs.open(built.artifact,'r+');
    try {
      const byte=Buffer.alloc(1), offset=built.size-1;
      assert.equal((await modified.read(byte,0,1,offset)).bytesRead,1);
      byte[0]^=1;
      assert.equal((await modified.write(byte,0,1,offset)).bytesWritten,1);
      await modified.sync();
    } finally { await modified.close(); }
    await assert.rejects(service.runNative({...input,buildId:built.id}),/native image changed/u);
    const commit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
    if (process.env.GITHUB_SHA) assert.equal(commit,process.env.GITHUB_SHA);
    const receipt={commit,platform:'linux',architecture:'x64',micronaut:built.micronautVersion,
      nativeImage:built.nativeImageVersion,nativeElf:{sha256:built.sha256,bytes:built.size},
      springJar:{sha256:await sha256(springOutput),bytes:(await fs.stat(springOutput)).size},
      databases:Object.fromEntries(engines.map((engine,index)=>[engine,{spring:seeded[index],native:native[index]}])),
      buildCommand:true,runCommand:true,stopCommand:true,environmentSelected:true,explicitApproval:true,untrustedRefused:true,
      nativeProcessAndListenerVerified:true,stoppedAndListenerClosed:true,staleFileRefused:true,wrongBuildRefused:true,
      uploadCredentialChecked:true};
    const body=JSON.stringify(receipt,null,2)+'\n';
    assert.ok(!body.includes(password));
    await fs.writeFile(path.join(output,'receipt.json'),body,{flag:'wx'});
    console.log(body);
  } catch (error) {
    throw Error((error.stack+'\n'+log).replaceAll(password,'[redacted]'));
  } finally {
    try { await spring?.stop(); } finally { await service.dispose(); }
    for (const name of ['RB_NATIVE_DB_USER','RB_NATIVE_DB_PASSWORD','RB_NATIVE_MYSQL_URL','RB_NATIVE_MARIADB_URL']) delete process.env[name];
  }
}

if (require.main===module) main().catch(error=>{console.error(error.message);process.exitCode=1;});
