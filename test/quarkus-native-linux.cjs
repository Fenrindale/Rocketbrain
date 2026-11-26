'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {createHash}=require('node:crypto');
const {createReadStream}=require('node:fs');
const {pathToFileURL}=require('node:url');
const {setTimeout:delay}=require('node:timers/promises');
const {execFileSync}=require('node:child_process');
const {registerQuarkusWorkbench,COMMANDS}=require('../src/java/quarkus-vscode');
const {quarkusMavenProject}=require('../src/java/quarkus-model');
const {allocatePort,waitForOwnedListener}=require('../src/java/testing-debug');

const fixture=path.resolve(__dirname,'fixtures/java/quarkus-native-linux');
const output=path.resolve(__dirname,'../test-output/quarkus-native-linux');

function workbench(project,tools,log){
  const disposable=()=>({dispose(){}});
  const commands=new Map();
  const vscode={
    workspace:{isTrusted:true,workspaceFolders:[project.uri],textDocuments:[],getConfiguration:()=>({get:key=>tools[key]})},
    window:{createOutputChannel:()=>({append:log,dispose(){}})},
    commands:{registerCommand(id,call){commands.set(id,call);return disposable();}},
    languages:{registerCompletionItemProvider:disposable,registerDefinitionProvider:disposable},
    debug:{onDidStartDebugSession:disposable,onDidTerminateDebugSession:disposable}
  };
  const service=registerQuarkusWorkbench(vscode,{workbench:{getSnapshot:()=>({projects:[project]})}});
  assert.ok(commands.has(COMMANDS.buildNative)&&commands.has(COMMANDS.runNative)&&commands.has(COMMANDS.stop));
  return service;
}

async function sha256(file){
  const hash=createHash('sha256');
  for await(const bytes of createReadStream(file))hash.update(bytes);
  return hash.digest('hex');
}

async function assertNoCredential(file,password){
  const needle=Buffer.from(password);
  let carry=Buffer.alloc(0);
  for await(const bytes of createReadStream(file)){
    const joined=Buffer.concat([carry,bytes]);
    assert.ok(!joined.includes(needle),'An upload candidate contains the disposable database password.');
    carry=joined.subarray(Math.max(0,joined.length-needle.length+1));
  }
}

async function readProbe(baseUrl,engine){
  const deadline=Date.now()+20000;
  let status;
  while(Date.now()<deadline){
    const reply=await fetch(baseUrl+'/probe/'+engine,{signal:AbortSignal.timeout(2000),redirect:'error'}).catch(()=>undefined);
    status=reply?.status;
    if(status===200){
      const parts=(await reply.text()).trim().split('|');
      assert.equal(parts.length,4);
      assert.match(parts[0],/^(spring|runtime)$/u);
      assert.equal(parts[1],'2');
      assert.equal(parts[2],'42');
      assert.match(parts[3],engine==='mysql'?/^8\.4\.13(?:[-+][A-Za-z0-9._+-]+)?$/u:/^11\.4\.8-MariaDB(?:[-+][A-Za-z0-9._+-]+)?$/u);
      return {runtime:parts[0],rows:Number(parts[1]),points:Number(parts[2]),version:parts[3]};
    }
    if(reply?.body)await reply.body.cancel();
    await delay(250);
  }
  throw Error('The owned '+engine+' JDBC probe did not succeed (HTTP '+status+').');
}

