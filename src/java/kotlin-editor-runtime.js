'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { createReadStream,existsSync,realpathSync } = require('node:fs');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { pathToFileURL } = require('node:url');
const { independentJavaExecutable } = require('./debug-runtime');
const { inside,fail } = require('./workbench-model');
const windowsSource = require('./kotlin-editor-windows-source.json');

const execute=promisify(execFile);

const VERSION='1.4.0-rc1';
const COMPILER='2.2.21';
const DISTRIBUTION='https://codeberg.org/winlogon/ktlsp/releases/download/v1.4.0-rc1/server.zip';
const ARCHIVE_SHA256='27d33f2879d12076174741488721896098e8494f5d906f99ef1c85d6159d42b7';
const RELEASES=new Map([
  [`server-${VERSION}.jar`,'eb2acaba43c66e46dcb0d2df38d121b670a242a69b8171c7ec615e856796cc41'],
  [`kotlin-compiler-${COMPILER}.jar`,'0885d5546e3a18d8509ae99aaf735decc7b88e0c33fc0287b5f74bc085a7cff5']
]);

const BUILD=['build.gradle','build.gradle.kts'];
const SETTINGS=['settings.gradle','settings.gradle.kts'];

function hasGradleFiles(root) {
  return BUILD.some(name => existsSync(path.join(root,name))) && SETTINGS.some(name => existsSync(path.join(root,name)));
}

function kotlinProtocolUri(file) {
  const absolute=existsSync(file) ? realpathSync(file) : path.resolve(file);
  // Match Java Path.toUri() for Unicode names while retaining ASCII URI delimiters and escapes.
  return pathToFileURL(absolute).href.replace(/(?:%[89A-F][0-9A-F])+/gi,bytes => decodeURIComponent(bytes));
}

async function physical(file,root,max) {
  const real=await fs.realpath(file), stat=await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size>max || path.relative(real,file) || !inside(root,real)) {
    throw fail('Choose regular physical files in the extracted Kotlin engine or Gradle project.');
  }
  return real;
}

async function hash(file) {
  const value=createHash('sha256');
  for await (const chunk of createReadStream(file)) value.update(chunk);
  return value.digest('hex');
}

async function windowsOverlay(jdk,java,library,env) {
  if (process.platform!=='win32') return {file:undefined,async dispose(){}};
  const parent=await fs.realpath(os.tmpdir()), stage=await fs.mkdtemp(path.join(parent,'rb-ktlsp-'));
  const identity=await fs.lstat(stage,{bigint:true});
  let removed=false;
  async function dispose() {
    if (removed) return;
    const resolved=await fs.realpath(stage), current=await fs.lstat(resolved,{bigint:true});
    if (path.relative(stage,resolved) || path.relative(parent,path.dirname(resolved)) || !path.basename(resolved).startsWith('rb-ktlsp-') ||
        current.dev!==identity.dev || current.ino!==identity.ino) throw fail('The Kotlin engine staging directory identity changed.');
    await fs.rm(resolved,{recursive:true,force:true,maxRetries:8,retryDelay:250});
    removed=true;
  }
  try {
    const compiler=path.join(library,`kotlin-compiler-${COMPILER}.jar`);
    const entry=path.join(stage,'KtlspWindowsPath.java'), overlay=path.join(stage,'windows-path.jar');
    await fs.writeFile(entry,windowsSource,{flag:'wx'});
    const options={cwd:stage,env,windowsHide:true,timeout:20000,maxBuffer:1024*1024};
    await execute(path.join(jdk,'bin','javac.exe'),['--release','17','-encoding','UTF-8','-cp',compiler,'-d',stage,entry],options);
    await execute(java,['-cp',[stage,compiler].join(path.delimiter),'rocketbrain.ktlsp.PathFixTool',
      path.join(library,`server-${VERSION}.jar`),overlay],options);
    return {file:await physical(overlay,stage,1024*1024),dispose};
  } catch (error) {
    await dispose();
    throw fail('Could not prepare the ktlsp Windows path adapter. '+String(error.stderr || error.message).slice(-3000));
  }
}

