'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createHash } = require('node:crypto');
const { local, inside, cancelled } = require('./workbench-model');
const { independentJavaExecutable } = require('./debug-runtime');

const run = promisify(execFile);
const binary = process.platform === 'win32' ? 'java.exe' : 'java';
const maxClasses = 5000, maxEntries = 15000;
const maxReportedPaths = 5000, maxOutputRoots = 128;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function javaFeature(value) {
  const release = /^(?:1\.)?(\d+)(?:[._+-]|$)/u.exec(String(value ?? ''));
  const major = Number(release?.[1]);
  return Number.isInteger(major) && major >= 8 && major <= 200 ? major : null;
}

function classVersion(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== 8 || bytes.readUInt32BE(0) !== 0xcafebabe) {
    throw Error('The local Java output contains an invalid classfile header. Rebuild it before review.');
  }
  const minor = bytes.readUInt16BE(4), major = bytes.readUInt16BE(6);
  if (major < 45 || major >= 56 && minor !== 0 && minor !== 65535) {
    throw Error('The local Java output contains an invalid classfile version. Rebuild it before review.');
  }
  return { major, minor, release: major - 44, preview: major >= 56 && minor === 65535 };
}

function assertActive(cancellation) {
  if (cancelled(cancellation)) throw Error('Java runtime review was cancelled.');
}

async function localOutput(root, value) {
  if (typeof value !== 'string') return;
  const file = local(value);
  if (!inside(root,file) || !path.relative(root,file)) return;
  let details;
  try { details = await fs.lstat(file); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!details.isDirectory() || details.isSymbolicLink()) return;
  const real = await fs.realpath(file);
  if (path.relative(file,real) || !inside(root,real)) return;
  return real;
}

async function moduleOutput({ root, outputPaths = [], cancellation }) {
  assertActive(cancellation);
  const physical = await fs.realpath(root);
  const roots = [];
  for (const item of outputPaths) {
    assertActive(cancellation);
    const dir = await localOutput(physical,item);
    if (!dir || roots.some(found => !path.relative(found,dir))) continue;
    if (roots.length >= maxOutputRoots) throw Error('Review at most 128 physical Java output directories per module.');
    roots.push(dir);
  }
  roots.sort();
  const files = new Map();
  let entries = 0;
  async function walk(directory, depth = 0) {
    if (depth > 40) throw Error('The local Java output exceeds the review depth limit.');
    const handle = await fs.opendir(directory);
    for await (const entry of handle) {
      assertActive(cancellation);
      if (++entries > maxEntries) throw Error('The local Java output exceeds the review entry limit.');
      const file = path.join(directory,entry.name);
      if (entry.isSymbolicLink()) throw Error('Review Java class output directories without symbolic links.');
      if (entry.isDirectory()) {
        if (path.relative(file,await fs.realpath(file))) throw Error('The local Java output changed during review.');
        await walk(file,depth+1);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.class') || files.has(file)) continue;
      if (files.size >= maxClasses) throw Error('Review at most 5,000 local Java class files at a time.');
      if (path.relative(file,await fs.realpath(file))) throw Error('The local Java class path changed during review.');
      const handle = await fs.open(file,'r');
      try {
        const buffer = Buffer.alloc(8);
        const {bytesRead} = await handle.read(buffer,0,8,0);
        files.set(file,classVersion(buffer.subarray(0,bytesRead)));
      } finally { await handle.close(); }
    }
  }
  for (const directory of roots.filter(dir=>!roots.some(other=>other!==dir&&inside(other,dir)))) await walk(directory);
  const measured = [...files].map(([file, item]) => ({file:path.relative(physical,file),...item})).sort((a,b)=>a.file.localeCompare(b.file));
  const previews = [...new Set(measured.filter(item=>item.preview).map(item=>item.release))].sort((a,b)=>a-b);
  const minimum = measured.reduce((max,item)=>Math.max(max,item.release),0)||null;
  return {roots:roots.map(dir=>path.relative(physical,dir)),classFiles:measured.length,minimum,previews,
    fingerprint:digest([roots,measured]),representative:measured.find(item=>item.release===minimum)?.file??null};
}

async function probeJavaHome(home, cancellation) {
  assertActive(cancellation);
  if (!path.isAbsolute(home || '')) throw Error('Configure an absolute independent Java home.');
  const java = independentJavaExecutable(path.join(home,'bin',binary));
  const actual = path.dirname(path.dirname(java));
  const released = /(?:^|\n)JAVA_VERSION="([^"\r\n]+)"/u.exec(await fs.readFile(path.join(actual,'release'),'utf8'))?.[1];
  const env = Object.fromEntries(Object.entries(process.env).filter(([key])=>
    !/^(?:JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS|JDK_JAVAC_OPTIONS|CLASSPATH|JAVA_OPTIONS)$/iu.test(key)));
  const controller = new AbortController();
  const abort = () => controller.abort();
  let subscription;
  if (cancellation?.onCancellationRequested) subscription=cancellation.onCancellationRequested(abort);
  else cancellation?.addEventListener?.('abort',abort,{once:true});
  let reply;
  try {
    assertActive(cancellation);
    reply=await run(java,['-version'],{cwd:actual,env,signal:controller.signal,timeout:7000,maxBuffer:16384,windowsHide:true});
  } finally {
    subscription?.dispose();
    cancellation?.removeEventListener?.('abort',abort);
  }
  assertActive(cancellation);
  const version = /(?:^|\n)(?:openjdk|java) version "([^"\r\n]+)"/u.exec(reply.stdout+'\n'+reply.stderr)?.[1];
  const major = javaFeature(version);
  if (major===null || !released || released!==version) throw Error('The configured JVM version does not match its release file.');
  const stats = await fs.stat(java,{bigint:true});
  return {home:actual,major,version,identity:digest([java,released,String(stats.size),String(stats.mtimeNs),String(stats.ctimeNs),String(stats.ino)])};
}

