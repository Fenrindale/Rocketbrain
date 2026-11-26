'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {execFileSync}=require('node:child_process');
const {COMMANDS,registerQuarkusWorkbench}=require('../src/java/quarkus-vscode');
const {sha256,assertNoCredential,readProbe,startSpring}=require('./quarkus-native-linux.cjs');

const fixture=path.resolve(__dirname,'fixtures/java/quarkus-native-gradle-linux');
const springRoot=path.resolve(__dirname,'fixtures/java/quarkus-native-linux/spring');
const output=path.resolve(__dirname,'../test-output/quarkus-gradle-native-linux');

function workbench(project,tools,log){
  const disposable=()=>({dispose(){}}), commands=new Map(), errors=[];
  const uri={scheme:'file',fsPath:project.root};
  let review, decision;
  const vscode={
    ProgressLocation:{Notification:15},
    workspace:{isTrusted:true,workspaceFolders:[project.uri],textDocuments:[],getConfiguration:()=>({get:key=>tools[key]})},
    window:{activeTextEditor:{document:{uri}},createOutputChannel:()=>({append:log,show(){},dispose(){}}),
      withProgress:(_options,operation)=>operation({},new AbortController().signal),
      async showWarningMessage(_prompt,options,action){review=options.detail;return decision?.(action);},
      showInformationMessage:async()=>undefined,showErrorMessage:async message=>errors.push(message)},
    commands:{registerCommand(name,operation){commands.set(name,operation);return disposable();}},
    languages:{registerCompletionItemProvider:disposable,registerDefinitionProvider:disposable},
    debug:{onDidStartDebugSession:disposable,onDidTerminateDebugSession:disposable}
  };
  const service=registerQuarkusWorkbench(vscode,{workbench:{getSnapshot:()=>({projects:[project]})}});
  async function execute(command){
    assert.ok(commands.has(command));
    const result=await commands.get(command)();
    if(errors.length)throw Error(errors.shift());
    return result;
  }
  return {service,execute,lastReview:()=>review,decide(value){decision=value;},trust(value){vscode.workspace.isTrusted=value;}};
}

