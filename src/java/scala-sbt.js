'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFile,spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { setTimeout: delay } = require('node:timers/promises');
const { independentJavaExecutable } = require('./debug-runtime');
const { waitForOwnedListener } = require('./testing-debug');
const { buildLoopbackAgent } = require('./scala-debug-runtime');
const { cancelled,fail } = require('./workbench-model');

const LAUNCHER_VERSION='1.13.1';
const LAUNCHER_SHA256='b73aabc037a4b6e06b5d07d36edd026a97c3ac11c2f7e0d6f581d8efa47472e8';
const MODULE=/^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const MAIN=/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*){0,19}$/;
const execute=promisify(execFile);

async function physical(file,max,description) {
  if (!path.isAbsolute(file || '')) throw fail('Set an absolute path for '+description+'.');
  const real=await fs.realpath(file), stat=await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size>max || path.relative(real,file)) {
    throw fail('Use a bounded physical file for '+description+'.');
  }
  return real;
}

async function projectSbt(root) {
  const properties=await physical(path.join(root,'project/build.properties'),65536,'sbt build.properties');
  await physical(path.join(root,'build.sbt'),1024*1024,'build.sbt');
  const values=(await fs.readFile(properties,'utf8')).split(/\r?\n/).map(line => /^\s*sbt\.version\s*=\s*([\d.]+)\s*$/.exec(line)?.[1]).filter(Boolean);
  if (values.length!==1 || !/^1\.\d+\.\d+$/.test(values[0])) throw fail('Choose a project that declares a released sbt 1.x in project/build.properties.');
  return {sbtVersion:values[0]};
}

function isDebugTask(action) {return action==='debug' || action==='debugSuite';}

function launcherCommands(action,projectId,target) {
  if (action==='discover') return ['projects'];
  if (projectId && (typeof projectId!=='string' || !MODULE.test(projectId))) throw fail('Choose an observed sbt project ID.');
  const scope=projectId ? projectId+' / ' : '';
  if (action==='compile' || action==='test') return [scope+action];
  if (action==='renameIndex' && !projectId) return ['Compile / compile','Test / compile'];
  if (action==='mains') return ['show '+scope+'Compile / discoveredMainClasses'];
  if (action==='suites' || action==='debugSuite') {
    if (!projectId) throw fail('Choose an observed sbt project ID for Scala test suites.');
    if (action==='suites') {
      const task=scope+'Test / definedTests';
      return ['set '+task+' / aggregate := false','show '+task];
    }
    if (typeof target==='string' && target.length<=220 && MAIN.test(target)) {
      return ['show '+scope+'Test / startTestSuitesDebugSession '+JSON.stringify([target]),'shell'];
    }
    throw fail('Choose a supported sbt test suite name.');
  }
  if (typeof target==='string' && target.length<=220 && MAIN.test(target)) {
    if (action==='run') return [scope+'Compile / runMain '+target];
    if (action==='debug') {
      const input=JSON.stringify({class:target,arguments:[],jvmOptions:[],environmentVariables:[]});
      return ['show '+scope+'Compile / startMainClassDebugSession '+input,'shell'];
    }
  }
  throw fail('Choose a supported sbt task and a discovered main class.');
}

function cleanTranscript(text) {return text.replace(/\u001b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g,'').replace(/\r\n/g,'\n');}

function observedProjects(text) {
  const modules=[];
  let block=false;
  for (const line of cleanTranscript(text).split('\n')) {
    if (/^\[info\] In file:/.test(line)) {block=true;continue;}
    if (!block) continue;
    const entry=/^\[info\]\s{2,}(\*\s+)?([A-Za-z][A-Za-z0-9_-]{0,63})\s*$/.exec(line);
    if (!entry) {block=false;continue;}
    if (!modules.some(module => module.id===entry[2])) modules.push({id:entry[2],current:Boolean(entry[1])});
  }
  return modules;
}

function mainClasses(text) {
  return [...new Set(cleanTranscript(text).split('\n').map(line => /^\[info\] \* (\S+)\s*$/.exec(line)?.[1])
    .filter(value => value && MAIN.test(value)))];
}

