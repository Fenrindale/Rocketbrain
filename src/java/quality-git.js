'use strict';

const fs=require('node:fs/promises');
const path=require('node:path');
const { execFile }=require('node:child_process');
const { promisify }=require('node:util');
const { supportedPath }=require('../vcs/changelist-git');

const run=promisify(execFile);
const objectId=/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const maxTree=16*1024*1024;
const limits={files:500,file:512*1024,total:16*1024*1024};
const utf8=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});

async function git(repo,args,maxBuffer=maxTree,{signal,acceptNonAncestor=false}={}) {
  const env=Object.fromEntries(Object.entries(process.env).filter(([name])=>!/^GIT_/i.test(name)));
  Object.assign(env,{GIT_TERMINAL_PROMPT:'0',GIT_NO_LAZY_FETCH:'1',LC_ALL:'C'});
  try {
    const {stdout}=await run('git',['--no-replace-objects','--no-optional-locks','--literal-pathspecs',
      '-c','core.fsmonitor=false','-c','core.quotePath=false',...args],{
      cwd:repo,env,windowsHide:true,encoding:'buffer',timeout:12000,maxBuffer,signal
    });
    return stdout;
  } catch (error) {
    if (signal?.aborted) throw Error('Java quality scan cancelled.');
    if (acceptNonAncestor && error.code===1) return null;
    if (error.code==='ENOENT') throw Error('Install Git on PATH to inspect a committed revision.');
    if (error.killed || error.code==='ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw Error('Git exceeded the quality gate time or size limit.');
    throw Error('Git could not read the local repository history. Check the selected commit and fetch depth.');
  }
}

function decode(bytes,message) {
  try { return utf8.decode(bytes); } catch { throw Error(message); }
}

async function repository(directory,signal) {
  const selected=await fs.realpath(directory);
  const root=decode(await git(selected,['rev-parse','--show-toplevel'],8192,{signal}),'Git repository path is not valid UTF-8.').replace(/\r?\n$/,'');
  if (!path.isAbsolute(root) || path.relative(selected,await fs.realpath(root))) {
    throw Error('Choose the root directory of the local Git worktree.');
  }
  return selected;
}

async function revision(repo,value,signal) {
  if (typeof value!=='string' || !/^(?:HEAD|[A-Za-z0-9][A-Za-z0-9_./-]{0,190})$/.test(value)) {
    throw Error('Use HEAD, a Git ref or a commit hash.');
  }
  const resolved=(await git(repo,['rev-parse','--verify','--end-of-options',value+'^{commit}'],1024,{signal})).toString('ascii').trim();
  if (!objectId.test(resolved)) throw Error('Git did not resolve a complete commit hash.');
  return resolved;
}

async function ancestor(repo,base,current,signal) {
  const response=await git(repo,['merge-base','--is-ancestor',base,current],1024,{signal,acceptNonAncestor:true});
  if (response===null) throw Error('The baseline commit must exist in the local history and be an ancestor of the scanned commit.');
}

async function entries(repo,commit,relative,signal) {
  if (!objectId.test(commit) || relative!==undefined && !supportedPath(relative)) throw Error('Use a full commit hash and a repository-relative path.');
  const bytes=await git(repo,['ls-tree','-r','-l','-z','--full-tree',commit,...(relative?['--',relative]:[])],maxTree,{signal});
  if (!bytes.length) return [];
  const records=decode(bytes,'Git returned a path that is not valid UTF-8.').split('\0');
  if (records.pop()!=='') throw Error('Git returned an incomplete commit tree.');
  return records.map(record=>{
    const parts=/^(\d{6}) (\w+) ([a-f0-9]+) +(\d+|-)\t([\s\S]+)$/.exec(record);
    if (!parts || !objectId.test(parts[3])) throw Error('Git returned an unsupported commit tree entry.');
    const [,mode,type,oid,size,name]=parts;
    return {mode,type,oid,size:Number(size),name};
  });
}

function regularJava(entry) {
  return entry.type==='blob' && ['100644','100755'].includes(entry.mode) && supportedPath(entry.name) &&
    Number.isSafeInteger(entry.size) && entry.size>=0 && entry.size<=limits.file;
}

async function blob(repo,entry,signal) {
  if (!regularJava(entry)) throw Error('The selected revision contains a linked, oversized or unsupported Java path.');
  const data=await git(repo,['cat-file','blob',entry.oid],limits.file+1,{signal});
  if (data.length!==entry.size) throw Error('Git returned a source size inconsistent with its commit tree.');
  const text=decode(data,'A committed Java source is not valid UTF-8.').replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n');
  if (text.includes('\0')) throw Error('A committed Java source includes a NUL byte.');
  return {uri:entry.name,text,object:entry.oid};
}

async function sources(repo,commit,profile,signal,{allowEmpty=false}={}) {
  const selected=(await entries(repo,commit,undefined,signal)).filter(item=>item.name.endsWith('.java') && profile.matches(item.name));
  if (selected.length>limits.files || selected.reduce((total,item)=>total+item.size,0)>limits.total) {
    throw Error('Narrow the quality profile to at most 500 committed Java files and 16 MiB of source.');
  }
  if (!selected.length && !allowEmpty) throw Error('No committed Java sources match this quality profile.');
  const files=[];
  for (let start=0;start<selected.length;start+=6) {
    files.push(...await Promise.all(selected.slice(start,start+6).map(entry=>blob(repo,entry,signal))));
  }
  return files;
}

async function sourceAt(repo,commit,relative,expectedObject,signal) {
  const [entry,...extra]=await entries(repo,commit,relative,signal);
  if (!entry || extra.length || entry.name!==relative || entry.oid!==expectedObject) {
    throw Error('The SARIF location does not match the recorded Java blob in this commit.');
  }
  return blob(repo,entry,signal);
}

module.exports={repository,revision,ancestor,sources,sourceAt,objectId};
