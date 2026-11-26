'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { buildSpec } = require('./workbench-tasks');
const { resolveBuildTarget } = require('./source-target-builds');
const { pomFacts } = require('./dependency-builds');
const { execute } = require('./testing/provision');
const { fail, hash, inside } = require('./workbench-model');

const MODULE = /^(?:[A-Za-z0-9_][\w.-]*\/)*[A-Za-z0-9_][\w.-]*$/u;
const id = value => [value?.group,value?.artifact,value?.version].join(':');
const key = value => [value?.group,value?.artifact].join(':');
const label = file => pathToFileURL(file).href;

function physical(directory, boundary) {
  if (!inside(boundary,directory) || path.relative(directory,fs.realpathSync(directory)) ||
      !fs.lstatSync(directory).isDirectory()) throw fail('Choose a physical module inside the Maven reactor.');
  return directory;
}

function isReactorComponent(project, workspace, dirty = () => false) {
  return Boolean(resolveBuildTarget(project,workspace,dirty).build.reactorRoot);
}

function reviewKotlinReactor({project,workspace,tools,dirty = () => false}) {
  physical(project,workspace);
  const selection=resolveBuildTarget(project,workspace,dirty);
  const {reactorRoot:root,reactorProject:module}=selection.build;
  if (!root || !MODULE.test(module||'') || path.relative(path.resolve(root,module),project)) {
    throw fail('Open a Kotlin file in a declared Maven reactor application module.');
  }
  physical(root,workspace);
  const watched = new Map();
  const sourceFiles = new Map();
  let visitedFiles=0,sourceBytes=0;
  function read(file, required) {
    const stat=fs.lstatSync(file,{throwIfNoEntry:false});
    if (dirty(file)) throw fail('Save Maven descriptors before reviewing the Kotlin reactor.');
    if (!stat && !required) {
      watched.set(file,null);
      return;
    }
    if (!stat?.isFile() || stat.isSymbolicLink() || stat.size>1024*1024 || path.relative(file,fs.realpathSync(file))) {
      throw fail('The Maven reactor descriptors must be bounded physical files.');
    }
    const bytes=fs.readFileSync(file);
    if (bytes.length>1024*1024) throw fail('The Maven reactor descriptor grew during review.');
    watched.set(file,hash(bytes));
    return {path:file,uri:label(file),text:new TextDecoder('utf-8',{fatal:true}).decode(bytes)};
  }
  const model=(directory,selector)=>{
    for (const name of ['extensions.xml','jvm.config','maven.config']) {
      const config=read(path.join(directory,'.mvn',name),false);
      if (config && (name!=='maven.config'||config.text.split(/\r?\n/u).some(line=>line.trim()&&!line.trim().startsWith('#')))) {
        throw fail('Maven project extensions, arguments and JVM options require separate reactor preparation.');
      }
    }
    const descriptor=read(path.join(directory,'pom.xml'),true),facts=pomFacts(descriptor);
    if (facts.profiles || /<(?:[\w.-]+:)?extensions(?:\s|>)/iu.test(descriptor.text) ||
        !facts.gav.group || !facts.gav.artifact || !facts.gav.version) {
      throw fail('Use literal Maven reactor coordinates without profiles or project extensions.');
    }
    return {...facts,selector,directory};
  };
  const parent=model(root,'.');
  if (parent.packaging!=='pom'||!parent.modules.length||parent.modules.length>24||parent.modules.some(name=>!MODULE.test(name))) {
    throw fail('Use a bounded Maven reactor with literal module paths.');
  }
  const modules=new Map(),coordinates=new Map([[key(parent.gav),parent]]);
  for (const selector of parent.modules) {
    const directory=physical(path.join(root,selector),root);
    const child=model(directory,selector);
    if (child.modules.length||coordinates.has(key(child.gav))||modules.has(selector)) {
      throw fail('Use a flat reactor with distinct Maven module coordinates.');
    }
    modules.set(selector,child);
    coordinates.set(key(child.gav),child);
  }
  const application=modules.get(module);
  if (!application || application.packaging!=='jar') throw fail('Choose a declared Maven application JAR module.');
  const dependenciesOf = entry => {
    const declared=entry.parent&&id(entry.parent)===id(parent.gav)
      ? [...parent.dependencies,...entry.dependencies] : entry.dependencies;
    const found=new Set();
    for (const dependency of declared) {
      const candidate=coordinates.get(key(dependency));
      if (!candidate) continue;
      if (id(dependency)!==id(candidate.gav) || candidate.packaging!=='jar'||dependency.type!=='jar'||dependency.classifier||
          !['compile','provided'].includes(dependency.scope)) {
        throw fail('Use literal reactor JAR versions with compile or provided scope for this workflow.');
      }
      if (candidate===application) throw fail('The dependency build requires the selected application. Inspect the Maven dependency cycle.');
      found.add(candidate);
    }
    return [...found];
  };
  const dependencies=new Set(),visiting=new Set();
  function visit(entry) {
    if (visiting.has(entry)) throw fail('The Maven reactor has a cyclic dependency.');
    if (dependencies.has(entry)) return;
    visiting.add(entry);
    for (const dependency of dependenciesOf(entry)) visit(dependency);
    visiting.delete(entry);
    dependencies.add(entry);
  }
  const direct=dependenciesOf(application);
  for (const dependency of direct) visit(dependency);
  if (!dependencies.size) throw fail('This application module has no matched literal reactor JAR dependencies.');
  function captureSources(directory) {
    const root=path.join(directory,'src');
    if (!fs.existsSync(root)) return;
    const pending=[physical(root,directory)];
    for (const folder of pending) {
      const entries=fs.readdirSync(folder,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (++visitedFiles>12000) throw fail('The reviewed Kotlin reactor source tree is too large.');
        const file=path.join(folder,entry.name);
        if (entry.isSymbolicLink()) throw fail('Use physical Maven dependency source directories.');
        if (entry.isDirectory()) pending.push(file);
        if (!/\.(?:kt|java)$/u.test(entry.name)||!entry.isFile()) continue;
        const stat=fs.lstatSync(file);
        if (stat.isSymbolicLink()||stat.size>1024*1024||dirty(file)) throw fail('Save bounded Maven dependency source files before reviewing.');
        const bytes=fs.readFileSync(file);
        if (bytes.length>1024*1024||(sourceBytes+=bytes.length)>24*1024*1024) {
          throw fail('The reviewed Kotlin reactor dependency sources exceed their size limit.');
        }
        sourceFiles.set(file,hash(bytes));
      }
    }
  }
  for (const dependency of dependencies) captureSources(dependency.directory);
  const selected=[parent,...dependencies];
  const spec=buildSpec({root,uri:label(root),name:path.basename(root),tool:'maven'},tools,['install']);
  for (const name of Object.keys(spec.env)) {
    if (/^(?:MAVEN_ARGS|MAVEN_OPTS|MAVEN_BASEDIR|MAVEN_PROJECTBASEDIR|MAVEN_DEBUG_OPTS|JAVA_OPTS|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS|CLASSPATH)$/iu.test(name)) {
      delete spec.env[name];
    }
  }
  const args=['--file',path.join(root,'pom.xml'),'--projects',selected.map(entry=>entry.selector).join(','),
    '-Dmaven.test.skip=true','-Dkotlin.compiler.daemon=false'];
  const report={root,project,module,command:spec.command,args:[...spec.args,...args],
    dependencies:[...dependencies].map(entry=>({module:entry.selector,coordinates:id(entry.gav),directory:entry.directory})),
    steps:selected.map(entry=>entry.selector),localRepository:'Owned editor-session repository'};
  const toolFiles=[spec.command,path.join(path.dirname(path.dirname(spec.command)),'release'),
    spec.args[spec.args.indexOf('-cp')+1],spec.args.find(arg=>arg.startsWith('-Dclassworlds.conf=')).slice('-Dclassworlds.conf='.length)];
  const toolState=toolFiles.map(file=>{
    const stat=fs.statSync(file,{bigint:true});
    return [file,String(stat.size),String(stat.ino),String(stat.mtimeNs)];
  });
  const fingerprint=hash({selection:selection.fingerprint,report,files:[...watched],sources:[...sourceFiles],toolState});
  return {report,spec:{...spec,args:report.args},dependencies:[...dependencies],watched,fingerprint};
}

