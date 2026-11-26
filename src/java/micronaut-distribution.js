'use strict';

const fs=require('node:fs/promises');
const path=require('node:path');
const {fail}=require('./workbench-model');

const LIMIT=256*1024*1024;
const ENTRY=/^[A-Za-z0-9][A-Za-z0-9._+-]{0,160}\.jar$/u;
const ENTRY_PREFIX='%APP_HOME%\\lib\\';
const SCRIPT_LIMIT=128*1024;
const MAX_LIBRARIES=128;
const binding=['dev','ino','size','mtimeNs','ctimeNs'];
const matches=(before,after)=>binding.every(key=>before[key]===after[key]);

async function physical(file,kind){
  const stat=await fs.lstat(file,{bigint:true});
  if(stat.isSymbolicLink()||path.relative(file,await fs.realpath(file))||
      !(kind==='directory'?stat.isDirectory():stat.isFile())){
    throw fail('Use regular physical files in the Micronaut Gradle installation.');
  }
  return stat;
}

function scriptLibraries(script,mainClass){
  const lines=script.split(/\r?\n/u);
  const assignments=lines.filter(line=>/^set CLASSPATH=/iu.test(line));
  const defaults=lines.filter(line=>/^set DEFAULT_JVM_OPTS=/iu.test(line));
  const launches=lines.filter(line=>/ -classpath "%CLASSPATH%" /iu.test(line));
  const target=launches[0]?.match(/ -classpath "%CLASSPATH%" ([A-Za-z0-9_.$]+) %\*/u);
  if(assignments.length!==1||defaults.length!==1||defaults[0].trim()!=='set DEFAULT_JVM_OPTS='||
      launches.length!==1||target?.[1]!==mainClass||/ --module-path /u.test(launches[0])){
    throw fail('The Micronaut distribution must use the standard classpath launcher with the declared main class.');
  }
  const entries=assignments[0].slice('set CLASSPATH='.length).split(';').map(value=>
    value.startsWith(ENTRY_PREFIX)?value.slice(ENTRY_PREFIX.length):'');
  if(!entries.length||entries.length>MAX_LIBRARIES||entries.some(name=>!ENTRY.test(name))||
      new Set(entries.map(name=>name.toLowerCase())).size!==entries.length){
    throw fail('The Micronaut Gradle distribution must list up to 128 unique local library JARs.');
  }
  return entries;
}

async function distribution(project,build){
  const folder=path.join(project.root,'build','install',build.distribution);
  try{await physical(folder,'directory');}
  catch(error){
    if(error.code==='ENOENT')throw fail('Run the Micronaut Gradle installDist task to create its standard distribution.');
    throw error;
  }
  const launcher=path.join(folder,'bin',build.distribution+'.bat'), libraries=path.join(folder,'lib');
  const original=await physical(launcher,'file');
  const listing=await physical(libraries,'directory');
  if(original.size>BigInt(SCRIPT_LIMIT))throw fail('The Micronaut Gradle launcher exceeds its descriptor limit.');
  const bytes=await fs.readFile(launcher);
  if(bytes.length> SCRIPT_LIMIT||BigInt(bytes.length)!==original.size||!matches(original,await physical(launcher,'file'))){
    throw fail('The Micronaut Gradle launcher changed during inspection.');
  }
  const names=scriptLibraries(new TextDecoder('utf-8',{fatal:true}).decode(bytes),build.mainClass);
  const entries=await fs.readdir(libraries);
  if(entries.length!==names.length||!entries.every(entry=>names.includes(entry))||
      !matches(listing,await physical(libraries,'directory'))){
    throw fail('The Micronaut Gradle classpath differs from its installed library directory. Build again.');
  }
  const jars=[];
  let total=0;
  for(const name of names){
    const file=path.join(libraries,name), stat=await physical(file,'file');
    if(stat.size<4n||stat.size>BigInt(LIMIT)|| (total+=Number(stat.size))>LIMIT){
      throw fail('The Micronaut Gradle distribution exceeds its 256 MiB library limit.');
    }
    jars.push({file,artifact:name,size:Number(stat.size),identity:stat});
  }
  return {artifact:'build/install/'+build.distribution,jars,mainClass:build.mainClass};
}

module.exports={distribution,scriptLibraries,physical,matches};
