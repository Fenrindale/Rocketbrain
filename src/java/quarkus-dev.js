'use strict';

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn,execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { buildSpec } = require('./workbench-tasks');
const { quarkusProject } = require('./quarkus-model');
const { cancelled,fail,buildFingerprint } = require('./workbench-model');
const { independentJavaExecutable } = require('./debug-runtime');
const { waitForOwnedListener } = require('./testing-debug');

const execute = promisify(execFile);
const pause = milliseconds => new Promise(resolve => setTimeout(resolve,milliseconds));

function fastJar(project) {
  const output=path.join(project.root,project.tool==='gradle'?'build':'target');
  const metadata=path.join(output,'quarkus-artifact.properties');
  const launcher=path.join(output,'quarkus-app','quarkus-run.jar');
  try {
    for (const file of [metadata,launcher]) {
      const stat=fs.lstatSync(file);
      if (!stat.isFile()||stat.isSymbolicLink()||path.relative(file,fs.realpathSync(file))) throw Error();
      if (file===metadata && stat.size>16384) throw Error();
    }
    const properties=fs.readFileSync(metadata,'utf8');
    const types=[...properties.matchAll(/^type=(.+)$/gmu)].map(match=>match[1].trim());
    const paths=[...properties.matchAll(/^path=(.+)$/gmu)].map(match=>match[1].trim().replace(/\\+/g,'/'));
    if (types.length!==1||types[0]!=='jar'||paths.length!==1||paths[0]!=='quarkus-app/quarkus-run.jar') throw Error();
    return launcher;
  } catch { throw fail('Build the standard Quarkus fast-jar from the selected project before debugging.'); }
}

function debugSpec(project,javaHome,artifact,port) {
  if (!path.isAbsolute(javaHome||'')) throw fail('Configure an independent project JDK before debugging Quarkus.');
  const command=independentJavaExecutable(path.join(javaHome,'bin',process.platform==='win32'?'java.exe':'java'));
  const env={...process.env,JAVA_HOME:path.dirname(path.dirname(command))};
  for (const key of Object.keys(env)) {
    if (/^(?:JAVA_TOOL_OPTIONS|JDK_JAVA_OPTIONS|_JAVA_OPTIONS)$/i.test(key)) delete env[key];
  }
  return {command,env,cwd:project.root,args:['-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=127.0.0.1:'+port,
    '-Dquarkus.profile=prod'],artifact};
}

