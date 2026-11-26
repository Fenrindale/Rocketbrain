'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { fail, cancelled } = require('./workbench-model');
const { buildSpec } = require('./workbench-tasks');
const { micronautMavenProject, PART } = require('./micronaut-model');
const { allocatePort, waitForOwnedListener } = require('./testing-debug');
const { nativePlatform, inspectImage, toolchain, directory, ownProcess } = require('./linux-native-executable');

const framework = 'Micronaut';
const goals = Object.freeze(['package','org.graalvm.buildtools:native-maven-plugin:compile-no-fork']);
const changed = () => fail('The reviewed Micronaut native image changed. Build it again.');
const model = project => micronautMavenProject(project,{native:true});

function buildFlags(output) {
  return ['--non-recursive','-DskipTests','-DoutputDir='+output,'-DnativeDryRun=false','-DsharedLibrary=false'];
}

function createMicronautNative({ log = () => {} } = {}) {
  const builds = new Map();
  let active, disposed = false;

  function begin(cancellation) {
    nativePlatform(framework);
    if (disposed || active) throw fail('Stop the current owned Micronaut native operation first.');
    if (cancelled(cancellation)) throw fail('The Micronaut native operation was cancelled.');
    const controller = new AbortController();
    let finish;
    const abort = () => controller.abort();
    const subscription = cancellation?.onCancellationRequested?.(abort);
    cancellation?.addEventListener?.('abort', abort, { once: true });
    const operation = { controller, finished: new Promise(resolve => { finish = resolve; }),
      detach() { subscription?.dispose(); cancellation?.removeEventListener?.('abort',abort); },
      close() { if (active === operation) active = undefined; this.detach(); finish(); } };
    active = operation;
    if (cancelled(cancellation)) abort();
    return operation;
  }

  function check(operation,current) {
    if (disposed || operation.controller.signal.aborted) throw fail('The Micronaut native operation was cancelled.');
    current();
  }

  async function command(operation,program,args,{ cwd, env },timeout,current) {
    check(operation,current);
    const running = ownProcess(program,args,{cwd,env,log,signal:operation.controller.signal},framework);
    if (!await running.completedWithin(timeout)) {
      await running.stop();
      throw fail('The Micronaut native command timed out.');
    }
    const result=await running.done;
    check(operation,current);
    if (result.error || result.code !== 0) throw fail('The Micronaut native command failed. Open the Micronaut output for details.');
    return running.tail;
  }

  async function build({project,graalvmHome,mavenHome,cancellation,current}) {
    const operation=begin(cancellation);
    try {
      const reviewed=model(project), graal=await toolchain(graalvmHome);
      // A literal JAR POM keeps its ordinary lifecycle; invoke the Native Build Tools goal explicitly.
      const spec=buildSpec(project,{javaHome:graal.javaHome,mavenHome},goals);
      const version=await command(operation,graal.nativeImage,['--version'],spec,12000,current);
      const banner=version.split(/\r?\n/u).map(line=>line.trim()).find(line=>/graalvm/iu.test(line));
      if (!banner || banner.length > 256) throw fail('The selected GraalVM did not identify its Native Image compiler.');

      const target=path.join(project.root,'target');
      await fs.mkdir(target,{recursive:true});
      await directory(target,framework);
      const output=await fs.mkdtemp(path.join(target,'rocketbrain-micronaut-native-'));
      const identity=await directory(output,framework);
      const env={...spec.env,GRAALVM_HOME:graal.javaHome};
      await command(operation,spec.command,[...spec.args,...buildFlags(output)],{cwd:spec.cwd,env},20*60*1000,current);

      const observed=await directory(output,framework);
      if (observed.dev!==identity.dev || observed.ino!==identity.ino ||
          model(project).buildFingerprint!==reviewed.buildFingerprint) {
        throw fail('The selected Micronaut module or output directory changed during the build.');
      }
      const artifact=path.join(output,reviewed.imageName);
      const image=await inspectImage(artifact,process.arch,undefined,framework,changed).catch(error=>{
        if (error.code==='ENOENT') throw fail('Micronaut did not produce the expected artifactId executable in the requested GraalVM outputDir.');
        throw error;
      });
      check(operation,current);
      const receipt={id:randomUUID(),state:'succeeded',projectUri:project.uri,artifact,size:image.size,
        sha256:image.sha256,platform:'linux',architecture:process.arch,micronautVersion:reviewed.platformVersion,
        nativeImageVersion:banner};
      builds.set(project.root,{...image,receipt,buildFingerprint:reviewed.buildFingerprint});
      return {...receipt};
    } finally { operation.close(); }
  }

  async function start({project,buildId,environment,cancellation,current}) {
    if (typeof environment!=='string' || !PART.test(environment)) throw fail('Use a literal Micronaut environment name.');
    const operation=begin(cancellation);
    let running, ready=false;
    try {
      const image=builds.get(project.root);
      if (!image || buildId && buildId!==image.receipt.id || image.buildFingerprint!==model(project).buildFingerprint) throw changed();
      const port=await allocatePort();
      await inspectImage(image.receipt.artifact,process.arch,image,framework,changed);
      check(operation,current);
      running=ownProcess(image.receipt.artifact,['-Djava.net.preferIPv4Stack=true','-Dmicronaut.server.host=127.0.0.1',
        '-Dmicronaut.server.port='+port,'-Dmicronaut.environments='+environment],
      {cwd:project.root,log,signal:operation.controller.signal},framework);
      operation.process=running;
      void running.done.then(()=>operation.controller.abort());
      const proof=await waitForOwnedListener({pid:running.child.pid,port,cancellation:operation.controller.signal,timeoutMs:30000});
      if (!proof.verified || proof.pid!==running.child.pid || proof.address!=='127.0.0.1' || running.ended) {
        throw fail('The Micronaut native HTTP listener is not owned by this executable.');
      }
      const runningImage=await fs.stat('/proc/'+proof.pid+'/exe',{bigint:true});
      if (runningImage.dev!==image.stat.dev || runningImage.ino!==image.stat.ino) throw changed();
      await inspectImage(image.receipt.artifact,process.arch,image,framework,changed);
      check(operation,current);
      const receipt={state:'running',mode:'native',environment,buildId:image.receipt.id,pid:proof.pid,
        baseUrl:'http://127.0.0.1:'+port,sha256:image.sha256,listenerVerified:true};
      operation.receipt=receipt;
      operation.detach();
      ready=true;
      void running.done.then(()=>operation.close());
      return {...receipt};
    } finally {
      if (!ready) try { await running?.stop(); } finally { operation.close(); }
    }
  }

  async function stop() {
    const operation=active;
    if (!operation) return {state:'stopped'};
    operation.controller.abort();
    if (operation.process) await operation.process.stop();
    await operation.finished;
    return {state:'stopped'};
  }

  return { build,start,stop,get running(){return !!active;},
    getState:()=>active?.receipt && {...active.receipt},
    async dispose() { disposed=true; await stop(); builds.clear(); } };
}

module.exports={createMicronautNative,buildFlags,goals};
