'use strict';

const fs=require('node:fs/promises');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {gitRead,inspectRepository,inside,supportedPath}=require('./changelist-git');
const {validateRuntimeUrl}=require('../spring/runtime-client');

const LIMIT=128;
const KEY='rocketbrain.gitWorktreeContexts.v1';
const HASH=/^[a-f0-9]{64}$/;
const OID=/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const PROFILE=/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const utf8=new TextDecoder('utf-8',{fatal:true});
const normalized=value=>process.platform==='win32'?path.resolve(value).toLowerCase():path.resolve(value);
const same=(left,right)=>path.relative(left,right)==='';
const local=value=>typeof value==='string'&&value.length<=4096&&path.isAbsolute(value)&&
  !/^[\\/]{2}/.test(value)&&!/[\u0000-\u001f\u007f]/u.test(value);

function parseWorktrees(bytes) {
  const records=utf8.decode(bytes).split('\0');
  if(records.pop()!==''||records.at(-1)!=='')throw Error('Git returned an incomplete worktree list.');
  const rows=[],roots=new Set();
  let row,fields=new Set();
  for(const record of records){
    if(!record){
      if(!row||!row.bare&&(!OID.test(row.head??'')||!row.detached&&!row.branch))throw Error('Git returned an invalid worktree entry.');
      if(rows.length===LIMIT||roots.has(normalized(row.root)))throw Error('Git returned duplicate worktrees or exceeded the worktree limit.');
      rows.push(row);roots.add(normalized(row.root));row=undefined;fields=new Set();
      continue;
    }
    const separator=record.indexOf(' '),name=separator<0?record:record.slice(0,separator),value=separator<0?'':record.slice(separator+1);
    if(name==='worktree'){
      if(row||!local(value))throw Error('Git returned a worktree path outside the supported local path format.');
      row={root:path.normalize(value)};continue;
    }
    if(!row||fields.has(name))throw Error('Git returned duplicate or misplaced worktree metadata.');
    fields.add(name);
    if(name==='HEAD')row.head=value;
    else if(name==='branch'&&value.startsWith('refs/heads/')&&value.length>11&&value.length<=4096)row.branch=value.slice(11);
    else if(['bare','detached','locked','prunable'].includes(name))row[name]=true;
    else throw Error('Git returned an unsupported worktree attribute.');
  }
  return rows;
}

async function common(directory) {
  const response=await gitRead(directory,['rev-parse','--path-format=absolute','--git-common-dir']);
  const value=response&&utf8.decode(response).replace(/\r?\n$/,'');
  if(!local(value))throw Error('Git did not report a physical common repository directory.');
  const physical=await fs.realpath(value);
  const stat=await fs.stat(physical);
  if(!stat.isDirectory())throw Error('Git common repository metadata is unavailable.');
  return createHash('sha256').update(JSON.stringify([normalized(physical),stat.dev,stat.ino,stat.birthtimeMs])).digest('hex');
}

async function inspectWorktree(directory,workspaceRoot) {
  if(!local(directory)||!local(workspaceRoot))throw Error('Choose a local Git worktree in an open workspace.');
  const physical=await fs.realpath(directory);
  if(!same(directory,physical))throw Error('Open the physical Git worktree directory.');
  const repository=await inspectRepository(physical,workspaceRoot);
  if(!repository)throw Error('Open a local Git worktree inside this workspace.');
  const [group,rows]=await Promise.all([common(repository.root),gitRead(repository.root,['worktree','list','--porcelain','-z'])]);
  const worktrees=parseWorktrees(rows),current=worktrees.find(row=>same(row.root,repository.root));
  if(!current||current.bare||current.prunable)throw Error('Git no longer lists this physical worktree as available.');
  return {id:repository.key,group,current,worktrees};
}

function contextSettings(value={}) {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['project','spring','database'].includes(key))) {
    throw Error('Choose Java project, Spring service and saved database context fields.');
  }
  const project=value.project??null;
  if(project!==null&&project!=='.'&&!supportedPath(project))throw Error('Use a Java project path within the selected worktree.');
  const spring=value.spring===null||value.spring===undefined||value.spring===''?null:validateRuntimeUrl(value.spring).url.toString().replace(/\/$/,'');
  const database=value.database??null;
  if(database!==null&&(!database||typeof database!=='object'||Object.keys(database).some(key=>!['id','revision'].includes(key))||
      typeof database.id!=='string'||!PROFILE.test(database.id)||!Number.isSafeInteger(database.revision)||database.revision<1)) {
    throw Error('Choose a saved database profile revision.');
  }
  return {project,spring,database:database&&{id:database.id,revision:database.revision}};
}

function createWorktreeContextStore(state) {
  let pending=Promise.resolve();
  const list=()=>{
    const stored=state.get(KEY,[]);
    return Array.isArray(stored)?stored.slice(0,LIMIT).filter(row=>row&&HASH.test(row.id)&&HASH.test(row.group)&&
      Number.isSafeInteger(row.revision)&&row.revision>=1):[];
  };
  const get=id=>{
    const row=list().find(value=>value.id===id);
    return row&&{...row,settings:contextSettings(row.settings)};
  };
  function update(identity,expectedRevision,settings) {
    const task=pending.then(async()=>{
      if(!HASH.test(identity.id)||!HASH.test(identity.group))throw Error('Inspect a registered Git worktree first.');
      const existing=get(identity.id);
      if((existing?.revision??0)!==expectedRevision||existing&&existing.group!==identity.group)throw Error('The worktree context changed after review.');
      const rest=list().filter(row=>row.id!==identity.id);
      if(!settings){await state.update(KEY,rest);return null;}
      if(rest.length>=LIMIT)throw Error('Clear a saved Git worktree context before saving another.');
      const next={id:identity.id,group:identity.group,revision:expectedRevision+1,settings:contextSettings(settings)};
      await state.update(KEY,[next,...rest]);
      return next;
    });
    pending=task.catch(()=>{});
    return task;
  }
  return {get,update};
}

function listedSibling(observed,root) {
  if(!local(root))throw Error('Select a listed local Git worktree.');
  const row=observed.worktrees.find(entry=>same(entry.root,root));
  if(!row||row.prunable||row.bare)throw Error('The selected worktree is no longer available.');
  return row;
}

module.exports={parseWorktrees,inspectWorktree,contextSettings,createWorktreeContextStore,listedSibling,same,inside,local};
