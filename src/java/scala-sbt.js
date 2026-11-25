'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFile,spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { independentJavaExecutable } = require('./debug-runtime');
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

function launcherCommands(action,projectId,main) {
  if (action==='discover') return ['projects'];
  if (projectId && !MODULE.test(projectId)) throw fail('Choose an observed sbt project ID.');
  const scope=projectId ? projectId+' / ' : '';
  if (action==='compile' || action==='test') return [scope+action];
  if (action==='mains') return ['show '+scope+'Compile / discoveredMainClasses'];
  if (action==='run' && typeof main==='string' && main.length<=220 && MAIN.test(main)) return [scope+'Compile / runMain '+main];
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

async function spec({root,javaHome,launcher,cache,repositoryConfig,action,projectId,main}) {
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
    ...launcherCommands(action,projectId,main)];
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

  async function run(options={}) {
    const {root,action,workspaceTrusted,allowProjectExecution,cancellation}=options;
    if (disposed || workspaceTrusted!==true || allowProjectExecution!==true) throw fail('Explicitly run sbt from a trusted local workspace.');
    if (cancelled(cancellation)) throw fail('The sbt task was cancelled.');
    if (active) throw fail('Wait for the current owned sbt task or stop it.');
    const record={cancelled:false,exited:false};
    active=record;
    const cancel=() => {void stop().catch(error => log(error.message+'\n'));};
    const subscription=cancellation?.onCancellationRequested?.(cancel);
    cancellation?.addEventListener?.('abort',cancel,{once:true});
    let timeout,output='';
    try {
      const launch=await spec(options);
      if (disposed || record.cancelled || cancelled(cancellation)) throw fail('The sbt task was cancelled.');
      const child=spawn(launch.command,launch.args,{cwd:root,env:launch.env,windowsHide:true,
        detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
      record.child=child;
      const capture=chunk => {output=(output+chunk).slice(-1_000_000);log(chunk);};
      child.stdout.setEncoding('utf8').on('data',capture);
      child.stderr.setEncoding('utf8').on('data',capture);
      child.once('error',error => {record.spawnError=error;});
      record.done=new Promise(resolve => child.once('close',code => {record.exited=true;resolve(code);}));
      timeout=setTimeout(() => {record.timedOut=true;cancel();},timeoutMs);
      const code=await record.done;
      if (record.spawnError) throw record.spawnError;
      const state=record.timedOut ? 'timed-out' : record.cancelled ? 'cancelled' : code===0 ? 'succeeded' : 'failed';
      return {state,task:action,sbtVersion:launch.sbtVersion,output:cleanTranscript(output),exitCode:code};
    } finally {
      clearTimeout(timeout);
      subscription?.dispose();
      cancellation?.removeEventListener?.('abort',cancel);
      if (active===record) active=undefined;
    }
  }

  return {run,stop,async dispose(){disposed=true;await stop();}};
}

module.exports = { projectSbt,createSbtRunner,observedProjects,mainClasses,launcherCommands,LAUNCHER_VERSION,LAUNCHER_SHA256 };