function testSuites(text) {
  return [...new Set(cleanTranscript(text).split('\n').map(line => /^\[info\] \* Test (\S+)\s+:\s+/.exec(line)?.[1])
    .filter(value => value && value.length<=220 && MAIN.test(value)))];
}

async function spec({root,javaHome,launcher,cache,repositoryConfig,action,projectId,main,suite}) {
  const metadata=await projectSbt(root);
  const file=await physical(launcher,8*1024*1024,'the sbt '+LAUNCHER_VERSION+' launcher JAR');
  if (createHash('sha256').update(await fs.readFile(file)).digest('hex')!==LAUNCHER_SHA256) {
    throw fail('The configured launcher must match the official sbt '+LAUNCHER_VERSION+' JAR.');
  }
  const command=independentJavaExecutable(javaHome && path.join(javaHome,'bin',process.platform==='win32'?'java.exe':'java'));
  if (!path.isAbsolute(cache || '')) throw fail('Choose an absolute sbt cache directory.');
  await fs.mkdir(cache,{recursive:true});
  const working=await fs.realpath(cache);
  const repos=repositoryConfig && await physical(repositoryConfig,64*1024,'sbt repository configuration');
  const env={...process.env,JAVA_HOME:path.dirname(path.dirname(command)),COURSIER_CACHE:path.join(working,'coursier')};
  for (const name of ['JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','_JAVA_OPTIONS','SBT_OPTS','JAVA_OPTS']) delete env[name];
  const args=['-XX:ActiveProcessorCount=4','-Dfile.encoding=UTF-8','-Dsbt.supershell=false','-Dsbt.color=false',
    '-Dsbt.log.noformat=true','-Dsbt.server.autostart=false','-Dsbt.task.cpus=2','-Dsbt.boot.directory='+path.join(working,'boot'),
    '-Dsbt.global.base='+path.join(working,'global'),'-Dsbt.ivy.home='+path.join(working,'ivy'),
    ...(repos ? ['-Dsbt.override.build.repos=true','-Dsbt.repository.config='+repos] : []),'-jar',file,
    ...launcherCommands(action,projectId,action==='debugSuite' ? suite : main)];
  return {command,args,env,...metadata};
}

async function exitedBy(record,milliseconds) {
  let timeout;
  try {return await Promise.race([record.done.then(() => true),new Promise(resolve => {timeout=setTimeout(() => resolve(false),milliseconds);})]);}
  finally {clearTimeout(timeout);}
}

async function terminate(record) {
  const child=record.child;
  if (!child?.pid || record.exited) return;
  if (process.platform==='win32') {
    const tool=path.join(process.env.SystemRoot || 'C:\\Windows','System32','taskkill.exe');
    try {await execute(tool,['/PID',String(child.pid),'/T','/F'],{windowsHide:true,timeout:9000});}
    catch (error) {if (!record.exited) throw error;}
  } else {
    try {process.kill(-child.pid,'SIGTERM');} catch (error) {if (error.code!=='ESRCH') throw error;}
    if (!await exitedBy(record,2800)) {
      try {process.kill(-child.pid,'SIGKILL');} catch (error) {if (error.code!=='ESRCH') throw error;}
    }
  }
  if (!await exitedBy(record,10000)) throw fail('The owned sbt process did not exit.');
}