async function main(){
  assert.deepEqual([process.platform,process.arch,process.env.ROCKETBRAIN_NATIVE_LINUX_FIXTURE],['linux','x64','1']);
  const graalHome=await fs.realpath(process.env.ROCKETBRAIN_GRAALVM_HOME);
  const gradleHome=await fs.realpath(process.env.ROCKETBRAIN_GRADLE_HOME);
  const user=process.env.RB_NATIVE_DB_USER,password=process.env.RB_NATIVE_DB_PASSWORD;
  assert.equal(user,'rb_native');
  assert.ok(password&&password.length>=16);
  delete process.env.RB_NATIVE_DB_USER;
  delete process.env.RB_NATIVE_DB_PASSWORD;
  const root=await fs.realpath(fixture),uri=pathToFileURL(root).href;
  const springJar=path.join(springRoot,'target','spring-native-comparison-1.0.0.jar');
  const settings=path.join(root,'src/main/resources/application.properties'), original=await fs.readFile(settings);
  const changed=Buffer.concat([original,Buffer.from('\n# Saved source changed after review.\n')]);
  const sentinel=path.join(root,'build','ordinary-build-stays.txt');
  await fs.mkdir(path.dirname(sentinel));
  await fs.writeFile(sentinel,'existing normal build\n',{flag:'wx'});
  let log='';
  const host=workbench({root,uri,tool:'gradle',name:'Owned Gradle Quarkus project'},
    {quarkusGraalvmHome:graalHome,gradleHome},chunk=>{log=(log+chunk).slice(-26000);});
  const {service}=host,input={projectUri:uri,allowProjectExecution:true};
  let spring;
  try{
    assert.equal(await host.execute(COMMANDS.buildNative),undefined);
    assert.deepEqual(await fs.readdir(path.dirname(sentinel)),['ordinary-build-stays.txt']);
    host.trust(false);
    await assert.rejects(service.buildNative(input),/Trust the local workspace/u);
    host.trust(true);
    await assert.rejects(service.runNative(input),/native image changed/u);
    host.decide(async action=>{await fs.writeFile(settings,changed);return action;});
    await assert.rejects(host.execute(COMMANDS.buildNative),/native image changed/u);
    assert.deepEqual(await fs.readdir(path.dirname(sentinel)),['ordinary-build-stays.txt']);
    await fs.writeFile(settings,original);
    host.decide(action=>action);
    const built=await host.execute(COMMANDS.buildNative);
    assert.deepEqual([built.state,built.tool,built.task,built.quarkusVersion,built.platform,built.architecture],
      ['succeeded','gradle',':quarkusBuild','3.40.1.2','linux','x64']);
    assert.match(built.nativeImageVersion,/25\.(?:5\.5|0\.5)\.0\.3/u);
    assert.match(host.lastReview(),/:quarkusBuild/u);
    assert.ok(host.lastReview().includes(built.sourceDigest));
    assert.match(log,/(?:>\s*Task :quarkusBuild|:quarkusBuild)/u);
    assert.equal(path.basename(built.artifact),'rocketbrain-quarkus-runner');
    assert.match(path.basename(path.dirname(built.artifact)),/^rocketbrain-native-/u);
    assert.equal(path.dirname(path.dirname(built.artifact)),path.join(root,'build'));
    assert.equal(await sha256(built.artifact),built.sha256);
    await assert.rejects(service.runNative({...input,buildId:'wrong build'}),/native image changed/u);
    await fs.writeFile(settings,changed);
    await assert.rejects(service.runNative(input),/native image changed/u);
    await fs.writeFile(settings,original);

    Object.assign(process.env,{RB_NATIVE_DB_USER:user,RB_NATIVE_DB_PASSWORD:password,
      RB_NATIVE_MYSQL_URL:'jdbc:mysql://127.0.0.1:43306/rocketbrain_native?allowPublicKeyRetrieval=true&sslMode=DISABLED',
      RB_NATIVE_MARIADB_URL:'jdbc:mariadb://127.0.0.1:43307/rocketbrain_native?sslMode=disable'});
    spring=await startSpring(path.join(graalHome,'bin','java'),springJar,springRoot);
    const engines=['mysql','mariadb'],seeded=await Promise.all(engines.map(engine=>readProbe(spring.baseUrl,engine)));
    const app=await host.execute(COMMANDS.runNative);
    assert.deepEqual([app.state,app.listenerVerified,app.sha256],['running',true,built.sha256]);
    assert.equal(await fs.realpath('/proc/'+app.pid+'/exe'),built.artifact);
    const native=await Promise.all(engines.map(engine=>readProbe(app.baseUrl,engine)));
    for(const [index,engine] of engines.entries()){
      assert.equal(seeded[index].runtime,'spring',engine);
      assert.deepEqual(native[index],{...seeded[index],runtime:'runtime'},engine);
    }
    assert.equal((await host.execute(COMMANDS.stop)).state,'stopped');
    assert.throws(()=>process.kill(app.pid,0),{code:'ESRCH'});
    await assert.rejects(fetch(app.baseUrl+'/probe/mysql',{signal:AbortSignal.timeout(1500)}));
    await spring.stop();
    spring=undefined;
    assert.equal(await fs.readFile(sentinel,'utf8'),'existing normal build\n');

    await fs.mkdir(output,{recursive:true});
    const image=path.join(output,'quarkus-gradle-native-linux-x64'),springOutput=path.join(output,'spring-jdbc-fixture.jar');
    await fs.copyFile(built.artifact,image);
    await fs.copyFile(springJar,springOutput);
    await Promise.all([assertNoCredential(image,password),assertNoCredential(springOutput,password)]);
    assert.equal(await sha256(image),built.sha256);
    const modified=await fs.open(built.artifact,'r+');
    try{
      const byte=Buffer.alloc(1),offset=built.size-1;
      assert.equal((await modified.read(byte,0,1,offset)).bytesRead,1);
      byte[0]^=1;
      assert.equal((await modified.write(byte,0,1,offset)).bytesWritten,1);
      await modified.sync();
    }finally{await modified.close();}
    await assert.rejects(service.runNative({...input,buildId:built.id}),/native image changed/u);
    const commit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
    if(process.env.GITHUB_SHA)assert.equal(commit,process.env.GITHUB_SHA);
    const receipt={commit,platform:'linux',architecture:'x64',quarkus:built.quarkusVersion,gradle:'9.7.1',task:built.task,
      sourceDigest:built.sourceDigest,nativeImage:built.nativeImageVersion,nativeElf:{sha256:built.sha256,bytes:built.size},
      springJar:{sha256:await sha256(springOutput),bytes:(await fs.stat(springOutput)).size},
      databases:Object.fromEntries(engines.map((engine,index)=>[engine,{spring:seeded[index],native:native[index]}])),
      managedBuildCommand:true,managedRunCommand:true,managedStopCommand:true,explicitApproval:true,untrustedRefused:true,
      staleApprovalRefused:true,staleSourceRefused:true,ordinaryBuildUnaffected:true,nativeProcessAndListenerVerified:true,
      stoppedAndListenerClosed:true,staleFileRefused:true,wrongBuildRefused:true,uploadCredentialChecked:true};
    const body=JSON.stringify(receipt,null,2)+'\n';
    assert.ok(!body.includes(password));
    await fs.writeFile(path.join(output,'receipt.json'),body,{flag:'wx'});
    console.log(body);
  }catch(error){
    throw Error((error.stack+'\n'+log).replaceAll(password,'[redacted]'));
  }finally{
    try{await spring?.stop();}finally{await service.dispose();}
    await fs.writeFile(settings,original);
    for(const name of ['RB_NATIVE_DB_USER','RB_NATIVE_DB_PASSWORD','RB_NATIVE_MYSQL_URL','RB_NATIVE_MARIADB_URL'])delete process.env[name];
  }
}

if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
