'use strict';

const path = require('node:path');
const net = require('node:net');
const { spawn,execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { buildSpec } = require('./workbench-tasks');
const { quarkusMavenProject } = require('./quarkus-model');
const { cancelled,fail } = require('./workbench-model');

const execute = promisify(execFile);
const pause = milliseconds => new Promise(resolve => setTimeout(resolve,milliseconds));

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

function createQuarkusDev({log=()=>{},startupMs=180000} = {}) {
  let active,beginning=false,disposed=false;

  async function stop() {
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

  async function start({project,javaHome,mavenHome,workspaceTrusted,allowProjectExecution,cancellation} = {}) {
    if (disposed || workspaceTrusted!==true || allowProjectExecution!==true) {
      throw fail('Explicitly start Quarkus dev mode from a trusted workspace.');
    }
    if (active||beginning) throw fail('Stop the current owned Quarkus dev session first.');
    if (cancelled(cancellation)) throw fail('Quarkus dev startup cancelled.');
    beginning=true;
    try {
      const metadata=quarkusMavenProject(project);
      const port=await availablePort(), baseUrl='http://127.0.0.1:'+port;
      if (disposed || cancelled(cancellation)) throw fail('Quarkus dev startup cancelled.');
      const spec=buildSpec(project,{javaHome,mavenHome},[metadata.plugin+':dev']);
      const args=[...spec.args,'-Dquarkus.http.host=127.0.0.1','-Dquarkus.http.port='+port,
        '-Dquarkus.console.enabled=false','-Dquarkus.test.continuous-testing=disabled',
        '-Dquarkus.analytics.disabled=true','-Ddebug=false'];
      const child=spawn(spec.command,args,{cwd:spec.cwd,env:spec.env,windowsHide:true,
        detached:process.platform !== 'win32',stdio:['ignore','pipe','pipe']});
      const session={child,baseUrl,exited:false,error:null,tail:'',stopping:null};
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
            return {state:'ready',profile:'dev',baseUrl,projectUri:project.uri,version:metadata.version};
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

  return {start,stop,get running(){return beginning || Boolean(active);},async dispose(){disposed=true;await stop();}};
}

module.exports = { createQuarkusDev };