function createSbtRunner({log=()=>{},timeoutMs=240000}={}) {
  let active,disposed=false;

  async function stop() {
    const record=active;
    if (!record) return {state:'stopped'};
    record.cancelled=true;
    if (!record.stop) record.stop=terminate(record).catch(error => {record.stop=undefined;throw error;});
    await record.stop;
    return {state:'stopped'};
  }

  async function open(options={}) {
    const {root,action,workspaceTrusted,allowProjectExecution,cancellation}=options;
    if (disposed || workspaceTrusted!==true || allowProjectExecution!==true) throw fail('Explicitly run sbt from a trusted local workspace.');
    if (cancelled(cancellation)) throw fail('The sbt task was cancelled.');
    if (active) throw fail('Wait for the current owned sbt task or stop it.');
    const record={cancelled:false,exited:false,output:''};
    active=record;
    const cancel=() => {void stop().catch(error => log(error.message+'\n'));};
    const subscription=cancellation?.onCancellationRequested?.(cancel);
    cancellation?.addEventListener?.('abort',cancel,{once:true});
    const release=()=>{
      clearTimeout(record.timeout);
      subscription?.dispose();
      cancellation?.removeEventListener?.('abort',cancel);
      if (active===record) active=undefined;
    };
    try {
      const launch=await spec(options);
      if (isDebugTask(action)) record.agent=await buildLoopbackAgent(path.dirname(launch.command),launch.env);
      if (disposed || record.cancelled || cancelled(cancellation)) throw fail('The sbt task was cancelled.');
      const args=record.agent ? ['-javaagent:'+record.agent.jar,...launch.args] : launch.args;
      const child=spawn(launch.command,args,{cwd:root,env:launch.env,windowsHide:true,
        detached:process.platform!=='win32',stdio:[record.agent?'pipe':'ignore','pipe','pipe']});
      record.child=child;
      child.stdin?.on('error',()=>{});
      const capture=chunk => {record.output=(record.output+chunk).slice(-1_000_000);log(chunk);};
      child.stdout.setEncoding('utf8').on('data',capture);
      child.stderr.setEncoding('utf8').on('data',capture);
      child.once('error',error => {record.spawnError=error;});
      record.done=new Promise(resolve => child.once('close',code => {record.exited=true;resolve(code);})).finally(async()=>{
        try {await record.agent?.dispose();} finally {release();}
      });
      void record.done.catch(error=>log(error.message+'\n'));
      record.timeout=setTimeout(() => {record.timedOut=true;cancel();},timeoutMs);
      return {record,sbtVersion:launch.sbtVersion};
    } catch (error) {
      try {await record.agent?.dispose();} finally {release();}
      throw error;
    }
  }

  async function run(options={}) {
    if (isDebugTask(options.action)) throw fail('Use the managed Scala debug session.');
    const {record,sbtVersion}=await open(options);
    const code=await record.done;
    if (record.spawnError) throw record.spawnError;
    const state=record.timedOut ? 'timed-out' : record.cancelled ? 'cancelled' : code===0 ? 'succeeded' : 'failed';
    return {state,task:options.action,sbtVersion,output:cleanTranscript(record.output),exitCode:code};
  }

  async function verifyDebug(target,cancellation) {
    const record=active;
    if (!record?.target || record.target!==target || record.cancelled || record.exited || disposed) {
      throw fail('The owned Scala debugger has ended.');
    }
    const proof=await waitForOwnedListener({pid:target.pid,port:target.port,cancellation,timeoutMs:6000});
    if (active!==record || record.cancelled || record.exited || disposed || cancelled(cancellation)) {
      throw fail('The Scala debugger changed during verification.');
    }
    return proof;
  }

  async function openDebug(options,action) {
    const {record}=await open({...options,action});
    try {
      while (!record.exited && !record.cancelled) {
        const line=cleanTranscript(record.output).match(/^\[info\] (tcp:\/\/[^\s]+)$/m)?.[1];
        if (line) {
          const location=/^tcp:\/\/127\.0\.0\.1:(\d{1,5})$/.exec(line);
          if (!location) throw fail('The Scala debug adapter reported an unexpected listener address.');
          const target=Object.freeze({pid:record.child.pid,port:Number(location[1]),address:'127.0.0.1'});
          record.target=target;
          await verifyDebug(target,options.cancellation);
          clearTimeout(record.timeout);
          return target;
        }
        await delay(150);
      }
      throw fail('The sbt debugger did not start. Check the Scala output and the configured debug plugin.');
    } catch (error) {
      if (active===record) await stop();
      throw error;
    }
  }

  return {run,debug:(options={}) => openDebug(options,'debug'),debugSuite:(options={}) => openDebug(options,'debugSuite'),
    verifyDebug,stop,async dispose(){disposed=true;await stop();}};
}

module.exports = { projectSbt,createSbtRunner,observedProjects,mainClasses,testSuites,launcherCommands,LAUNCHER_VERSION,LAUNCHER_SHA256 };
