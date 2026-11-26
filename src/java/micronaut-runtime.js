'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { independentJavaExecutable } = require('./debug-runtime');
const { waitForOwnedListener } = require('./testing-debug');
const { micronautMavenProject,micronautProject,PART } = require('./micronaut-model');
const { distribution,physical,matches }=require('./micronaut-distribution');
const { cancelled,fail,hash } = require('./workbench-model');

const ARCHIVE_LIMIT=256*1024*1024;
const delay=milliseconds => new Promise(resolve => setTimeout(resolve,milliseconds));

async function packagedJar(project) {
  const {jarName}=micronautMavenProject(project), target=path.join(project.root,'target');
  const file=path.join(target,jarName);
  if (!fs.existsSync(file)) throw fail('Package the Micronaut Maven application to create target/'+jarName+'.');
  const real=await fsp.realpath(file), stat=await fsp.lstat(file,{bigint:true});
  if (path.relative(real,file) || !stat.isFile() || stat.isSymbolicLink() || stat.size<4 || stat.size>ARCHIVE_LIMIT) {
    throw fail('Choose a regular physical Micronaut JAR up to 256 MiB under the selected module target folder.');
  }
  return {file:real,artifact:jarName,size:Number(stat.size)};
}

async function stagedJar(artifact,base) {
  const staged=path.join(base,artifact.artifact), original=await physical(artifact.file,'file');
  if(!matches(original,artifact.identity))throw fail('The Micronaut archive changed since its discovery.');
  await fsp.copyFile(artifact.file,staged,fs.constants.COPYFILE_EXCL);
  const after=await physical(artifact.file,'file'), copy=await physical(staged,'file');
  if (!matches(original,after) || after.size!==BigInt(artifact.size) || copy.size!==after.size) {
    throw fail('The packaged Micronaut JAR changed during staging. Package it and run again.');
  }
  const hash=crypto.createHash('sha256');
  let zipHeader;
  for await (const bytes of fs.createReadStream(staged)) {
    if (!zipHeader) zipHeader=bytes.subarray(0,4);
    hash.update(bytes);
  }
  if (zipHeader?.length!==4 || zipHeader.readUInt32BE()!==0x504b0304) throw fail('Micronaut requires a valid JAR archive.');
  return {artifact:artifact.artifact,staged,sha256:hash.digest('hex')};
}

async function stage(project,base,build,cancelledNow){
  if(build.tool==='maven'){
    const archive=await packagedJar(project);
    const {artifact,staged,sha256}=await stagedJar({...archive,identity:await physical(archive.file,'file')},base);
    return {artifact,sha256,kind:'maven-jar',launch:['-jar',staged]};
  }
  const selected=await distribution(project,build), staged=[];
  for(const jar of selected.jars){
    if(cancelledNow())throw fail('Micronaut startup was cancelled.');
    staged.push(await stagedJar(jar,base));
  }
  const cp=staged.map(item=>item.staged).join(path.delimiter);
  if(cp.length>24000)throw fail('The staged Micronaut classpath exceeds the local JVM command length limit.');
  const latest=await distribution(project,build);
  if(latest.jars.length!==selected.jars.length||latest.jars.some((jar,index)=>
    jar.file!==selected.jars[index].file||!matches(jar.identity,selected.jars[index].identity))){
    throw fail('The Micronaut Gradle distribution changed during staging. Build again.');
  }
  return {artifact:selected.artifact,kind:'gradle-distribution',libraryCount:staged.length,
    sha256:hash([build.mainClass,staged.map(item=>[item.artifact,item.sha256])]),launch:['-classpath',cp,build.mainClass]};
}

function reachable(port) {
  return new Promise(resolve => {
    const socket=net.createConnection({host:'127.0.0.1',port});
    const finish=open => {socket.destroy();resolve(open);};
    socket.once('connect',() => finish(true));
    socket.once('error',() => finish(false));
    socket.setTimeout(550,() => finish(false));
  });
}

async function awaitExit(session,milliseconds) {
  let timeout;
  try {
    return await Promise.race([session.done.then(() => true),new Promise(resolve => {timeout=setTimeout(() => resolve(false),milliseconds);})]);
  } finally {clearTimeout(timeout);}
}