function artifact(repository,{gav}) {
  return path.join(repository,...gav.group.split('.'),gav.artifact,gav.version,gav.artifact+'-'+gav.version+'.jar');
}

async function prepareKotlinReactor(plan,{cancellation,onOutput}={}) {
  const parent=await fsp.realpath(os.tmpdir()),home=await fsp.mkdtemp(path.join(parent,'rb-kotlin-maven-'));
  const identity=await fsp.lstat(home,{bigint:true});
  const repository=path.join(home,'.m2','repository');
  let removed=false;
  async function dispose() {
    if (removed) return;
    const actual=await fsp.realpath(home),stat=await fsp.lstat(actual,{bigint:true});
    if (path.relative(home,actual)||path.relative(parent,path.dirname(actual))||!path.basename(actual).startsWith('rb-kotlin-maven-')||
        stat.ino!==identity.ino||stat.dev!==identity.dev) throw fail('The Kotlin Maven repository ownership changed.');
    await fsp.rm(actual,{recursive:true,force:true,maxRetries:8,retryDelay:250});
    removed=true;
  }
  try {
    const spec=plan.spec;
    const run=await execute(spec.command,[...spec.args,'-Dmaven.repo.local='+repository],{
      cwd:spec.cwd,env:spec.env,onOutput,cancellation,timeoutMs:240000});
    if (run.cancelled) throw fail('Kotlin Maven reactor preparation was cancelled.');
    if (run.timedOut||run.code!==0) throw fail('Maven could not install the reviewed dependencies. See the Rocketbrain Kotlin Editor output.');
    const artifacts=[];
    for (const dependency of plan.dependencies) {
      const file=artifact(repository,dependency),stat=await fsp.lstat(file);
      if (!stat.isFile()||stat.isSymbolicLink()||stat.size<=0||path.relative(file,await fsp.realpath(file))) {
        throw fail('A reviewed Maven reactor dependency JAR was not installed.');
      }
      artifacts.push({coordinates:id(dependency.gav),file});
    }
    return {home,repository,root:plan.report.root,project:plan.report.project,module:plan.report.module,watched:plan.watched,
      dependencies:plan.report.dependencies,artifacts,dispose};
  } catch(error) {
    await dispose();
    throw error;
  }
}

module.exports={isReactorComponent,reviewKotlinReactor,prepareKotlinReactor};
