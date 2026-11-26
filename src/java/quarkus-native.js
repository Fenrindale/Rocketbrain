'use strict';

const fs=require('node:fs/promises');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {createHash,randomUUID}=require('node:crypto');
const {StringDecoder}=require('node:string_decoder');
const {setTimeout:delay}=require('node:timers/promises');
const {fail,inside,cancelled}=require('./workbench-model');
const {quarkusMavenProject}=require('./quarkus-model');
const {buildSpec}=require('./workbench-tasks');
const {validateJavaHome}=require('./testing/provision');
const {allocatePort,waitForOwnedListener}=require('./testing-debug');

const machines={x64:62,arm64:183};
const maxImageBytes=512*1024*1024;
const imageName='rocketbrain-quarkus-runner';
const changed=()=>fail('The reviewed Quarkus native image changed. Build it again.');
const sameFile=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mode===b.mode&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs;
const samePath=(a,b)=>!path.relative(a,b);

function nativePlatform() {
  if(process.platform!=='linux'||!Object.hasOwn(machines,process.arch))
    throw fail('Run the Quarkus Native Image workbench in a Linux x64 or arm64 extension host.');
}

function nativeElfHeader(header,architecture) {
  if(!Buffer.isBuffer(header)||header.length<64||!Object.hasOwn(machines,architecture))return false;
  const kind=header.readUInt16LE(16);
  return header.readUInt32BE(0)===0x7f454c46&&header[4]===2&&header[5]===1&&header[6]===1&&
    (kind===2||kind===3)&&header.readUInt16LE(18)===machines[architecture]&&header.readUInt32LE(20)===1;
}

async function inspectImage(file,architecture=process.arch,expected) {
  const initial=await fs.lstat(file,{bigint:true});
  if(!initial.isFile()||initial.isSymbolicLink()||!(initial.mode&0o111n)||initial.size<64n||
      initial.size>BigInt(maxImageBytes)||!samePath(await fs.realpath(file),file))throw changed();
  if(expected&&!sameFile(initial,expected.stat))throw changed();
  const handle=await fs.open(file,'r');
  try {
    const header=Buffer.alloc(64), read=await handle.read(header,0,header.length,0);
    if(read.bytesRead!==header.length||!nativeElfHeader(header,architecture)||!sameFile(initial,await handle.stat({bigint:true})))
      throw fail('Quarkus did not produce an executable Linux ELF for this host architecture.');
    const hash=createHash('sha256');
    for await(const chunk of handle.createReadStream({start:0,autoClose:false}))hash.update(chunk);
    const sha256=hash.digest('hex');
    if(!sameFile(initial,await handle.stat({bigint:true}))||!sameFile(initial,await fs.lstat(file,{bigint:true}))||
       expected&&expected.sha256!==sha256)throw changed();
    return {stat:initial,sha256,size:Number(initial.size)};
  }finally{await handle.close();}
}

function nativeMavenFlags(output) {
  return ['-DskipTests','-Dquarkus.native.enabled=true','-Dquarkus.native.container-build=false',
    '-Dquarkus.native.sources-only=false','-Dquarkus.native.bundle.dry-run=false','-Dquarkus.package.jar.enabled=false',
    '-Dquarkus.package.output-directory='+output,'-Dquarkus.package.output-name=rocketbrain-quarkus',
    '-Dquarkus.package.runner-suffix=-runner'];
}

async function toolchain(home) {
  const validated=validateJavaHome(home), nativeImage=path.join(validated.javaHome,'bin','native-image');
  const actual=await fs.realpath(nativeImage).catch(()=>undefined);
  if(!actual||!inside(validated.javaHome,actual)||!/graalvm/iu.test(validated.release)||
      !((await fs.stat(actual)).mode&0o111))throw fail('Configure a physical GraalVM JDK 25 or newer with Native Image.');
  return {...validated,nativeImage:actual};
}

async function directory(folder) {
  const stat=await fs.lstat(folder,{bigint:true});
  if(stat.isSymbolicLink()||!stat.isDirectory()||!samePath(await fs.realpath(folder),folder))
    throw fail('Use a physical Quarkus native output directory inside the selected module.');
  return stat;
}

function ownProcess(program,args,{cwd,env,signal,log=()=>{}}) {
  const child=spawn(program,args,{cwd,env,detached:true,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let result,requested,tail='';
  const done=new Promise(resolve=>{
    child.once('error',error=>{result={error};resolve(result);});
    child.once('close',(code,childSignal)=>{result??={code,signal:childSignal};resolve(result);});
  });
  for(const stream of [child.stdout,child.stderr]){
    const decoder=new StringDecoder('utf8');
    stream.on('data',bytes=>{
      const text=decoder.write(bytes);
      tail=(tail+text).slice(-12000);
      try{log(text);}catch{}
    });
  }
  function stop(){
    if(requested)return requested;
    requested=(async()=>{
      if(!result&&child.pid&&child.exitCode===null&&child.signalCode===null){
        try{process.kill(-child.pid,'SIGTERM');}catch(error){if(error.code!=='ESRCH')throw error;}
        if(!await completedWithin(3000)&&child.exitCode===null&&child.signalCode===null){
          try{process.kill(-child.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}
        }
      }
      if(!await completedWithin(8000))throw fail('The owned Quarkus native process did not exit.');
    })();
    return requested;
  }
  async function completedWithin(ms){
    let timer;
    try{return await Promise.race([done.then(()=>true),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),ms);})]);}
    finally{clearTimeout(timer);}
  }
  const abort=()=>{void stop().catch(()=>{});};
  signal?.addEventListener('abort',abort,{once:true});
  void done.then(()=>signal?.removeEventListener('abort',abort));
  if(signal?.aborted)abort();
  return {child,done,stop,completedWithin,get ended(){return !!result;},get tail(){return tail;}};
}