function compatibility(runtime, output) {
  if (!output.classFiles) return {state:'unmeasured',requiresPreview:false};
  if (output.previews.length>1 || output.previews.length===1&&output.minimum>output.previews[0]) {
    return {state:'mixed-preview-output',requiresPreview:false};
  }
  if (output.previews.length===1) {
    return {state:runtime.major===output.previews[0]?'preview-required':'preview-version-mismatch',requiresPreview:runtime.major===output.previews[0]};
  }
  return {state:runtime.major>=output.minimum?'compatible':'below-classfile-target',requiresPreview:false};
}

async function reviewModuleRuntimes({ root, outputPaths, preferredHome, candidates, settings = {}, cancellation }={}) {
  if (!Array.isArray(candidates) || candidates.length>16) {
    throw Error('Review a bounded Java module and up to sixteen configured runtimes.');
  }
  if (!Array.isArray(outputPaths) || outputPaths.length>maxReportedPaths) {
    throw Error('The Java provider reported more than 5,000 runtime paths or returned an invalid path list.');
  }
  const output = await moduleOutput({root,outputPaths,cancellation}), observed = [], seen = new Set();
  for (const candidate of candidates) {
    assertActive(cancellation);
    try {
      const runtime = await probeJavaHome(candidate.home,cancellation);
      if (seen.has(runtime.home)) continue;
      seen.add(runtime.home);
      const declared = candidate.label?.startsWith('JavaSE-') ? javaFeature(candidate.label.slice(7)) : null;
      const status = declared&&declared!==runtime.major ? {state:'version-label-mismatch',requiresPreview:false} : compatibility(runtime,output);
      observed.push({...runtime,configuredHome:candidate.home,label:candidate.label||null,...status});
    } catch (error) {
      assertActive(cancellation);
      observed.push({home:candidate.home,label:candidate.label||null,state:'unavailable',requiresPreview:false});
    }
  }
  const preferred = preferredHome ? await fs.realpath(preferredHome).catch(()=>null) : null;
  const usable = new Set(['compatible','preview-required','unmeasured']);
  observed.sort((a,b)=>Number(usable.has(b.state))-Number(usable.has(a.state))||
    Number(b.home===preferred)-Number(a.home===preferred)||(a.major??999)-(b.major??999));
  const target = javaFeature(settings.target), source = javaFeature(settings.source ?? settings.compliance);
  const warnings = [];
  if (target && output.minimum && output.minimum>target) warnings.push('Class files target Java '+output.minimum+' but the imported compiler target is Java '+target+'.');
  if (output.previews.length && settings.preview==='disabled') warnings.push('Class files use preview features while the imported compiler has them disabled.');
  return {source,compliance:javaFeature(settings.compliance),target,previewSetting:settings.preview??null,output,candidates:observed,
    recommended:observed.find(item=>usable.has(item.state))?.home??null,warnings};
}

module.exports = {javaFeature,classVersion,moduleOutput,probeJavaHome,compatibility,reviewModuleRuntimes,maxReportedPaths};
