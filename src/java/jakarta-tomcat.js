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

async function stageArchive(artifact,destination,expectedSha256) {
  const file=artifact.file;
  if (path.relative(file,await fsp.realpath(file))) throw fail('The WAR path changed before staging.');
  const stat=await fsp.lstat(file,{bigint:true});
  if (!stat.isFile() || stat.isSymbolicLink() || Number(stat.size)!==artifact.size || stat.size>BigInt(MAX_WAR_BYTES)) {
    throw fail('The WAR artifact changed before staging. Build or select it again.');
  }
  const source=await fsp.open(file,'r');
  const hash=crypto.createHash('sha256');
  try {
    const signature=Buffer.alloc(4);
    const {bytesRead}=await source.read(signature,0,4,0);
    if (bytesRead!==4 || signature.readUInt32BE()!==0x504b0304 || !statMatches(stat,await source.stat({bigint:true}))) {
      throw fail('Select a readable ZIP-format Maven WAR artifact.');
    }
    const digest=new Transform({transform(chunk,_encoding,callback){hash.update(chunk);callback(null,chunk);}});
    await pipeline(source.createReadStream({start:0,autoClose:false}),digest,fs.createWriteStream(destination,{flags:'wx'}));
    const checksum=hash.digest('hex');
    if (!statMatches(stat,await source.stat({bigint:true})) || !statMatches(stat,await fsp.lstat(file,{bigint:true})) ||
        (expectedSha256!==undefined && expectedSha256!==checksum)) {
      throw fail('The WAR artifact changed while staging. Build or select it again.');
    }
    return checksum;
  } finally { await source.close(); }
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
    session.release=(async () => {
      try { await session.prepared; } catch { /* Startup errors are reported separately. */ }
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

  async function prepare(session,{artifact,javaHome,tomcatHome,expectedSha256,context,debug,cancellation}) {
    const home=await tomcatLibraries(tomcatHome);
    const java=independentJavaExecutable(javaHome && path.join(javaHome,'bin',process.platform==='win32'?'java.exe':'java'));
    const javaRelease=await fsp.readFile(path.join(path.dirname(path.dirname(java)),'release'),'utf8');
    if (Number(/^JAVA_VERSION="(\d+)/m.exec(javaRelease)?.[1] || 0)<17) throw fail('Apache Tomcat 11 needs an independent JDK 17 or later.');
    session.parent=await fsp.realpath(os.tmpdir());
    session.base=await fsp.mkdtemp(path.join(session.parent,'rb-tomcat-'));
    session.identity=await fsp.lstat(session.base,{bigint:true});
    const war=path.join(session.base,'rocketbrain.war'), entry=path.join(session.base,'JakartaWarHost.java');
    const checksum=await stageArchive(artifact,war,expectedSha256);
    if (session.stopping || disposed || cancelled(cancellation)) throw fail('Tomcat deployment cancelled.');
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
      entry,session.base,context,war,token];
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
    return checksum;
  }

  async function deploy(options = {}) {
    const {workspaceTrusted,allowDeploy,context,artifact,debug,cancellation}=options;
    if (disposed || workspaceTrusted!==true || allowDeploy!==true) throw fail('Explicitly deploy the selected WAR from a trusted workspace.');
    if (typeof context!=='string' || !contextPattern.test(context) || !artifact?.file) {
      throw fail('Choose a WAR and a lowercase context name, using letters, numbers and hyphens.');
    }
    if (active) throw fail('Stop the current owned Tomcat deployment first.');
    if (cancelled(cancellation)) throw fail('Tomcat deployment cancelled.');
    const session={id:crypto.randomUUID(),stopping:false,ready:false,exited:false};
    active=session;
    session.prepared=prepare(session,options);
    const cancel=cancellation?.onCancellationRequested?.(() => {void release(session).catch(()=>{});});
    try {
      const sha256=await session.prepared;
      const deadline=Date.now()+startupMs;
      while (Date.now()<deadline) {
        if (session.stopping || disposed || cancelled(cancellation)) throw fail('Tomcat deployment cancelled.');
        if (session.error || session.exited) throw fail('The WAR did not start in Tomcat. Check its Output channel.');
        if (session.port && (debug!==true || session.debugPort) && await loopbackReady(session.port) &&
            !session.stopping && !session.exited) {
          session.ready=true;
          session.result={state:'running',deploymentId:session.id,version:session.version,context:'/'+context,
            url:'http://127.0.0.1:'+session.port+'/'+context,artifact:artifact.name,sha256,
            ...(debug===true ? {debugPort:session.debugPort} : {})};
          return {...session.result};
        }
        await pause(150);
      }
      throw fail('Tomcat did not confirm the WAR context and loopback listener before the timeout.');
    } catch (error) {
      await release(session);
      throw error;
    } finally { cancel?.dispose(); }
  }

  function stop(deploymentId) {
    return active && (!deploymentId || active.id===deploymentId) ? release(active) : Promise.resolve({state:'stopped'});
  }
  function getState() {
    if (!active) return {state:'stopped'};
    if (active.stopping) return {state:'stopping',deploymentId:active.id};
    return active.result ? {...active.result} : {state:'starting',deploymentId:active.id};
  }
  return {deploy,stop,getState,async dispose(){disposed=true;await stop();}};
}

module.exports = { createTomcatDeployment };