function createQuarkusNative({log=()=>{}}={}) {
  const builds=new Map();
  let active,disposed=false;
  function begin(cancellation){
    nativePlatform();
    if(disposed||active)throw fail('Stop the current owned Quarkus native operation first.');
    if(cancelled(cancellation))throw fail('The Quarkus native operation was cancelled.');
    const controller=new AbortController(), abort=()=>controller.abort();
    const subscription=cancellation?.onCancellationRequested?.(abort);
    cancellation?.addEventListener?.('abort',abort,{once:true});
    let finish;
    const operation={controller,finished:new Promise(resolve=>{finish=resolve;}),
      detach(){subscription?.dispose();cancellation?.removeEventListener?.('abort',abort);},
      close(){if(active===operation)active=undefined;this.detach();finish();}};
    active=operation;
    if(cancelled(cancellation))abort();
    return operation;
  }
  function check(operation){
    if(operation.controller.signal.aborted||disposed)throw fail('The Quarkus native operation was cancelled.');
  }
  async function runCommand(operation,program,args,options,timeout){
    check(operation);
    const owned=ownProcess(program,args,{...options,log,signal:operation.controller.signal});
    if(!await owned.completedWithin(timeout)){await owned.stop();throw fail('The Quarkus native command timed out.');}
    const result=await owned.done;
    check(operation);
    if(result.error||result.code!==0)throw fail('The Quarkus native command failed. Open the Quarkus output for details.');
    return owned.tail;
  }
  async function build({project,graalvmHome,mavenHome,cancellation,current}){
    const operation=begin(cancellation);
    try{
      const model=quarkusMavenProject(project), graal=await toolchain(graalvmHome);
      const spec=buildSpec(project,{javaHome:graal.javaHome,mavenHome},['package']);
      const version=await runCommand(operation,graal.nativeImage,['--version'],spec,12000);
      const banner=version.split(/\r?\n/u).map(line=>line.trim()).find(line=>/graalvm/i.test(line));
      if(!banner||banner.length>256)throw fail('The selected independent GraalVM did not identify its Native Image compiler.');
      current();
      const target=path.join(project.root,'target');
      await fs.mkdir(target,{recursive:true});
      await directory(target);
      const output=await fs.mkdtemp(path.join(target,'rocketbrain-native-')), identity=await directory(output);
      const env={...spec.env,GRAALVM_HOME:graal.javaHome};
      await runCommand(operation,spec.command,[...spec.args,...nativeMavenFlags(output)],{cwd:spec.cwd,env},20*60*1000);
      check(operation);current();
      const ordered=await directory(output);
      if(ordered.dev!==identity.dev||ordered.ino!==identity.ino||quarkusMavenProject(project).buildFingerprint!==model.buildFingerprint)
        throw fail('The selected module or native output directory changed during the build.');
      const artifact=path.join(output,imageName), observed=await inspectImage(artifact);
      check(operation);current();
      const result={id:randomUUID(),state:'succeeded',projectUri:project.uri,artifact,size:observed.size,sha256:observed.sha256,
        platform:'linux',architecture:process.arch,quarkusVersion:model.version,nativeImageVersion:banner};
      builds.set(project.root,{...observed,receipt:result,buildFingerprint:model.buildFingerprint});
      return {...result};
    }finally{operation.close();}
  }

  async function start({project,buildId,cancellation,current}){
    const operation=begin(cancellation);
    let owned,ready=false;
    try{
      const image=builds.get(project.root), model=quarkusMavenProject(project);
      if(!image||buildId&&buildId!==image.receipt.id||image.buildFingerprint!==model.buildFingerprint)throw changed();
      const port=await allocatePort();
      await inspectImage(image.receipt.artifact,process.arch,image);
      check(operation);current();
      owned=ownProcess(image.receipt.artifact,['-Djava.net.preferIPv4Stack=true','-Dquarkus.http.host=127.0.0.1','-Dquarkus.http.port='+port],
        {cwd:project.root,signal:operation.controller.signal,log});
      operation.process=owned;
      void owned.done.then(()=>operation.controller.abort());
      const proof=await waitForOwnedListener({pid:owned.child.pid,port,cancellation:operation.controller.signal,timeoutMs:30000});
      if(!proof.verified||proof.pid!==owned.child.pid||proof.address!=='127.0.0.1'||owned.ended)throw fail('The native HTTP listener is not owned by this executable.');
      check(operation);current();
      operation.detach();ready=true;
      void owned.done.then(()=>operation.close());
      return {state:'running',buildId:image.receipt.id,pid:proof.pid,baseUrl:'http://127.0.0.1:'+port,
        sha256:image.sha256,listenerVerified:true};
    }finally{
      if(!ready){
        try{await owned?.stop();}finally{operation.close();}
      }
    }
  }

  async function stop(){
    const operation=active;
    if(!operation)return {state:'stopped'};
    operation.controller.abort();
    if(operation.process)await operation.process.stop();
    await operation.finished;
    return {state:'stopped'};
  }
  return {build,start,stop,get running(){return !!active;},async dispose(){disposed=true;await stop();builds.clear();}};
}

module.exports={createQuarkusNative,nativeElfHeader,nativeMavenFlags};
