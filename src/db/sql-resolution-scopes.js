'use strict';

const fs=require('node:fs');
const path=require('node:path');
const {parseSchema}=require('./ddl-model');
const limit=128*1024;
const slash=value=>value.replaceAll('\\','/');
const comparable=value=>process.platform==='win32'?value.toLowerCase():value;

function relativeName(value){
  if(typeof value!=='string'||!value||value.length>300||/[:\\\0\r\n]/.test(value)||
    value.replace(/\/$/,'').split('/').some(part=>!part||part==='.'||part==='..')){
    throw Error('Use a workspace-relative SQL path.');
  }
  return value;
}

function selectScope(folder,file,rules){
  if(!Array.isArray(rules)||!rules.length)return null;
  const relative=comparable(slash(path.relative(folder,file)));
  if(!relative||relative==='..'||relative.startsWith('../')||path.isAbsolute(relative))return null;
  const matches=[];
  for(const rule of rules.slice(0,32)){
    let source;
    try{source=comparable(relativeName(rule?.source));}catch{continue;}
    const directory=source.endsWith('/');
    if(directory?relative.startsWith(source):relative===source)matches.push({rule,source});
  }
  if(!matches.length)return null;
  matches.sort((left,right)=>right.source.length-left.source.length);
  if(matches[0].source===matches[1]?.source)return {error:'More than one SQL resolution scope uses this mapping.'};
  return matches[0].rule;
}

function loadScope(folder,rule,cache){
  if(rule.error)throw Error(rule.error);
  const root=fs.realpathSync(folder);
  const local=relativeName(rule.ddl);
  if(!/\.sql$/i.test(local))throw Error('Use a local .sql catalog file.');
  const absolute=path.resolve(root,local),real=fs.realpathSync(absolute);
  if(comparable(real)!==comparable(absolute))throw Error('Use a catalog file physically inside the workspace.');
  const stat=fs.lstatSync(real,{bigint:true});
  if(!stat.isFile()||stat.size>BigInt(limit))throw Error('Use a regular UTF-8 DDL file up to 128 KiB.');
  const key=JSON.stringify([real,rule.database,rule.dialect||'mysql',rule.source]);
  const fingerprint=[stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs].join(':');
  const current=cache.get(key);
  if(current?.fingerprint===fingerprint)return current.preview;
  const fd=fs.openSync(real,'r');
  let bytes,read=0;
  try{
    const opened=fs.fstatSync(fd,{bigint:true});
    if(!opened.isFile()||opened.ino!==stat.ino||opened.size!==stat.size||opened.mtimeNs!==stat.mtimeNs){
      throw Error('The DDL catalog changed while opening. Try again.');
    }
    bytes=Buffer.alloc(Number(opened.size)+1);
    while(read<bytes.length){
      const count=fs.readSync(fd,bytes,read,bytes.length-read,read);
      if(!count)break;
      read+=count;
    }
    const after=fs.fstatSync(fd,{bigint:true});
    if(BigInt(read)!==opened.size||after.mtimeNs!==opened.mtimeNs||after.ctimeNs!==opened.ctimeNs){
      throw Error('The DDL catalog changed while reading. Try again.');
    }
  }finally{fs.closeSync(fd);}
  const {model}=parseSchema(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,read)),rule.database,rule.dialect);
  const preview={type:'local',model,configuredScope:relativeName(rule.source)};
  while(cache.size>=32&&!cache.has(key))cache.delete(cache.keys().next().value);
  cache.set(key,{fingerprint,preview});
  return preview;
}

module.exports={selectScope,loadScope};
