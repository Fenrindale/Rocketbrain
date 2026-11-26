'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { independentJavaExecutable } = require('./debug-runtime');
const { fail,cancelled } = require('./workbench-model');
const { contextPattern,MAX_WAR_BYTES } = require('./jakarta-war');
const hostSource = require('./jakarta-host-source.json');

const pause=milliseconds => new Promise(resolve => setTimeout(resolve,milliseconds));
const MAX_APPLICATIONS=8;
const MAX_SET_BYTES=512*1024*1024;
const sha256Pattern=/^[a-f0-9]{64}$/u;

async function tomcatLibraries(directory) {
  if (!path.isAbsolute(directory || '')) throw fail('Set rocketbrain.java.jakarta.tomcatHome to an independent Apache Tomcat 11 distribution.');
  const home=await fsp.realpath(directory);
  for (const name of ['bin/bootstrap.jar','bin/tomcat-juli.jar','lib/catalina.jar','lib/servlet-api.jar','lib/jasper.jar']) {
    const file=path.join(home,name), stat=await fsp.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || path.relative(file,await fsp.realpath(file))) {
      throw fail('Choose a physical Apache Tomcat 11 distribution with its bundled JARs.');
    }
  }
  return home;
}

function statMatches(a,b) {
  return a.dev===b.dev && a.ino===b.ino && a.size===b.size && a.mtimeNs===b.mtimeNs && a.ctimeNs===b.ctimeNs;
}

async function hashArchive(artifact,{destination,expectedSha256}={}) {
  const file=artifact.file;
  const kind=artifact.name?.endsWith('.ear')?'EAR':'WAR';
  if (path.relative(file,await fsp.realpath(file))) throw fail('The '+kind+' path changed before staging.');
  const stat=await fsp.lstat(file,{bigint:true});
  if (!stat.isFile() || stat.isSymbolicLink() || Number(stat.size)!==artifact.size || stat.size>BigInt(MAX_WAR_BYTES)) {
    throw fail('The '+kind+' artifact changed before staging. Build or select it again.');
  }
  const source=await fsp.open(file,'r');
  const hash=crypto.createHash('sha256');
  try {
    const signature=Buffer.alloc(4);
    const {bytesRead}=await source.read(signature,0,4,0);
    if (bytesRead!==4 || signature.readUInt32BE()!==0x504b0304 || !statMatches(stat,await source.stat({bigint:true}))) {
      throw fail('Select a readable ZIP-format Maven '+kind+' artifact.');
    }
    const data=source.createReadStream({start:0,autoClose:false});
    if (destination) {
      const digest=new Transform({transform(chunk,_encoding,callback){hash.update(chunk);callback(null,chunk);}});
      await pipeline(data,digest,fs.createWriteStream(destination,{flags:'wx'}));
    } else {
      for await (const chunk of data) hash.update(chunk);
    }
    const checksum=hash.digest('hex');
    if (!statMatches(stat,await source.stat({bigint:true})) || !statMatches(stat,await fsp.lstat(file,{bigint:true})) ||
        (expectedSha256!==undefined && expectedSha256!==checksum)) {
      throw fail('The '+kind+' artifact changed while staging. Build or select it again.');
    }
    return checksum;
  } finally { await source.close(); }
}

function validateApplications(applications,{set=false,pinned=false}={}) {
  if (!Array.isArray(applications) || applications.length<(set?2:1) || applications.length>(set?MAX_APPLICATIONS:1)) {
    throw fail('Choose two to '+MAX_APPLICATIONS+' Maven WAR artifacts for a deployment set.');
  }
  const names=new Set();
  let bytes=0;
  for (const {context,artifact,expectedSha256} of applications) {
    if (typeof context!=='string' || !contextPattern.test(context) || !artifact?.file ||
        !Number.isSafeInteger(artifact.size) || artifact.size<4 || artifact.size>MAX_WAR_BYTES) {
      throw fail('Choose a WAR and a lowercase context name, using letters, numbers and hyphens.');
    }
    if (names.has(context)) throw fail('Assign a unique Tomcat context to each WAR.');
    if (pinned && (typeof expectedSha256!=='string' || !sha256Pattern.test(expectedSha256))) {
      throw fail('Review the SHA-256 of each WAR before starting this deployment set.');
    }
    names.add(context);
    bytes+=artifact.size;
    if (bytes>MAX_SET_BYTES) throw fail('This deployment set exceeds the combined WAR size limit.');
  }
}