async function availablePort() {
  const server=net.createServer();
  await new Promise((resolve,reject) => { server.once('error',reject); server.listen(0,'127.0.0.1',resolve); });
  const port=server.address().port;
  await new Promise((resolve,reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function listening(baseUrl) {
  try {
    const response=await fetch(baseUrl+'/',{method:'HEAD',redirect:'manual',signal:AbortSignal.timeout(750)});
    await response.body?.cancel();
    return true;
  } catch { return false; }
}

async function waitForExit(session,milliseconds) {
  let timer;
  try {
    return await Promise.race([session.done.then(() => true),new Promise(resolve => {timer=setTimeout(() => resolve(false),milliseconds);})]);
  } finally { clearTimeout(timer); }
}

async function stopProcess(session) {
  const child=session.child;
  if (!session.exited && child.pid) {
    if (process.platform === 'win32') {
      // The PID comes from this specific child and is used only while it is still running.
      const tool=path.join(process.env.SystemRoot || 'C:\\Windows','System32','taskkill.exe');
      try {
        await execute(tool,['/PID',String(child.pid),'/T','/F'],{windowsHide:true,timeout:10000});
      } catch (error) {
        if (!session.exited) throw error;
      }
    } else {
      try { process.kill(-child.pid,'SIGTERM'); } catch (error) { if (error.code!=='ESRCH') throw error; }
      if (!await waitForExit(session,3000)) {
        try { process.kill(-child.pid,'SIGKILL'); } catch (error) { if (error.code!=='ESRCH') throw error; }
      }
    }
  }
  if (!await waitForExit(session,10000)) throw fail('Quarkus dev process did not exit after stopping.');
  const until=Date.now()+5000;
  while (await listening(session.baseUrl)) {
    if (Date.now()>=until) throw fail('The owned Quarkus dev listener did not close.');
    await pause(150);
  }
}

function createQuarkusDev({log=()=>{},startupMs=180000,resolveDescendant} = {}) {
  let active,beginning=false,disposed=false,generation=0;

  async function stop() {
    generation++;
    const current=active;
    if (!current) return {state:'stopped'};
    if (!current.stopping) {
      current.stopping=stopProcess(current).then(() => {
        if (active===current) active=null;
        return {state:'stopped',baseUrl:current.baseUrl};
      }).catch(error => {current.stopping=null;throw error;});
    }
    return current.stopping;
  }

  async function verifyDebugTarget(cancellation) {
    const session=active;
    if (!session?.debugPort||session.exited||session.stopping||disposed) throw fail('The owned Quarkus debug JVM is unavailable.');
    let pid=session.child.pid;
    if (session.liveDebug) {
      const owner=await resolveDescendant({ancestorPid:pid,port:session.debugPort},cancellation);
      pid=owner.pid;
      await waitForOwnedListener({pid,port:session.port,cancellation,timeoutMs:5000});
    }
    const proof=await waitForOwnedListener({pid,port:session.debugPort,cancellation,timeoutMs:5000});
    if (session!==active||session.exited||session.stopping||disposed||cancelled(cancellation))
      throw fail('The owned Quarkus debug target changed.');
    return proof;
  }

  async function start({project,javaHome,mavenHome,gradleHome,debug=false,workspaceTrusted,allowProjectExecution,cancellation} = {}) {
    if (disposed || workspaceTrusted!==true || allowProjectExecution!==true) {
      throw fail('Explicitly start Quarkus dev mode from a trusted workspace.');
    }
    if (active||beginning) throw fail('Stop the current owned Quarkus dev session first.');
    if (cancelled(cancellation)) throw fail('Quarkus dev startup cancelled.');
    const liveDebug=debug==='development';
    const packagedDebug=debug===true;
    if (liveDebug && typeof resolveDescendant!=='function') {
      throw fail('Configure Java process discovery before debugging Quarkus dev mode.');
    }
    beginning=true;
    const ticket=generation;
    try {
      const metadata=quarkusProject(project);
      if (project.buildFingerprint&&project.buildFingerprint!==metadata.buildFingerprint)
        throw fail('Saved Quarkus build files changed. Refresh the imported project before starting it.');
      const port=await availablePort(), baseUrl='http://127.0.0.1:'+port;
      let debugPort;
      if (debug) {
        for (let attempt=0;attempt<4&&(!debugPort||debugPort===port);attempt++) debugPort=await availablePort();
        if (!debugPort||debugPort===port) throw fail('Allocate a separate loopback debug port.');
      }
      if (disposed || ticket!==generation || cancelled(cancellation)) throw fail('Quarkus startup cancelled.');
      if (buildFingerprint(project.root)!==metadata.buildFingerprint) throw fail('Saved Quarkus build files changed before launch.');
      const artifact=packagedDebug?fastJar(project):null;
      const spec=packagedDebug?debugSpec(project,javaHome,artifact,debugPort):buildSpec(project,{javaHome,mavenHome,gradleHome},
        [project.tool==='gradle'?':quarkusDev':metadata.plugin+':dev']);
      const launchOptions=packagedDebug?['-jar',spec.artifact]:
        liveDebug?['-Ddebug='+debugPort,'-DdebugHost=127.0.0.1','-Dsuspend=n']:['-Ddebug=false'];
      const args=[...spec.args,'-Dquarkus.http.host=127.0.0.1','-Dquarkus.http.port='+port,
        '-Dquarkus.console.enabled=false','-Dquarkus.test.continuous-testing=disabled',
        '-Dquarkus.analytics.disabled=true',...launchOptions];
      const child=spawn(spec.command,args,{cwd:spec.cwd,env:spec.env,windowsHide:true,
        detached:process.platform !== 'win32',stdio:['ignore','pipe','pipe']});
      const session={child,baseUrl,port,debugPort,liveDebug,exited:false,error:null,tail:'',stopping:null};
      active=session;
      session.done=new Promise(resolve => child.once('close',() => {session.exited=true;resolve();}));
      child.once('error',error => {session.error=error;});
      const capture=chunk => {
        session.tail=(session.tail+chunk).slice(-24000);
        log(chunk);
      };
      child.stdout.setEncoding('utf8').on('data',capture);
      child.stderr.setEncoding('utf8').on('data',capture);
      const cancel=cancellation?.onCancellationRequested?.(() => {void stop().catch(()=>{});});
      try {
        const deadline=Date.now()+startupMs;
        while (Date.now()<deadline) {
          if (session.stopping || cancelled(cancellation) || disposed) throw fail('Quarkus dev startup cancelled.');
          if (session.error || session.exited) throw fail('Quarkus dev process exited before reporting readiness. Check its output.');
          if (session.tail.includes('Listening on: '+baseUrl) && await listening(baseUrl)) {
            if (session.stopping || session.exited || cancelled(cancellation) || disposed) throw fail('Quarkus dev startup cancelled.');
            const ownership=debug?await verifyDebugTarget(cancellation):undefined;
            return {state:'ready',profile:packagedDebug?'prod':'dev',baseUrl,projectUri:project.uri,version:metadata.version,
              tool:metadata.tool,...(ownership?{debug:ownership}:{}),...(artifact?{artifact}:{})};
          }
          await pause(200);
        }
        throw fail('Quarkus dev startup timed out before the owned local listener was ready.');
      } catch (error) {
        await stop();
        throw error;
      } finally { cancel?.dispose(); }
    } finally { beginning=false; }
  }

  return {start,stop,verifyDebugTarget,get running(){return beginning || Boolean(active);},async dispose(){disposed=true;await stop();}};
}

module.exports = { createQuarkusDev,fastJar };
