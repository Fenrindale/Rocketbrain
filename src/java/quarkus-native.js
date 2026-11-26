'use strict';

const fs=require('node:fs/promises');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {fail,cancelled}=require('./workbench-model');
const {quarkusMavenProject}=require('./quarkus-model');
const {buildSpec}=require('./workbench-tasks');
const {allocatePort,waitForOwnedListener}=require('./testing-debug');

const {nativePlatform,nativeElfHeader,inspectImage,toolchain,directory,ownProcess}=require('./linux-native-executable');

const framework='Quarkus', imageName='rocketbrain-quarkus-runner';
const changed=()=>fail('The reviewed Quarkus native image changed. Build it again.');

function nativeMavenFlags(output) {
  return ['-DskipTests','-Dquarkus.native.enabled=true','-Dquarkus.native.container-build=false',
    '-Dquarkus.native.sources-only=false','-Dquarkus.native.bundle.dry-run=false','-Dquarkus.package.jar.enabled=false',
    '-Dquarkus.package.output-directory='+output,'-Dquarkus.package.output-name=rocketbrain-quarkus',
    '-Dquarkus.package.runner-suffix=-runner'];
}

function createQuarkusNative({log=()=>{}}={}) {
  const builds=new Map();
  let active,disposed=false;
  function begin(cancellation){
    nativePlatform(framework);
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
    const owned=ownProcess(program,args,{...options,log,signal:operation.controller.signal},framework);
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
      await directory(target,framework);
      const output=await fs.mkdtemp(path.join(target,'rocketbrain-native-')), identity=await directory(output,framework);
      const env={...spec.env,GRAALVM_HOME:graal.javaHome};
      await runCommand(operation,spec.command,[...spec.args,...nativeMavenFlags(output)],{cwd:spec.cwd,env},20*60*1000);
      check(operation);current();
      const ordered=await directory(output,framework);
      if(ordered.dev!==identity.dev||ordered.ino!==identity.ino||quarkusMavenProject(project).buildFingerprint!==model.buildFingerprint)
        throw fail('The selected module or native output directory changed during the build.');
      const artifact=path.join(output,imageName), observed=await inspectImage(artifact,process.arch,undefined,framework,changed);
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
      await inspectImage(image.receipt.artifact,process.arch,image,framework,changed);
      check(operation);current();
      owned=ownProcess(image.receipt.artifact,['-Djava.net.preferIPv4Stack=true','-Dquarkus.http.host=127.0.0.1','-Dquarkus.http.port='+port],
        {cwd:project.root,signal:operation.controller.signal,log},framework);
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