async function reviewTomcatWarSet(applications,cancellation) {
  validateApplications(applications,{set:true});
  const reviewed=[];
  for (const {context,artifact} of applications) {
    if (cancelled(cancellation)) throw fail('Tomcat deployment review cancelled.');
    const expectedSha256=await hashArchive(artifact);
    reviewed.push({context,artifact,expectedSha256});
  }
  if (cancelled(cancellation)) throw fail('Tomcat deployment review cancelled.');
  return reviewed;
}

async function removeOwnedBase(session) {
  if (!session.base) return;
  const resolved=await fsp.realpath(session.base);
  const identity=await fsp.lstat(resolved,{bigint:true});
  if (path.relative(session.base,resolved) || path.relative(session.parent,path.dirname(resolved)) ||
      !path.basename(resolved).startsWith('rb-tomcat-') || identity.dev!==session.identity.dev || identity.ino!==session.identity.ino) {
    throw fail('Tomcat staging directory identity changed before cleanup.');
  }
  await fsp.rm(resolved,{recursive:true,force:true,maxRetries:8,retryDelay:250});
  session.base=undefined;
}

function loopbackReady(port) {
  return new Promise(resolve => {
    const socket=net.createConnection({host:'127.0.0.1',port});
    const complete=ready => {socket.destroy();resolve(ready);};
    socket.setTimeout(500,() => complete(false));
    socket.once('connect',() => complete(true));
    socket.once('error',() => complete(false));
  });
}

async function exitedBy(session,milliseconds) {
  let timer;
  try {
    return await Promise.race([session.done.then(() => true),new Promise(resolve => {timer=setTimeout(() => resolve(false),milliseconds);})]);
  } finally { clearTimeout(timer); }
}