async function kotlinEditorLaunch({serverHome,javaHome,gradleHome,gradleUserHome,storageRoot,root}) {
  if (!path.isAbsolute(serverHome || '')) throw fail('Set rocketbrain.kotlinEditor.serverHome to the extracted open ktlsp '+VERSION+' server directory.');
  if (!path.isAbsolute(root || '') || !hasGradleFiles(root)) throw fail('Start Kotlin editing in a local Gradle root with settings and build files.');
  const project=await fs.realpath(root);
  for (const name of [...BUILD,...SETTINGS]) {
    const file=path.join(project,name);
    if (existsSync(file)) await physical(file,project,1024*1024);
  }
  const home=await fs.realpath(serverHome), library=path.join(home,'lib');
  if (path.relative(library,await fs.realpath(library))) throw fail('Use the physical ktlsp distribution library directory.');
  const entries=await fs.readdir(library,{withFileTypes:true});
  const jars=entries.filter(entry => entry.name.endsWith('.jar'));
  if (entries.length>80 || jars.length<20 || ![`shared-${VERSION}.jar`,`kotlin-stdlib-${COMPILER}.jar`,...RELEASES.keys()]
    .every(name => jars.some(file => file.name===name))) throw fail('The extracted standalone ktlsp release has missing or unsupported libraries.');
  let size=0;
  for (const entry of jars) {
    const f=await physical(path.join(library,entry.name),home,96*1024*1024);
    size+=(await fs.stat(f)).size;
    if (size>160*1024*1024) throw fail('The standalone Kotlin engine library footprint exceeds the supported release.');
    const expected=RELEASES.get(entry.name);
    if (expected && await hash(f)!==expected) throw fail('Kotlin server or compiler JAR differs from the supported open ktlsp release.');
  }
  const command=independentJavaExecutable(javaHome && path.join(javaHome,'bin',process.platform==='win32'?'java.exe':'java'));
  const jdk=path.dirname(path.dirname(command)), release=await fs.readFile(path.join(jdk,'release'),'utf8');
  if (Number(/^JAVA_VERSION="(\d+)/m.exec(release)?.[1] || 0)<21) throw fail('Standalone ktlsp needs an independent JDK 21 or later.');
  if (!path.isAbsolute(storageRoot || '')) throw fail('Kotlin language support needs a local extension storage directory.');
  const identity=createHash('sha256').update(home+'\0'+project+'\0'+jdk).digest('hex').slice(0,20);
  const storage=path.join(storageRoot,'ktlsp',identity);
  const env={...process.env,JAVA_HOME:jdk};
  for (const key of ['JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','_JAVA_OPTIONS','KOTLIN_LANGUAGE_SERVER_OPTS']) delete env[key];
  if (gradleHome) {
    if (!path.isAbsolute(gradleHome)) throw fail('Use an absolute Gradle installation path for Kotlin support.');
    const bin=path.join(await fs.realpath(gradleHome),'bin');
    if (!(await fs.stat(path.join(bin,process.platform==='win32'?'gradle.bat':'gradle'))).isFile()) throw fail('Choose an independent Gradle distribution.');
    const inherited=Object.keys(env).find(name => name.toLowerCase()==='path') || 'PATH';
    env[inherited]=[bin,env[inherited]].filter(Boolean).join(path.delimiter);
  }
  if (gradleUserHome) {
    if (!path.isAbsolute(gradleUserHome)) throw fail('Use an absolute Gradle user home for Kotlin editing.');
    await fs.mkdir(gradleUserHome,{recursive:true});
    env.GRADLE_USER_HOME=await fs.realpath(gradleUserHome);
  }
  const overlay=await windowsOverlay(jdk,command,library,env);
  // The open server's SQLite driver fails on deep Windows VS Code profile paths.
  const localStorage=overlay.file && storage.length>200 ? path.join(path.dirname(overlay.file),'cache') : storage;
  try {
    await fs.mkdir(localStorage,{recursive:true});
    env.KLS_HOME=await fs.realpath(localStorage);
  } catch (error) {
    await overlay.dispose();
    throw error;
  }
  const classpath=[overlay.file,path.join(library,'*')].filter(Boolean).join(path.delimiter);
  return {command,args:['-Dfile.encoding=UTF-8','-DkotlinLanguageServer.version='+VERSION,'-Xmx1536m','-XX:ActiveProcessorCount=4',
    '-cp',classpath,'org.javacs.kt.MainKt'],options:{cwd:project,env,windowsHide:true},
    root:project,serverVersion:VERSION,compilerVersion:COMPILER,windowsPathAdapter:Boolean(overlay.file),dispose:overlay.dispose};
}

module.exports={kotlinEditorLaunch,hasGradleFiles,kotlinProtocolUri,VERSION,COMPILER,DISTRIBUTION,ARCHIVE_SHA256};
