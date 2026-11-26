'use strict';

const fs=require('node:fs');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {lexJava}=require('../spring/java');
const {cancelled,fail}=require('./workbench-model');

const nativeGradleInit=`
def selected = new File(System.getProperty('rocketbrain.quarkus.native.root')).canonicalFile
def isolated = new File(System.getProperty('rocketbrain.quarkus.native.output')).canonicalFile
gradle.settingsEvaluated { settings ->
    if (settings.settingsDir.canonicalFile != selected || !settings.rootProject.children.isEmpty()) {
        throw new GradleException('Select one standalone Gradle Quarkus root for Native Image.')
    }
}
gradle.beforeProject { project ->
    if (project.path != ':' || project.projectDir.canonicalFile != selected) {
        throw new GradleException('The selected Quarkus Gradle root changed.')
    }
    project.layout.buildDirectory.set(isolated)
    project.layout.buildDirectory.disallowChanges()
}
gradle.projectsEvaluated { build ->
    if (!build.includedBuilds.isEmpty() || build.rootProject.layout.buildDirectory.get().asFile.canonicalFile != isolated) {
        throw new GradleException('Use a standalone Quarkus project and its private Native Image build directory.')
    }
}
`;
const rootFiles=['build.gradle','build.gradle.kts','settings.gradle','settings.gradle.kts','gradle.properties','gradle.lockfile'];
const external=new Set(['include','includeBuild','projectDir','sourceSets','srcDir','srcDirs','setSrcDirs','buildDir','buildDirectory',
  'flatDir','fileTree','files']);
const MAX_BYTES=32*1024*1024, MAX_FILE_BYTES=4*1024*1024, MAX_ENTRIES=4000;

function physical(file, kind, optional=false) {
  let stat;
  try {stat=fs.lstatSync(file,{bigint:true});}
  catch(error){if(optional&&error.code==='ENOENT')return undefined;throw error;}
  if(stat.isSymbolicLink()||path.relative(file,fs.realpathSync(file))||
      !(kind==='directory'?stat.isDirectory():stat.isFile()))throw fail('Use physical files in the selected Quarkus Gradle application.');
  return stat;
}

function checkGradleLayout(bytes) {
  const {tokens,issues}=lexJava(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  if(issues.length||tokens.some((token,index)=>token.kind==='id'&&(external.has(token.text)||
      token.text==='apply'&&tokens.slice(index+1,index+6).some(item=>item.text==='from')))) {
    throw fail('Use conventional sources and dependencies in one standalone Quarkus Gradle application.');
  }
}

function gradleNativeInputs(project,cancellation) {
  const {root}=project, rootIdentity=physical(root,'directory'), inputs=[];
  let total=0, entries=0;
  const steady=()=>{
    if(cancelled(cancellation))throw fail('The Quarkus native input check was cancelled.');
  };
  function include(file, script=false) {
    steady();
    const first=physical(file,'file');
    if(first.size>BigInt(MAX_FILE_BYTES)||(total+=Number(first.size))>MAX_BYTES) {
      throw fail('The Quarkus Gradle Native Image input exceeds its byte limit.');
    }
    const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
    try {
      const bytes=fs.readFileSync(fd), last=fs.fstatSync(fd,{bigint:true}), current=physical(file,'file');
      if(bytes.length!==Number(first.size)||['dev','ino','size','mtimeNs','ctimeNs'].some(key=>first[key]!==last[key]||first[key]!==current[key])) {
        throw fail('A Quarkus Gradle native input changed during inspection.');
      }
      if(script)checkGradleLayout(bytes);
      inputs.push([path.relative(root,file).split(path.sep).join('/'),createHash('sha256').update(bytes).digest('hex')]);
    } finally {fs.closeSync(fd);}
  }
  function visit(folder, depth) {
    if(depth>24)throw fail('The Quarkus Gradle native source tree exceeds its depth limit.');
    physical(folder,'directory');
    const directory=fs.opendirSync(folder);
    try{
      for(let entry;(entry=directory.readSync());){
        steady();
        if(++entries>MAX_ENTRIES)throw fail('The Quarkus Gradle native source tree exceeds its entry limit.');
        const file=path.join(folder,entry.name);
        if(entry.isDirectory())visit(file,depth+1);
        else if(entry.isFile())include(file);
        else throw fail('Use unlinked conventional sources for the Quarkus Gradle native build.');
      }
    }finally{directory.closeSync();}
  }
  for(const name of ['buildSrc','build-logic']){
    if(physical(path.join(root,name),'directory',true))throw fail('Use a standalone Quarkus Gradle application without local build logic.');
  }
  for(const name of rootFiles){
    const file=path.join(root,name);
    if(physical(file,'file',true))include(file,/\.gradle(?:\.kts)?$/u.test(name));
  }
  const sources=path.join(root,'src');
  if(!physical(sources,'directory',true))throw fail('Choose a saved Quarkus Gradle application with conventional sources.');
  visit(sources,0);
  const gradle=path.join(root,'gradle');
  if(physical(gradle,'directory',true))visit(gradle,0);
  if(!inputs.some(([name])=>/^src\/main\/java\/.+\.java$/u.test(name))) {
    throw fail('Choose a Quarkus Gradle application with Java sources under src/main/java.');
  }
  inputs.sort(([a],[b])=>a<b?-1:a>b?1:0);
  return createHash('sha256').update(JSON.stringify([String(rootIdentity.dev),String(rootIdentity.ino),inputs])).digest('hex');
}

function nativeGradleArgs(root, output, initFile, graalvmHome) {
  return ['--no-build-cache','--no-configuration-cache','--rerun-tasks','--init-script',initFile,
    '-Drocketbrain.quarkus.native.root='+root,'-Drocketbrain.quarkus.native.output='+output,
    '-Dquarkus.native.enabled=true','-Dquarkus.native.graalvm-home='+graalvmHome,'-Dquarkus.native.java-home='+graalvmHome,
    '-Dquarkus.native.container-build=false','-Dquarkus.native.remote-container-build=false',
    '-Dquarkus.container-image.build=false','-Dquarkus.container-image.push=false','-Dquarkus.native.reuse-existing=false',
    '-Dquarkus.native.sources-only=false','-Dquarkus.native.bundle.dry-run=false','-Dquarkus.package.jar.enabled=false',
    '-Dquarkus.package.output-name=rocketbrain-quarkus','-Dquarkus.package.runner-suffix=-runner'];
}

module.exports={nativeGradleInit,nativeGradleArgs,gradleNativeInputs};
