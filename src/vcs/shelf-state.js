'use strict';

const { randomUUID } = require('node:crypto');
const { validLabel } = require('./changelist-state');
const { digest,parsePatch,PATCH_BYTES,PATHS,HUNKS,HASH } = require('./shelf-patch');

const KEY='rocketbrain.gitShelf.v1', MAX_ENTRIES=32, STORE_BYTES=4*1024*1024;
const UUID=/^[a-f0-9-]{36}$/u, GROUP=/^[a-f0-9]{64}$/u;

function patchParts(parts) {
  if(!Array.isArray(parts)||!parts.length||parts.length>PATHS||
    parts.some(part=>typeof part?.path!=='string'||typeof part.patch!=='string')||
    new Set(parts.map(part=>part.path)).size!==parts.length) throw Error('Invalid Git Shelf file selection.');
  const patch=parts.map(part=>part.patch).join('');
  if(Buffer.byteLength(patch)>PATCH_BYTES) throw Error('The selected Git Shelf patch exceeds 512 KiB.');
  const parsed=parts.map(part=>({path:part.path,...parsePatch(part.patch,part.path)}));
  const count=parsed.reduce((total,part)=>total+part.hunks.length,0);
  if(count>HUNKS) throw Error('Select at most 240 Git hunks.');
  return {patch,parsed,count,sha256:digest(JSON.stringify(parts))};
}

function validateRecord(record) {
  if(!record||!UUID.test(record.id)||!GROUP.test(record.group)||!validLabel(record.name)||
    !Number.isSafeInteger(record.createdAt)||record.createdAt<=0||!HASH.test(record.head)||
    (record.branch!==null&&!validLabel(record.branch,4096))||!['captured','shelved'].includes(record.state)||
    patchParts(record.parts).sha256!==record.sha256) throw Error('Saved Git Shelf data is invalid.');
}

function shelfStore(storage) {
  let queue=Promise.resolve();
  function read() {
    const state=structuredClone(storage.get(KEY,{version:1,entries:[]}));
    if(state?.version!==1||!Array.isArray(state.entries)||state.entries.length>MAX_ENTRIES||
      new Set(state.entries.map(record=>record?.id)).size!==state.entries.length||
      Buffer.byteLength(JSON.stringify(state))>STORE_BYTES) throw Error('Saved Git Shelf data is invalid or exceeds its limit.');
    for(const entry of state.entries) validateRecord(entry);
    return state;
  }
  function write(action) {
    const pending=queue.then(async()=>{
      const state=read(),result=action(state.entries);
      if(Buffer.byteLength(JSON.stringify(state))>STORE_BYTES) throw Error('Remove an unused shelf before exceeding the workspace storage limit.');
      await storage.update(KEY,state);
      return structuredClone(result);
    });
    queue=pending.catch(()=>{});
    return pending;
  }
  function locate(entries,group,id) {
    const index=entries.findIndex(item=>item.group===group&&item.id===id);
    if(index<0) throw Error('Choose a saved shelf from this Git repository.');
    return index;
  }
  return {
    async list(group) {
      await queue;
      return read().entries.filter(entry=>entry.group===group).sort((a,b)=>b.createdAt-a.createdAt);
    },
    async get(group,id) {
      await queue;
      const {entries}=read();
      return entries[locate(entries,group,id)];
    },
    capture({group,branch,head,name,parts}) {
      return write(entries=>{
        name=typeof name==='string'?name.trim():'';
        if(!validLabel(name)) throw Error('Enter a Git Shelf name of at most 80 characters.');
        if(entries.length>=MAX_ENTRIES) throw Error('Remove an unused shelf before creating another one.');
        const record={id:randomUUID(),group,branch,head,name,createdAt:Date.now(),parts:structuredClone(parts),
          state:'captured',sha256:patchParts(parts).sha256};
        validateRecord(record);
        entries.push(record);
        return record;
      });
    },
    mark(group,id) { return write(entries=>{ const entry=entries[locate(entries,group,id)];entry.state='shelved';return entry; }); },
    remove(group,id) { return write(entries=>{entries.splice(locate(entries,group,id),1);return {id,removed:true};}); }
  };
}

module.exports={shelfStore,patchParts};
