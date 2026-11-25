'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { gitRead,observeChanges } = require('./changelist-git');
const { PATHS,HUNKS,digest,shelfPath,parsePatch,fileSnapshot,readDiff,uniqueContext,applyPatch } = require('./shelf-patch');
const { shelfStore,patchParts } = require('./shelf-state');

const INDEX_BYTES=16*1024*1024;

function shelfController(storage,{verify,checkFile}) {
  const store=shelfStore(storage), reviews=new WeakMap(), captures=new WeakMap(), restorations=new WeakMap();
  let queue=Promise.resolve();

  function write(action) {
    const result=queue.then(action);
    queue=result.catch(()=>{});
    return result;
  }

  async function revision(repo) {
    const current=await verify(repo), raw=await gitRead(current.root,['rev-parse','--path-format=absolute','--git-path','index']);
    const file=raw.toString('utf8').replace(/\r?\n$/u,'');
    if(!path.isAbsolute(file)||/[\r\n\0]/u.test(file)||path.relative(file,await fs.realpath(file))) {
      throw Error('Git Shelf needs a physical local worktree index.');
    }
    const info=await fs.lstat(file);
    if(!info.isFile()||info.isSymbolicLink()||info.size>INDEX_BYTES) throw Error('The Git worktree index exceeds the review bounds.');
    const bytes=await fs.readFile(file);
    if(bytes.length>INDEX_BYTES) throw Error('The Git worktree index exceeds the review bounds.');
    return {branch:current.branch??null,head:current.head,index:digest(bytes)};
  }

  function sameRevision(first,second) {
    return first.head===second.head&&first.branch===second.branch&&first.index===second.index;
  }

  async function readFiles(repo,paths) {
    const files=new Map();
    for(let start=0;start<paths.length;start+=6) {
      const batch=await Promise.all(paths.slice(start,start+6).map(async name=>[name,await fileSnapshot(repo,name,item=>checkFile(repo,item))]));
      for(const [name,file] of batch)files.set(name,file);
    }
    return files;
  }

  async function inspect(repo) {
    const current=await revision(repo),{changes,omitted:statusOmitted}=await observeChanges(repo);
    const eligible=changes.filter(change=>shelfPath(change.path)&&!change.previousPath&&
      change.statuses.length===1&&/^[ M]M$/u.test(change.statuses[0]));
    const available=[], files=new Map();
    let omitted=statusOmitted+changes.length-Math.min(eligible.length,PATHS);
    for(const change of eligible.sort((a,b)=>a.path.localeCompare(b.path)).slice(0,PATHS)) {
      try {
        const name=change.path, file=await fileSnapshot(repo,name,item=>checkFile(repo,item));
        const diff=await readDiff(repo,name), parsed=parsePatch(diff,name);
        if(parsed.base!==file.index||parsed.mode!==file.mode||available.length+parsed.hunks.length>HUNKS) {omitted++;continue;}
        files.set(name,{...file,header:parsed.header});
        for(const hunk of parsed.hunks) available.push({...hunk,path:name,id:'hunk-'+available.length});
      } catch {
        omitted++;
      }
    }
    if(!sameRevision(current,await revision(repo))) throw Error('The Git branch or index changed during review. Start again.');
    const report={branch:current.branch,head:current.head,omitted,
      hunks:available.map(hunk=>({id:hunk.id,path:hunk.path,oldLine:hunk.oldLine,newLine:hunk.newLine,
        changed:hunk.patch.split('\n').find(line=>/^[+-]/u.test(line))?.slice(0,90)||'Text change'}))};
    reviews.set(report,{repo,current,files,available});
    return report;
  }

  function select(review,ids) {
    const record=reviews.get(review);
    if(!record||!Array.isArray(ids)||!ids.length||ids.length>HUNKS||new Set(ids).size!==ids.length) {
      throw Error('Select hunks from the current Git worktree review.');
    }
    const chosen=new Set(ids);
    const hunks=record.available.filter(item=>chosen.has(item.id));
    if(hunks.length!==ids.length) throw Error('Choose exact hunks from the current Git worktree review.');
    const paths=[...new Set(hunks.map(item=>item.path))];
    const parts=paths.map(name=>({path:name,patch:record.files.get(name).header+
      hunks.filter(item=>item.path===name).map(item=>item.patch).join('')}));
    const selected=patchParts(parts);
    const preview={branch:record.current.branch,head:record.current.head,paths,count:selected.count,patch:selected.patch};
    captures.set(preview,{repo:record.repo,current:record.current,parts,selected,files:new Map(paths.map(name=>[name,record.files.get(name)]))});
    return preview;
  }

  async function check(record) {
    const paths=[...record.files.keys()], live=await readFiles(record.repo,paths);
    if(paths.some(name=>{
      const first=record.files.get(name), current=live.get(name);
      return first.hash!==current.hash||first.index!==current.index||first.mode!==current.mode||first.checkout!==current.checkout;
    })||!sameRevision(record.current,await revision(record.repo))) {
      throw Error('A reviewed Git Shelf file, branch or index changed. Preview again.');
    }
    for(const name of paths)checkFile(record.repo,name);
  }

  async function classify(repo,selected,files) {
    const [forward,reverse]=await Promise.all([applyPatch(repo.root,selected.patch,{check:true}),
      applyPatch(repo.root,selected.patch,{reverse:true,check:true})]);
    const unique=side=>selected.parsed.every(part=>part.hunks.every(hunk=>uniqueContext(files.get(part.path).text,hunk[side])));
    if(forward&&reverse) return 'ambiguous';
    if(forward) return unique('before')?'ready':'ambiguous';
    if(reverse) return unique('after')?'already-applied':'ambiguous';
    return 'conflict';
  }

  function shelve(preview,name) {
    return write(async()=>{
      const record=captures.get(preview);
      if(!record) throw Error('Preview the selected Git Shelf hunks before shelving them.');
      await check(record);
      if(await classify(record.repo,record.selected,record.files)!=='already-applied') {
        throw Error('Git could not identify all selected changes at unique locations. Refresh the hunk review.');
      }
      const item=await store.capture({group:record.repo.group,branch:record.current.branch,head:record.current.head,name,parts:record.parts});
      try {
        await check(record);
        await applyPatch(record.repo.root,record.selected.patch,{reverse:true});
        if(!sameRevision(record.current,await revision(record.repo))) throw Error('The Git worktree metadata changed.');
        captures.delete(preview);
        return await store.mark(record.repo.group,item.id);
      } catch {
        throw Error('The shelf copy was saved. The worktree removal could not be confirmed. Review Git changes and the saved shelf before retrying.');
      }
    });
  }

  async function previewRestore(repo,id) {
    const entry=await store.get(repo.group,id),selected=patchParts(entry.parts), current=await revision(repo);
    const paths=selected.parsed.map(item=>item.path),files=await readFiles(repo,paths);
    const status=await classify(repo,selected,files);
    const record={repo,current,files,id,sha256:entry.sha256,selected,status};
    if(!sameRevision(current,await revision(repo))) throw Error('The Git branch or index changed during review. Preview again.');
    const preview={id,status,branch:current.branch,head:current.head,sourceBranch:entry.branch,sourceHead:entry.head,
      name:entry.name,paths,count:selected.count,patch:selected.patch};
    restorations.set(preview,record);
    return preview;
  }

  function restore(preview) {
    return write(async()=>{
      const record=restorations.get(preview);
      if(!record) throw Error('Preview the saved shelf in the selected Git working tree first.');
      const current=await store.get(record.repo.group,record.id);
      if(current.sha256!==record.sha256) throw Error('The saved shelf changed. Preview it again.');
      await check(record);
      const status=await classify(record.repo,record.selected,record.files);
      if(status!==record.status) throw Error('The Git Shelf result changed. Preview the restore again.');
      if(status!=='ready')return {status,id:record.id};
      await check(record);
      await applyPatch(record.repo.root,record.selected.patch);
      if(!sameRevision(record.current,await revision(record.repo))) {
        throw Error('Git metadata changed during shelf restoration. Review Git changes and the saved shelf.');
      }
      restorations.delete(preview);
      return {status:'applied',id:record.id};
    });
  }

  return {inspect,select,shelve,previewRestore,restore,
    async list(repo) {
      await verify(repo);
      return (await store.list(repo.group)).map(item=>({
        id:item.id,name:item.name,createdAt:item.createdAt,branch:item.branch,head:item.head,state:item.state,
        paths:item.parts.map(part=>part.path),count:patchParts(item.parts).count
      }));
    },
    async preview(repo,id){await verify(repo);const entry=await store.get(repo.group,id);return patchParts(entry.parts).patch;},
    remove(repo,id){return write(async()=>{await verify(repo);return store.remove(repo.group,id);});},
    drain:()=>queue
  };
}

module.exports={shelfController};