async function startSpring(java,artifact,cwd){
  const port=await allocatePort();
  const child=spawn(java,['-Djava.net.preferIPv4Stack=true','-jar',artifact,'--server.address=127.0.0.1','--server.port='+port],
    {cwd,env:process.env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let tail='',closed=false;
  const done=new Promise(resolve=>{
    child.once('error',()=>{closed=true;resolve();});
    child.once('close',()=>{closed=true;resolve();});
  });
  for(const stream of [child.stdout,child.stderr])stream.setEncoding('utf8').on('data',text=>{tail=(tail+text).slice(-5000);});
  async function stop(){
    if(!closed)child.kill();
    let timer;
    try {
      await Promise.race([done,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Owned Spring process did not stop.')),8000);})]);
    }finally{clearTimeout(timer);}
  }
  try{
    const proof=await waitForOwnedListener({pid:child.pid,port,timeoutMs:30000});
    assert.equal(proof.pid,child.pid);
    return {baseUrl:'http://127.0.0.1:'+port,stop};
  }catch(error){
    await stop();
    throw Error(error.message+' '+tail);
  }
}

async function main(){
  assert.equal(process.platform,'linux');
  assert.equal(process.arch,'x64');
  assert.equal(process.env.ROCKETBRAIN_NATIVE_LINUX_FIXTURE,'1');
  const graalHome=await fs.realpath(process.env.ROCKETBRAIN_GRAALVM_HOME);
  const mavenHome=await fs.realpath(process.env.ROCKETBRAIN_MAVEN_HOME);
  const user=process.env.RB_NATIVE_DB_USER, password=process.env.RB_NATIVE_DB_PASSWORD;
  assert.equal(user,'rb_native');
  assert.ok(password&&password.length>=16);
  // Keep the database variables out of the Maven/GraalVM build subprocess.
  delete process.env.RB_NATIVE_DB_USER;
  delete process.env.RB_NATIVE_DB_PASSWORD;
  assert.equal(process.env.RB_NATIVE_MYSQL_URL,undefined);
  assert.equal(process.env.RB_NATIVE_MARIADB_URL,undefined);
  const root=await fs.realpath(path.join(fixture,'quarkus'));
  const springRoot=await fs.realpath(path.join(fixture,'spring'));
  const springJar=path.join(springRoot,'target','spring-native-comparison-1.0.0.jar');
  const project={root,uri:pathToFileURL(root).href,name:'Quarkus native fixture',tool:'maven'};
  assert.equal(quarkusMavenProject(project).version,'3.40.1.2');
  let log='';
  const service=workbench(project,{quarkusGraalvmHome:graalHome,mavenHome},text=>{log=(log+text).slice(-24000);});
  const input={projectUri:project.uri,allowProjectExecution:true};
  let spring;
  try{
    await assert.rejects(service.buildNative({...input,allowProjectExecution:false}),/Explicitly approve/u);
    await assert.rejects(service.runNative(input),/native image changed/u);
    const built=await service.buildNative(input);
    assert.equal(built.state,'succeeded');
    assert.equal(built.platform,'linux');
    assert.equal(built.architecture,'x64');
    assert.match(built.nativeImageVersion,/25\.(?:5\.5|0\.5)\.0\.3/u);
    assert.match(path.basename(path.dirname(built.artifact)),/^rocketbrain-native-/u);
    assert.equal(path.dirname(path.dirname(built.artifact)),path.join(root,'target'));
    assert.equal(await sha256(built.artifact),built.sha256);
    await assert.rejects(service.runNative({...input,buildId:'wrong build'}),/native image changed/u);

    Object.assign(process.env,{RB_NATIVE_DB_USER:user,RB_NATIVE_DB_PASSWORD:password,
      RB_NATIVE_MYSQL_URL:'jdbc:mysql://127.0.0.1:43306/rocketbrain_native?allowPublicKeyRetrieval=true&sslMode=DISABLED',
      RB_NATIVE_MARIADB_URL:'jdbc:mariadb://127.0.0.1:43307/rocketbrain_native?sslMode=disable'});
    spring=await startSpring(path.join(graalHome,'bin','java'),springJar,springRoot);
    const engines=['mysql','mariadb'], seeded=await Promise.all(engines.map(engine=>readProbe(spring.baseUrl,engine)));
    const app=await service.runNative({...input,buildId:built.id});
    assert.equal(app.state,'running');
    assert.equal(app.listenerVerified,true);
    assert.equal(app.sha256,built.sha256);
    assert.equal(await fs.realpath('/proc/'+app.pid+'/exe'),built.artifact);
    const native=await Promise.all(engines.map(engine=>readProbe(app.baseUrl,engine)));
    for(const [index,engine] of engines.entries()){
      assert.equal(seeded[index].runtime,'spring',engine);
      assert.deepEqual(native[index],{...seeded[index],runtime:'runtime'},engine);
    }
    assert.equal((await service.stopDev()).state,'stopped');
    assert.throws(()=>process.kill(app.pid,0),{code:'ESRCH'});
    await assert.rejects(fetch(app.baseUrl+'/probe/mysql',{signal:AbortSignal.timeout(1500)}));
    await spring.stop();
    spring=undefined;

    await fs.mkdir(output,{recursive:true});
    const image=path.join(output,'quarkus-native-linux-x64'), springOutput=path.join(output,'spring-jdbc-fixture.jar');
    await fs.copyFile(built.artifact,image);
    await fs.copyFile(springJar,springOutput);
    await Promise.all([assertNoCredential(image,password),assertNoCredential(springOutput,password)]);
    assert.equal(await sha256(image),built.sha256);
    const fd=await fs.open(built.artifact,'r+');
    try{
      const finalByte=Buffer.alloc(1);
      const position=built.size-1;
      assert.equal((await fd.read(finalByte,0,1,position)).bytesRead,1);
      finalByte[0]^=1;
      assert.equal((await fd.write(finalByte,0,1,position)).bytesWritten,1);
      await fd.sync();
    }finally{await fd.close();}
    await assert.rejects(service.runNative({...input,buildId:built.id}),/native image changed/u);
    const commit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
    if(process.env.GITHUB_SHA)assert.equal(commit,process.env.GITHUB_SHA);
    const receipt={commit,platform:'linux',architecture:'x64',quarkus:built.quarkusVersion,
      nativeImage:built.nativeImageVersion,nativeElf:{sha256:built.sha256,bytes:built.size},
      springJar:{sha256:await sha256(springOutput),bytes:(await fs.stat(springOutput)).size},
      databases:Object.fromEntries(engines.map((engine,index)=>[engine,{spring:seeded[index],native:native[index]}])),
      managedBuildCommand:true,managedRunCommand:true,nativeProcessAndListenerVerified:true,
      stoppedAndListenerClosed:true,staleFileRefused:true,wrongBuildRefused:true,uploadCredentialChecked:true};
    const body=JSON.stringify(receipt,null,2)+'\n';
    assert.ok(!body.includes(password));
    await fs.writeFile(path.join(output,'receipt.json'),body,{flag:'wx'});
    console.log(body);
  }catch(error){
    throw Error((error.stack+'\n'+log).replaceAll(password,'[redacted]'));
  }finally{
    try{await spring?.stop();}finally{await service.dispose();}
    delete process.env.RB_NATIVE_DB_USER;
    delete process.env.RB_NATIVE_DB_PASSWORD;
    delete process.env.RB_NATIVE_MYSQL_URL;
    delete process.env.RB_NATIVE_MARIADB_URL;
  }
}

if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