async function removeOwned(session) {
  if (!session.staging) return;
  const real=await fsp.realpath(session.staging);
  const stat=await fsp.lstat(real,{bigint:true});
  if (path.relative(real,session.staging) || path.relative(path.dirname(real),session.parent) ||
      !path.basename(real).startsWith('rb-micronaut-') || stat.dev!==session.identity.dev || stat.ino!==session.identity.ino) {
    throw fail('Micronaut staging directory ownership changed before cleanup.');
  }
  await fsp.rm(real,{recursive:true,force:true,maxRetries:8,retryDelay:250});
  session.staging=undefined;
}

function createMicronautRuntime({log=()=>{},startupMs=90000,checkListener=waitForOwnedListener} = {}) {
  let active, disposed=false;

  function release(session) {
    if (session.release) return session.release;
    session.stopping=true;
    session.release=(async () => {
      try {await session.prepare;} catch { /* The originating run reports the startup error. */ }
      if (session.child && !session.exited) {
        session.child.kill('SIGTERM');
        if (!await awaitExit(session,6000)) {
          session.child.kill('SIGKILL');
          if (!await awaitExit(session,8000)) throw fail('The owned Micronaut JVM did not stop.');
        }
      }
      if (session.port && await reachable(session.port)) throw fail('The owned Micronaut HTTP listener did not close.');
      if (session.debugPort && await reachable(session.debugPort)) throw fail('The owned Micronaut JDWP listener did not close.');
      await removeOwned(session);
      if (active===session) active=undefined;
      return {state:'stopped'};
    })().catch(error => {session.release=undefined;throw error;});
    return session.release;
  }

  async function processFor(session,{project,javaHome,environment,cancellation,buildFingerprint,debug}) {
    const java=independentJavaExecutable(javaHome && path.join(javaHome,'bin',process.platform==='win32'?'java.exe':'java'));
    const reviewed=micronautProject(project);
    if(buildFingerprint!==undefined&&reviewed.buildFingerprint!==buildFingerprint)throw fail('The Micronaut Gradle build changed. Build again.');
    session.parent=await fsp.realpath(os.tmpdir());
    session.staging=await fsp.mkdtemp(path.join(session.parent,'rb-micronaut-'));
    session.identity=await fsp.lstat(session.staging,{bigint:true});
    const cancelledNow=()=>disposed||session.stopping||cancelled(cancellation);
    const {launch,...artifact}=await stage(project,session.staging,reviewed,cancelledNow);
    if(reviewed.tool==='gradle'&&micronautProject(project).buildFingerprint!==reviewed.buildFingerprint)
      throw fail('The Micronaut Gradle build changed during staging. Build again.');
    if (cancelledNow()) throw fail('Micronaut startup was cancelled.');
    const env={...process.env};
    for (const name of ['JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','_JAVA_OPTIONS','MICRONAUT_ENVIRONMENTS']) delete env[name];
    const args=[...(debug?['-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=127.0.0.1:0']:[]),
      '-Dfile.encoding=UTF-8','-Dmicronaut.server.host=127.0.0.1','-Dmicronaut.server.port=-1',
      '-Dmicronaut.env.deduction=false','-Dmicronaut.environments='+environment,...launch];
    const child=spawn(java,args,{cwd:project.root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
    session.child=child;
    session.done=new Promise(resolve => child.once('close',() => {session.exited=true;resolve();}));
    child.once('error',error => {session.error=error;});
    const listen=stream => {
      let tail='';
      stream.setEncoding('utf8').on('data',chunk => {
        log(chunk);
        tail=(tail+chunk).slice(-8192);
        const complete=tail.slice(0,tail.lastIndexOf('\n')+1);
        const found=/Startup completed[^\n]*Server Running:\s+http:\/\/(?:127\.0\.0\.1|localhost):(\d{1,5})(?:[\/\s\x1B]|$)/i.exec(complete);
        if (found && !session.result && Number(found[1])>0 && Number(found[1])<=65535) session.port=Number(found[1]);
        if (debug && !session.result) {
          for (const match of complete.matchAll(/^Listening for transport dt_socket at address: (\d{1,5})[ \t]*\r?$/gm)) {
            const port=Number(match[1]);
            if (port>0 && port<=65535) session.debugPorts.add(port);
          }
        }
      });
    };
    listen(child.stdout);
    listen(child.stderr);
    void session.done.then(() => {if (session.result) void release(session).catch(error => log(error.message+'\n'));});
    return artifact;
  }

  async function verifyListener(session,port,cancellation) {
    const pid=session.child?.pid;
    if (disposed || active!==session || session.exited || session.stopping || cancelled(cancellation) ||
        !Number.isInteger(pid) || !Number.isInteger(port)) throw fail('The owned Micronaut process or listener changed.');
    const proof=await checkListener({pid,port,cancellation,timeoutMs:6000});
    if (proof?.verified!==true || proof.address!=='127.0.0.1' || proof.pid!==pid || proof.port!==port ||
        active!==session || session.exited || session.stopping || disposed || cancelled(cancellation)) {
      throw fail('The selected Micronaut listener did not remain on the owned JVM.');
    }
    return proof;
  }

  async function verifyDebugTarget({runId,cancellation}={}) {
    const session=active;
    if (!session?.result?.debug || session.id!==runId) throw fail('Choose the current owned Micronaut debugger.');
    return verifyListener(session,session.debugPort,cancellation);
  }

  async function start(options = {}) {
    const {project,allowProjectExecution,workspaceTrusted,environment='dev',cancellation,debug=false}=options;
    if (disposed || workspaceTrusted!==true || allowProjectExecution!==true) {
      throw fail('Explicitly start the Micronaut application from a trusted workspace.');
    }
    if (typeof environment!=='string' || !PART.test(environment)) throw fail('Use a literal Micronaut environment name.');
    if (active) throw fail('Stop the current owned Micronaut application first.');
    if (cancelled(cancellation)) throw fail('Micronaut startup was cancelled.');
    const session={id:crypto.randomUUID(),stopping:false,exited:false,debugPorts:new Set()};
    active=session;
    session.prepare=processFor(session,{...options,environment,debug});
    const stop=()=>{void release(session).catch(()=>{});};
    const subscription=cancellation?.onCancellationRequested?.(stop);
    cancellation?.addEventListener?.('abort',stop,{once:true});
    try {
      const artifact=await session.prepare;
      const deadline=Date.now()+startupMs;
      while (Date.now()<deadline) {
        if (session.stopping || disposed || cancelled(cancellation)) throw fail('Micronaut startup was cancelled.');
        if (session.error || session.exited) throw fail('The Micronaut application exited before readiness. Check its output and built distribution.');
        if (debug && session.debugPorts.size>1) throw fail('Micronaut reported competing debugger listeners.');
        if (session.port && (!debug || session.debugPorts.size===1)) {
          let debugProof;
          if (debug) {
            const [port]=session.debugPorts;
            const httpPort=session.port;
            if (port===httpPort) throw fail('Micronaut HTTP and JDWP must have distinct listeners.');
            session.debugPort=port;
            const [listener]=await Promise.all([verifyListener(session,port,cancellation),
              verifyListener(session,httpPort,cancellation)]);
            if (session.debugPorts.size!==1 || session.port!==httpPort) throw fail('The Micronaut listeners changed during verification.');
            debugProof=Object.freeze({pid:listener.pid,port,address:listener.address,verified:true,httpOwnershipVerified:true});
          } else if (!await reachable(session.port)) {
            await delay(160);
            continue;
          }
          if (session.exited || session.stopping || disposed || cancelled(cancellation)) {
            throw fail('The Micronaut process changed before startup completed.');
          }
          session.result={state:'running',runId:session.id,baseUrl:'http://127.0.0.1:'+session.port,environment,
            projectUri:project.uri,...artifact,...(debugProof&&{debug:debugProof})};
          return {...session.result};
        }
        await delay(160);
      }
      throw fail('The Micronaut HTTP server did not report a ready loopback listener. Check its console logging.');
    } catch (error) {
      await release(session);
      throw error;
    } finally {subscription?.dispose();cancellation?.removeEventListener?.('abort',stop);}
  }

  function stop() {return active ? release(active) : Promise.resolve({state:'stopped'});}
  function getState() {
    if (!active) return {state:'stopped'};
    return active.result && !active.stopping ? {...active.result} : {state:active.stopping ? 'stopping' : 'starting',runId:active.id};
  }
  return {start,stop,getState,verifyDebugTarget,async dispose(){disposed=true;await stop();}};
}

module.exports = { createMicronautRuntime,packagedJar };
