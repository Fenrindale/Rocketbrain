'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createReadStream } = require('node:fs');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { independentJavaExecutable } = require('./debug-runtime');
const { fail } = require('./workbench-model');
const agentSource = require('./kotlin-coroutine-probe-source.json');

const VERSION='1.11.0';
const DEBUG_SHA256='8de3d5f6f938e58a5bca46270a8ef6448c99548510be7e3f798bca813462afcf';
const ROUTE='/rocketbrain/coroutines';
const DESCRIPTOR='coroutine-probe.json';
const MAX_BODY=4*1024*1024;
const STATES=new Set(['CREATED','RUNNING','SUSPENDED']);
const UUID=/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/;
const execute=promisify(execFile);

async function physicalFile(file,max) {
  if (!path.isAbsolute(file || '')) throw fail('Choose an absolute local file.');
  const real=await fs.realpath(file), stat=await fs.lstat(file);
  if (path.relative(file,real) || !stat.isFile() || stat.isSymbolicLink() || stat.size>max) {
    throw fail('Choose a bounded physical file for Kotlin coroutine inspection.');
  }
  return real;
}

async function checksum(file) {
  const digest=createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}

async function prepareCoroutineProbe({javaHome,debugJar,storageRoot,workspaceTrusted,allowProbeWrites}={}) {
  if (workspaceTrusted!==true || allowProbeWrites!==true) throw fail('Explicitly prepare the coroutine probe in a trusted workspace.');
  const debug=await physicalFile(debugJar,4*1024*1024);
  if (await checksum(debug)!==DEBUG_SHA256) throw fail('Use the official kotlinx-coroutines-debug '+VERSION+' JAR.');
  const java=independentJavaExecutable(javaHome && path.join(javaHome,'bin',process.platform==='win32'?'java.exe':'java'));
  const jdk=path.dirname(path.dirname(java)), release=await fs.readFile(path.join(jdk,'release'),'utf8');
  if (Number(/^JAVA_VERSION="(\d+)/m.exec(release)?.[1] || 0)<17) throw fail('Preparing the Kotlin coroutine probe requires an independent JDK 17 or later.');
  if (!path.isAbsolute(storageRoot || '')) throw fail('Kotlin coroutine setup needs a local storage directory.');
  const storage=path.join(storageRoot,'kotlin-coroutine-probes');
  await fs.mkdir(storage,{recursive:true,mode:0o700});
  const parent=await fs.realpath(storage), folder=await fs.mkdtemp(path.join(parent,'probe-'));
  const owned=await fs.lstat(folder,{bigint:true});
  const jar=path.join(folder,'rocketbrain-coroutine-probe.jar'), descriptor=path.join(folder,DESCRIPTOR);
  const entry=path.join(folder,'CoroutineProbeAgent.java'), classes=path.join(folder,'classes'), manifest=path.join(folder,'MANIFEST.MF');
  const binary=name=>path.join(jdk,'bin',name+(process.platform==='win32'?'.exe':''));
  try {
    await fs.mkdir(classes);
    await fs.writeFile(entry,agentSource,{flag:'wx'});
    await fs.writeFile(manifest,'Manifest-Version: 1.0\nPremain-Class: rocketbrain.coroutines.CoroutineProbeAgent\n\n',{flag:'wx'});
    const env={...process.env};
    for (const name of ['JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','_JAVA_OPTIONS']) delete env[name];
    const options={cwd:folder,env,windowsHide:true,timeout:20000,maxBuffer:1024*1024};
    await execute(binary('javac'),['--release','17','-encoding','UTF-8','-d',classes,entry],options);
    await execute(binary('jar'),['--create','--file',jar,'--manifest',manifest,'-C',classes,'.'],options);
    await physicalFile(jar,256*1024);
    const encoded=Buffer.from(descriptor,'utf8').toString('base64url');
    if (encoded.length>8192) throw fail('Choose a shorter local directory for the coroutine probe.');
    return {descriptor,jar,version:VERSION,vmArgs:['-Dkotlinx.coroutines.debug.enable.creation.stack.trace=true',
      '-javaagent:'+debug,'-javaagent:'+jar+'='+encoded]};
  } catch (error) {
    const checked=await fs.realpath(folder), identity=await fs.lstat(checked,{bigint:true});
    if (path.relative(folder,checked) || path.relative(parent,path.dirname(checked)) || !path.basename(checked).startsWith('probe-') ||
        identity.dev!==owned.dev || identity.ino!==owned.ino) throw fail('Coroutine staging directory ownership changed during preparation.');
    await fs.rm(checked,{recursive:true,force:true,maxRetries:8,retryDelay:250});
    throw fail('Could not prepare the Kotlin coroutine probe. '+String(error.stderr || error.message).slice(-2500));
  }
}

function descriptorOf(value) {
  const {pid,port,session,token}=value || {};
  if (value?.format!=='RocketbrainCoroutineProbe' || value.version!==1 || !Number.isSafeInteger(pid) || pid<1 ||
      !Number.isInteger(port) || port<1 || port>65535 || typeof session!=='string' || !UUID.test(session) ||
      typeof token!=='string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw fail('Invalid local Kotlin coroutine probe descriptor.');
  return {pid,port,session,token};
}

async function readCoroutineDescriptor(file) {
  if (path.basename(file || '')!==DESCRIPTOR) throw fail('Choose the coroutine-probe.json file from the local JVM launch.');
  const real=await physicalFile(file,12*1024);
  const bytes=await fs.readFile(real);
  if (bytes.length>12*1024) throw fail('Local coroutine descriptor exceeds its byte limit.');
  return descriptorOf(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));
}

function readSnapshot(value,descriptor) {
  if (value?.format!=='RocketbrainCoroutineSnapshot' || value.version!==1 || value.pid!==descriptor.pid || value.session!==descriptor.session ||
      typeof value.capturedAt!=='string' || !/^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(value.capturedAt) ||
      !Number.isFinite(Date.parse(value.capturedAt)) || typeof value.creationEnabled!=='boolean' || typeof value.truncated!=='boolean' ||
      !Array.isArray(value.coroutines) || value.coroutines.length>100) throw fail('Unexpected snapshot from the selected local coroutine probe.');
  function text(item) {
    if (typeof item!=='string' || item.length>200) throw fail('A coroutine label or frame exceeds its supported size.');
    return item.replace(/[\u0000-\u001F\u007F]/g,'');
  }
  function frames(items) {
    if (!Array.isArray(items) || items.length>40) throw fail('Unexpected coroutine stack frame list.');
    return items.map(item => {
      if (!item || !Number.isInteger(item.line) || item.line<-2 || item.line>2_000_000) throw fail('Invalid coroutine stack frame line.');
      return {className:text(item.className),method:text(item.method),file:text(item.file),line:item.line};
    });
  }
  const coroutines=value.coroutines.map(item => {
    if (!item || !STATES.has(item.state)) throw fail('Unknown Kotlin coroutine state.');
    return {name:text(item.name),state:item.state,creation:frames(item.creation),observed:frames(item.observed)};
  });
  return {pid:value.pid,capturedAt:value.capturedAt,creationEnabled:value.creationEnabled,truncated:value.truncated,coroutines};
}

async function fetchCoroutineSnapshot(descriptor) {
  const {pid,port,session,token}=descriptorOf({...descriptor,format:'RocketbrainCoroutineProbe',version:1});
  const response=await fetch('http://127.0.0.1:'+port+ROUTE,{method:'GET',redirect:'error',
    signal:AbortSignal.timeout(5000),headers:{Accept:'application/json',Authorization:'Bearer '+token}});
  if (!response.ok || !/^application\/json\b/i.test(response.headers.get('content-type')||'')) {
    await response.body?.cancel();
    throw fail('The local Kotlin coroutine probe rejected the snapshot request ('+response.status+').');
  }
  const chunks=[];
  let size=0;
  for await (const chunk of response.body) {
    if ((size+=chunk.length)>MAX_BODY) throw fail('The coroutine snapshot exceeds its byte limit.');
    chunks.push(Buffer.from(chunk));
  }
  const data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,size)));
  return readSnapshot(data,{pid,session});
}

module.exports={prepareCoroutineProbe,readCoroutineDescriptor,fetchCoroutineSnapshot,readSnapshot,VERSION,DEBUG_SHA256};