function createTomcatDeployment({log=()=>{},startupMs=90000} = {}) {
  let active, disposed=false;

  function release(session) {
    if (session.release) return session.release;
    session.stopping=true;
    session.operation?.reject(fail('The owned Tomcat deployment stopped during a context change.'));
    session.release=(async () => {
      try { await session.prepared; } catch { /* Startup errors are reported separately. */ }
      if (session.staging) await session.staging.catch(()=>{});
      if (session.child && !session.exited) {
        session.child.stdin.end('\n');
        if (!await exitedBy(session,6000)) {
          session.child.kill();
          if (!await exitedBy(session,8000)) throw fail('The owned Tomcat JVM did not exit.');
        }
      }
      if (session.port && await loopbackReady(session.port)) throw fail('The owned Tomcat listener is still reachable.');
      await removeOwnedBase(session);
      if (active===session) active=undefined;
      return {state:'stopped'};
    })().catch(error => {session.release=undefined;throw error;});
    return session.release;
  }

  async function prepare(session,{applications,javaHome,tomcatHome,debug,cancellation}) {
    const home=await tomcatLibraries(tomcatHome);
    const java=independentJavaExecutable(javaHome && path.join(javaHome,'bin',process.platform==='win32'?'java.exe':'java'));
    const javaRelease=await fsp.readFile(path.join(path.dirname(path.dirname(java)),'release'),'utf8');
    if (Number(/^JAVA_VERSION="(\d+)/m.exec(javaRelease)?.[1] || 0)<17) throw fail('Apache Tomcat 11 needs an independent JDK 17 or later.');
    session.parent=await fsp.realpath(os.tmpdir());
    session.base=await fsp.mkdtemp(path.join(session.parent,'rb-tomcat-'));
    session.identity=await fsp.lstat(session.base,{bigint:true});
    const entry=path.join(session.base,'JakartaWarHost.java'), staged=[];
    for (const [index,{artifact,expectedSha256,context}] of applications.entries()) {
      if (session.stopping || disposed || cancelled(cancellation)) throw fail('Tomcat deployment cancelled.');
      const destination=path.join(session.base,'war-'+index+'.war');
      const sha256=await hashArchive(artifact,{destination,expectedSha256});
      staged.push({context,artifact:artifact.name,sha256,destination,size:artifact.size});
    }
    await fsp.writeFile(entry,hostSource,{flag:'wx'});
    const logging=path.join(session.base,'logging.properties');
    await fsp.writeFile(logging,'handlers=java.util.logging.ConsoleHandler\njava.util.logging.ConsoleHandler.encoding=UTF-8\n',{flag:'wx'});
    if (session.stopping || disposed || cancelled(cancellation)) throw fail('Tomcat deployment cancelled.');
    const env={...process.env};
    for (const name of ['JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','_JAVA_OPTIONS','CATALINA_OPTS','JAVA_OPTS']) delete env[name];
    const classpath=[path.join(home,'bin/tomcat-juli.jar'),path.join(home,'lib','*')].join(path.delimiter);
    const token=crypto.randomUUID(), args=['-Dcatalina.home='+home,'-Dcatalina.base='+session.base,
      '-Djava.util.logging.config.file='+logging,
      ...(debug===true ? ['-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=127.0.0.1:0'] : []),'-cp',classpath,
      entry,session.base,token,...staged.flatMap(item => [item.context,item.destination])];
    const child=spawn(java,args,{cwd:session.base,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
    session.child=child;
    session.done=new Promise(resolve => child.once('close',() => {session.exited=true;resolve();}));
    child.once('error',error => {session.error=error;});
    child.stdin.on('error',()=>{});
    let buffered='';
    const pattern=new RegExp('^rocketbrain-tomcat:'+token+':(11\\.0\\.\\d+(?:\\.\\d+)?):(\\d+)$');
    child.stdout.setEncoding('utf8').on('data',chunk => {
      const lines=(buffered+chunk).split(/\r?\n/);
      buffered=lines.pop().slice(-1000);
      for (const line of lines) {
        const operation=session.operation;
        if (operation) {
          const acknowledged=operation.replies.find(reply =>
            line===`rocketbrain-tomcat:${token}:${reply}:${operation.id}:${operation.name}`);
          if (acknowledged) {
            operation.resolve(acknowledged);
            continue;
          }
        }
        const ready=pattern.exec(line);
        if (ready && Number(ready[2])>0 && Number(ready[2])<=65535) {
          session.version=ready[1];session.port=Number(ready[2]);
          continue;
        }
        const listening=debug===true && /^Listening for transport dt_socket at address: (\d+)$/.exec(line);
        if (listening && Number(listening[1])>0 && Number(listening[1])<=65535) {
          session.debugPort=Number(listening[1]);
          if (session.result) session.result.debugPort=session.debugPort;
        }
        log(line+'\n');
      }
    });
    child.stderr.setEncoding('utf8').on('data',log);
    void session.done.then(() => {if (session.ready) void release(session).catch(error => log(error.message+'\n'));});
    return staged;
  }

  async function start(options,set) {
    const {workspaceTrusted,allowDeploy,applications,debug,cancellation}=options;
    if (disposed || workspaceTrusted!==true || allowDeploy!==true) throw fail('Explicitly deploy the selected WAR from a trusted workspace.');
    validateApplications(applications,{set,pinned:set});
    if (active) throw fail('Stop the current owned Tomcat deployment first.');
    if (cancelled(cancellation)) throw fail('Tomcat deployment cancelled.');
    const session={id:crypto.randomUUID(),stopping:false,ready:false,exited:false,revision:0,additionReviews:new Map()};
    active=session;
    session.prepared=prepare(session,options);
    const cancel=cancellation?.onCancellationRequested?.(() => {void release(session).catch(()=>{});});
    try {
      const staged=await session.prepared;
      const deadline=Date.now()+startupMs;
      while (Date.now()<deadline) {
        if (session.stopping || disposed || cancelled(cancellation)) throw fail('Tomcat deployment cancelled.');
        if (session.error || session.exited) throw fail('The WAR did not start in Tomcat. Check its Output channel.');
        if (session.port && (debug!==true || session.debugPort) && await loopbackReady(session.port) &&
            !session.stopping && !session.exited) {
          session.ready=true;
          session.archives=new Map(staged.map(item=>['/'+item.context,{file:item.destination,size:item.size}]));
          session.stagedBytes=staged.reduce((total,item)=>total+item.size,0);
          const baseUrl='http://127.0.0.1:'+session.port;
          const deployed=staged.map(({context,artifact,sha256}) => ({context:'/'+context,url:baseUrl+'/'+context,artifact,sha256}));
          session.result={state:'running',deploymentId:session.id,version:session.version,
            ...(set ? {url:baseUrl,applications:deployed} : deployed[0]),
            ...(debug===true ? {debugPort:session.debugPort} : {})};
          return getState();
        }
        await pause(150);
      }
      throw fail('Tomcat did not confirm the WAR context and loopback listener before the timeout.');
    } catch (error) {
      await release(session);
      throw error;
    } finally { cancel?.dispose(); }
  }

  function deploy(options={}) {
    const {artifact,context,expectedSha256,...server}=options;
    return start({...server,applications:[{artifact,context,expectedSha256}]},false);
  }

  function deploySet(options={}) {
    return start({...options,debug:false},true);
  }

  function requireSet(deploymentId) {
    const session=active;
    if (!session?.ready || session.stopping || session.id!==deploymentId || !session.result.applications) {
      throw fail('The reviewed Tomcat deployment set is no longer running.');
    }
    if (session.operation) throw fail('Wait for the current Tomcat context change to finish.');
    return session;
  }

  function validateAddition(session,context,artifact) {
    validateApplications([{context,artifact}]);
    if (session.result.applications.some(app=>app.context==='/'+context)) throw fail('The requested Tomcat context is already in use.');
    if (session.result.applications.length>=MAX_APPLICATIONS || session.stagedBytes+artifact.size>MAX_SET_BYTES) {
      throw fail('Adding this WAR would exceed the Tomcat deployment set limit.');
    }
  }

  async function reviewAddition({deploymentId,context,artifact,cancellation}) {
    const session=requireSet(deploymentId), revision=session.revision;
    validateAddition(session,context,artifact);
    const expectedSha256=await hashArchive(artifact);
    if (cancelled(cancellation)) throw fail('Tomcat application review cancelled.');
    if (requireSet(deploymentId)!==session || session.revision!==revision) throw fail('The Tomcat application set changed during review.');
    const token=crypto.randomUUID(), expires=Date.now()+60000;
    for (const [id,review] of session.additionReviews) if (review.expires<=Date.now()) session.additionReviews.delete(id);
    if (session.additionReviews.size>=32) session.additionReviews.delete(session.additionReviews.keys().next().value);
    session.additionReviews.set(token,{revision,expires,context,artifact:{...artifact},expectedSha256});
    return {token,deploymentId,context,artifact:artifact.name,size:artifact.size,expectedSha256};
  }

  async function addApplication({deploymentId,token,artifact,allowDeploy,cancellation}) {
    if (allowDeploy!==true) throw fail('Explicitly confirm adding the reviewed WAR.');
    const session=requireSet(deploymentId);
    const review=session.additionReviews.get(token);
    session.additionReviews.delete(token);
    if (!review || review.revision!==session.revision || review.expires<=Date.now() ||
        artifact?.file!==review.artifact.file || artifact.size!==review.artifact.size) {
      throw fail('Review the current Tomcat WAR and deployment set before adding it.');
    }
    const {context,expectedSha256}=review, id=crypto.randomUUID();
    validateAddition(session,context,artifact);
    const destination=path.join(session.base,'war-live-'+id+'.war');
    const archive={file:destination,size:artifact.size};
    let timer, submitted=false, rejected=false, staged=false;
    session.operation={id,name:context,replies:[],reject() {}};
    try {
      if (cancelled(cancellation)) throw fail('Tomcat application addition cancelled.');
      session.staging=(async()=>{
        const base=await fsp.lstat(session.base,{bigint:true});
        if (!base.isDirectory() || base.isSymbolicLink() || base.ino!==session.identity.ino || base.dev!==session.identity.dev ||
            path.relative(session.base,await fsp.realpath(session.base))) {
          throw fail('The owned Tomcat staging directory changed.');
        }
        if (session.stopping || disposed) throw fail('The owned Tomcat deployment is stopping.');
        session.stagedBytes+=archive.size;
        staged=true;
        return hashArchive(artifact,{destination,expectedSha256});
      })();
      const sha256=await session.staging;
      if (cancelled(cancellation)) throw fail('Tomcat application addition cancelled.');
      if (active!==session || session.stopping || session.exited || disposed || session.revision!==review.revision || Date.now()>=review.expires) {
        throw fail('Review the current Tomcat deployment set before adding the WAR.');
      }
      const disposition=await new Promise((resolve,reject) => {
        session.operation={id,name:context,replies:['added','rejected'],resolve,reject};
        timer=setTimeout(() => reject(fail('Tomcat did not acknowledge the reviewed WAR addition.')),startupMs);
        submitted=true;
        session.child.stdin.write(`add ${id} ${context}\n`,error => {if (error) reject(error);});
      });
      if (session.stopping || session.exited) throw fail('The owned Tomcat deployment stopped during a context change.');
      if (disposition==='rejected') {
        rejected=true;
        throw fail('Tomcat rejected the reviewed WAR. The existing applications remain running. See the Output channel.');
      }
      const application={context:'/'+context,url:session.result.url+'/'+context,artifact:artifact.name,sha256};
      session.result.applications.push(application);
      session.archives.set(application.context,archive);
      session.revision++;
      return {state:'added',deploymentId,application:{...application},running:session.result.applications.length};
    } catch (error) {
      if (submitted && !rejected) await release(session);
      else if (staged && !session.stopping) await discardArchive(session,archive);
      throw error;
    } finally {
      clearTimeout(timer);
      session.staging=undefined;
      if (session.operation?.id===id) session.operation=undefined;
    }
  }

  async function discardArchive(session,archive) {
    try { await fsp.unlink(archive.file); }
    catch (error) {
      if (error.code!=='ENOENT') {
        log('Tomcat kept a staged archive for cleanup when the owned server stops.\n');
        return;
      }
    }
    session.stagedBytes-=archive.size;
  }

  async function undeploy({deploymentId,context,expectedSha256,allowUndeploy}={}) {
    if (allowUndeploy!==true) throw fail('Explicitly confirm the selected Tomcat context removal.');
    const session=requireSet(deploymentId);
    const app=session.result.applications.find(item => item.context===context);
    if (!app || app.sha256!==expectedSha256) throw fail('The reviewed Tomcat application has changed.');
    const id=crypto.randomUUID(), name=app.context.slice(1);
    let timer;
    try {
      await new Promise((resolve,reject) => {
        session.operation={id,name,replies:['removed'],resolve,reject};
        timer=setTimeout(() => reject(fail('Tomcat did not acknowledge the reviewed context removal.')),15000);
        session.child.stdin.write(`remove ${id} ${name}\n`,error => {if (error) reject(error);});
      });
      if (session.stopping || session.exited) throw fail('The owned Tomcat deployment stopped during a context change.');
      session.result.applications=session.result.applications.filter(item => item!==app);
      const archive=session.archives.get(app.context);
      session.archives.delete(app.context);
      await discardArchive(session,archive);
      session.revision++;
      if (!session.result.applications.length) await release(session);
      return {state:'undeployed',deploymentId,application:{...app},remaining:session.result.applications.length};
    } catch (error) {
      await release(session);
      throw error;
    } finally {
      clearTimeout(timer);
      session.operation=undefined;
    }
  }

  function stop(deploymentId) {
    return active && (!deploymentId || active.id===deploymentId) ? release(active) : Promise.resolve({state:'stopped'});
  }
  function getState() {
    if (!active) return {state:'stopped'};
    if (active.stopping) return {state:'stopping',deploymentId:active.id};
    const result=active.result;
    if (!result) return {state:'starting',deploymentId:active.id};
    return result.applications ? {...result,applications:result.applications.map(item => ({...item}))} : {...result};
  }
  return {deploy,deploySet,reviewAddition,addApplication,undeploy,stop,getState,async dispose(){disposed=true;await stop();}};
}

module.exports = { createTomcatDeployment,reviewTomcatWarSet,hashArchive,MAX_APPLICATIONS };
