'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { SaxesParser } = require('saxes');
const { createHash } = require('node:crypto');
const { constants,createReadStream,existsSync,realpathSync } = require('node:fs');
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
const MAVEN_POM='pom.xml';
const CLASS_PATH_SCRIPT=/^(?:kls-classpath|kotlinLspClasspath)(?:\.(?:sh|bash|bat|cmd|ps1))?$/iu;

function hasGradleFiles(root) {
  return BUILD.some(name => existsSync(path.join(root,name))) && SETTINGS.some(name => existsSync(path.join(root,name)));
}

function kotlinBuildTool(root) {
  const gradle=hasGradleFiles(root),maven=existsSync(path.join(root,MAVEN_POM));
  if (gradle && maven) throw fail('This Kotlin folder has both Maven and Gradle build files. Open a component with one build tool.');
  return maven?'maven':gradle?'gradle':undefined;
}

function kotlinProjectRoot(source, boundary) {
  let directory=path.dirname(source);
  for (let depth=0; depth<24 && inside(boundary,directory); depth++) {
    if (kotlinBuildTool(directory)) return directory;
    const parent=path.dirname(directory);
    if (!path.relative(directory,parent)) break;
    directory=parent;
  }
}

function isMavenClasspathFile(name) {
  return name===MAVEN_POM || BUILD.includes(name) || CLASS_PATH_SCRIPT.test(name);
}

async function validateMavenComponent(project) {
  const pom=await physical(path.join(project,MAVEN_POM),project,1024*1024);
  const parser=new SaxesParser({xmlns:true});
  let rootElement,modules=false;
  const elements=[];
  parser.on('opentag',tag=>{
    rootElement??=tag.local;
    elements.push(tag.local);
    if (tag.local==='modules') {
      const location=elements.join('/');
      modules ||= location==='project/modules'||location==='project/profiles/profile/modules';
    }
  });
  parser.on('closetag',()=>elements.pop());
  parser.on('doctype',()=>{throw fail('Use a Maven POM without a document type declaration.');});
  parser.write(await fs.readFile(pom,'utf8')).close();
  if (rootElement!=='project') throw fail('Choose a valid Maven project POM for Kotlin editing.');
  if (modules) throw fail('Open a Kotlin source in a Maven component with its own POM. Reactor aggregation is outside this editor session.');

  // ktlsp joins every classpath provider it finds below the workspace root.
  const queue=[project];
  let count=0;
  for (const directory of queue) {
    for (const entry of await fs.readdir(directory,{withFileTypes:true})) {
      if (++count>20000) throw fail('Open a smaller physical Maven component for Kotlin editing.');
      const file=path.join(directory,entry.name);
      if (entry.isSymbolicLink()) throw fail('Use a physical Maven component without linked files or directories for Kotlin editing.');
      if (entry.isDirectory()) queue.push(file);
      else if (isMavenClasspathFile(entry.name) && path.relative(file,pom)) {
        throw fail('Open an individual Maven Kotlin component with one POM and no additional classpath provider.');
      }
    }
  }
  return pom;
}

function addPath(env,bin) {
  const inherited=Object.keys(env).find(name=>name.toLowerCase()==='path')||'PATH';
  env[inherited]=[bin,env[inherited]].filter(Boolean).join(path.delimiter);
}

async function configureMaven(env,mavenHome) {
  if (!path.isAbsolute(mavenHome||'')) throw fail('Set rocketbrain.java.mavenHome to an independent Apache Maven distribution for Kotlin editing.');
  const home=await fs.realpath(mavenHome),bin=path.join(home,'bin');
  const launcher=await physical(path.join(bin,process.platform==='win32'?'mvn.cmd':'mvn'),home,1024*1024);
  await fs.access(launcher,constants.X_OK);
  await physical(path.join(bin,'m2.conf'),home,1024*1024);
  if (!(await fs.readdir(path.join(home,'boot'))).some(name=>/^plexus-classworlds-[\d.]+\.jar$/u.test(name))) {
    throw fail('Choose an independent Apache Maven distribution with its classworlds runtime.');
  }
  for (const key of Object.keys(env)) {
    if (['MAVEN_ARGS','MAVEN_OPTS','MAVEN_HOME','M2_HOME','MAVEN_SKIP_RC'].includes(key.toUpperCase())) delete env[key];
  }
  env.MAVEN_HOME=home;
  env.MAVEN_SKIP_RC='1';
  addPath(env,bin);
}

function kotlinProtocolUri(file) {
  const absolute=existsSync(file) ? realpathSync(file) : path.resolve(file);
  // Match Java Path.toUri() for Unicode names while retaining ASCII URI delimiters and escapes.
  return pathToFileURL(absolute).href.replace(/(?:%[89A-F][0-9A-F])+/gi,bytes => decodeURIComponent(bytes));
}

async function physical(file,root,max) {
  const real=await fs.realpath(file), stat=await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size>max || path.relative(real,file) || !inside(root,real)) {
    throw fail('Choose regular physical files in the extracted Kotlin engine or selected JVM project.');
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

async function kotlinEditorLaunch({serverHome,javaHome,gradleHome,gradleUserHome,mavenHome,storageRoot,root}) {
  if (!path.isAbsolute(serverHome || '')) throw fail('Set rocketbrain.kotlinEditor.serverHome to the extracted open ktlsp '+VERSION+' server directory.');
  if (!path.isAbsolute(root||'')) throw fail('Start Kotlin editing in a local Gradle or Maven project.');
  const project=await fs.realpath(root);
  if (path.relative(project,root)) throw fail('Choose the physical local Kotlin project directory.');
  const buildTool=kotlinBuildTool(project);
  if (!buildTool) throw fail('Start Kotlin editing in a local Gradle or Maven project.');
  if (buildTool==='maven') await validateMavenComponent(project);
  else {
    for (const name of [...BUILD,...SETTINGS]) {
      const file=path.join(project,name);
      if (existsSync(file)) await physical(file,project,1024*1024);
    }
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
  const identity=createHash('sha256').update(home+'\0'+project+'\0'+jdk+'\0'+buildTool).digest('hex').slice(0,20);
  const storage=path.join(storageRoot,'ktlsp',identity);
  const env={...process.env,JAVA_HOME:jdk};
  for (const key of ['JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','_JAVA_OPTIONS','KOTLIN_LANGUAGE_SERVER_OPTS']) delete env[key];
  if (buildTool==='maven') await configureMaven(env,mavenHome);
  if (buildTool==='gradle' && gradleHome) {
    if (!path.isAbsolute(gradleHome)) throw fail('Use an absolute Gradle installation path for Kotlin support.');
    const bin=path.join(await fs.realpath(gradleHome),'bin');
    if (!(await fs.stat(path.join(bin,process.platform==='win32'?'gradle.bat':'gradle'))).isFile()) throw fail('Choose an independent Gradle distribution.');
    addPath(env,bin);
  }
  if (buildTool==='gradle' && gradleUserHome) {
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
    root:project,buildTool,serverVersion:VERSION,compilerVersion:COMPILER,windowsPathAdapter:Boolean(overlay.file),dispose:overlay.dispose,
    compiler:{javaHome:jdk,java:command,libraries:jars.map(entry=>path.join(library,entry.name)).sort(),
      stdlib:path.join(library,`kotlin-stdlib-${COMPILER}.jar`)}};
}

module.exports={kotlinEditorLaunch,hasGradleFiles,kotlinBuildTool,kotlinProjectRoot,kotlinProtocolUri,
  isMavenClasspathFile,validateMavenComponent,VERSION,COMPILER,DISTRIBUTION,ARCHIVE_SHA256};
