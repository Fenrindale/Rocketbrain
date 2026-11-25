'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { independentJavaExecutable } = require('./debug-runtime');
const { packageName,cancelled,inside,buildFingerprint,fail } = require('./workbench-model');
const helper = require('./mixed-jvm-classfile-source.json');

const run = promisify(execFile);
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const MAIN_SOURCES = ['src/main/java','src/main/kotlin'];
const CLASS_PATHS = {gradle:['build/classes/java/main','build/classes/kotlin/main'],maven:['target/classes']};

function inspectFiles(project,roots,accept,{count,bytes:budget,cancellation}) {
  const found = [];
  let size = 0, entries = 0;
  function visit(directory,depth) {
    if (depth > 32) throw fail('Mixed JVM files exceed 32 directory levels.');
    const handle = fs.opendirSync(directory);
    try {
      for (let entry; (entry = handle.readSync()) !== null;) {
        if (++entries > 8000 || cancelled(cancellation)) throw fail('Mixed JVM inspection exceeded its directory limit or was cancelled.');
        const file = path.join(directory,entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          visit(file,depth+1);
          continue;
        }
        if (!entry.isFile() || !accept(entry.name)) continue;
        const stat = fs.lstatSync(file);
        if (found.length >= count || !stat.isFile() || stat.isSymbolicLink() || stat.size > 512*1024 ||
            (size += stat.size) > budget || path.relative(file,fs.realpathSync(file))) {
          throw fail('Mixed JVM inspection requires bounded physical files in the selected source or class roots.');
        }
        const bytes = fs.readFileSync(file);
        if (bytes.length !== stat.size) throw fail('A mixed JVM file changed during inspection.');
        found.push({file,bytes,sha:digest(bytes)});
      }
    } finally { handle.closeSync(); }
  }
  for (const relative of roots) {
    const directory = path.join(project.root,relative);
    if (!fs.existsSync(directory)) continue;
    const stat = fs.lstatSync(directory), real = fs.realpathSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || path.relative(directory,real) || !inside(project.root,real)) {
      throw fail('Use physical main source and output directories inside the mixed JVM project.');
    }
    visit(real,0);
  }
  return found.sort((a,b) => a.file.localeCompare(b.file));
}

function mixedSources(project,cancellation) {
  const files = inspectFiles(project,MAIN_SOURCES,name => /\.(?:kt|java)$/.test(name),{count:240,bytes:8*1024*1024,cancellation});
  return files.map(({file,bytes,sha}) => {
    const text = new TextDecoder('utf-8',{fatal:true}).decode(bytes);
    const language = file.endsWith('.kt') ? 'kotlin' : 'java';
    const pkg = packageName(text,language);
    return {file,text,sha,language,package:pkg};
  });
}

function compiledClasses(project,cancellation) {
  const roots = CLASS_PATHS[project.tool];
  if (!roots) throw fail('Choose a mixed Gradle or Maven project.');
  return inspectFiles(project,roots,name => name.endsWith('.class'),{count:500,bytes:24*1024*1024,cancellation});
}

const fingerprint = files => JSON.stringify(files.map(({file,sha}) => [file,sha]));

function snapshotMixedSources(project,cancellation) {
  const files = mixedSources(project,cancellation);
  if (!files.some(file => file.language === 'java') || !files.some(file => file.language === 'kotlin')) {
    throw fail('The conventional main roots must contain saved Java and Kotlin sources.');
  }
  return {files,fingerprint:fingerprint(files),buildFingerprint:buildFingerprint(project.root)};
}

function parseClasses(output,count) {
  const classes = [], names = new Set();
  for (const row of output.replace(/\r?\n$/,'').split(/\r?\n/)) {
    const [kind,rawIndex,...values] = row.split('\t'), index = Number(rawIndex);
    if (!Number.isSafeInteger(index) || index < 0 || index >= count) throw fail('Invalid JDK class-file report.');
    if (kind === 'class' && values.length === 3) {
      const [name,source,superName] = values;
      if (classes[index] || names.has(name)) throw fail('Mixed JVM compilation returned duplicate binary names.');
      names.add(name);
      classes[index] = {name,source,superName,methods:[],calls:[]};
    } else if (classes[index] && kind === 'method' && values.length === 3) {
      const [name,descriptor,line] = values;
      classes[index].methods.push({name,descriptor,line:Number(line)});
    } else if (classes[index] && kind === 'call' && values.length === 4) {
      const [line,owner,name,descriptor] = values;
      classes[index].calls.push({line:Number(line),owner,name,descriptor});
    } else {
      throw fail('Invalid JDK class-file report.');
    }
  }
  if (classes.filter(Boolean).length !== count) throw fail('The JDK class-file report is incomplete.');
  return classes;
}

async function analyzeMixedClasses({project,sources,javaHome,storagePath,cancellation}) {
  const files = compiledClasses(project,cancellation);
  if (!files.length) throw fail('Build the conventional main output folders before indexing mixed Java/Kotlin classes.');
  const executable = independentJavaExecutable(path.join(javaHome,'bin',process.platform === 'win32' ? 'java.exe' : 'java'));
  await fsp.mkdir(storagePath,{recursive:true});
  const parent = await fsp.realpath(storagePath);
  const workspace = await fsp.mkdtemp(path.join(parent,'mixed-classfiles-'));
  const controller = new AbortController();
  const subscription = cancellation?.onCancellationRequested?.(() => controller.abort());
  const original = fingerprint(files);
  try {
    const program = path.join(workspace,'MixedClassInspector.java'), list = path.join(workspace,'classes.txt');
    const copies = files.map((_,index) => path.join(workspace,index+'.class'));
    await fsp.writeFile(program,helper,{flag:'wx'});
    await fsp.writeFile(list,copies.map(file => Buffer.from(file).toString('base64')).join('\n'),{flag:'wx'});
    for (const [index,file] of files.entries()) {
      if (cancelled(cancellation)) throw fail('Mixed JVM inspection was cancelled.');
      await fsp.writeFile(copies[index],file.bytes,{flag:'wx'});
    }
    if (cancelled(cancellation)) throw fail('Mixed JVM inspection was cancelled.');
    const env = {...process.env};
    for (const key of Object.keys(env)) if (['JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','_JAVA_OPTIONS','CLASSPATH'].includes(key.toUpperCase())) delete env[key];
    const {stdout} = await run(executable,['--source','25',program,list],{
      cwd:workspace,env,windowsHide:true,timeout:30000,maxBuffer:8*1024*1024,signal:controller.signal
    });
    const classes = parseClasses(stdout,files.length);
    const index = {project,sources,classes,classFingerprint:original};
    assertMixedCurrent(index,cancellation);
    return index;
  } finally {
    subscription?.dispose();
    const verified = await fsp.realpath(workspace);
    if (path.dirname(verified) !== parent || !path.basename(verified).startsWith('mixed-classfiles-')) {
      throw fail('Mixed JVM compiler inspection storage changed before cleanup.');
    }
    await fsp.rm(verified,{recursive:true,force:true,maxRetries:5,retryDelay:150});
  }
}

function assertMixedCurrent(index,cancellation) {
  const current = snapshotMixedSources(index.project,cancellation);
  if (current.fingerprint !== index.sources.fingerprint || current.buildFingerprint !== index.sources.buildFingerprint ||
      fingerprint(compiledClasses(index.project,cancellation)) !== index.classFingerprint) {
    throw fail('Mixed JVM source, build or output files changed. Build and index the project again.');
  }
}

module.exports = { snapshotMixedSources,analyzeMixedClasses,assertMixedCurrent };
