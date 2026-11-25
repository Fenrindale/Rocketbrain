'use strict';

const { randomUUID }=require('node:crypto');

const prefix='rocketbrain.resultSnapshot.v1.';
const limits={rows:500,columns:256,bytes:1024*1024,snapshots:12,totalBytes:8*1024*1024};
const idPattern=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const forTitle=value=>typeof value==='string'&&value.trim().replace(/[\x00-\x1f\x7f]/g,' ').slice(0,96)||'Captured result';
const isNegativeZero=value=>Array.isArray(value)&&value.length===1&&value[0]==='-0';
const scalar=value=>value===null||typeof value==='string'||typeof value==='boolean'||Number.isFinite(value);
const fitsColumn=value=>typeof value==='string'&&value.length<=2048;
const normalizedInteger=value=>Number.isSafeInteger(value)&&value>=0&&value<=0xffffffff?value:null;

function normalizeFields(columns,fields) {
  return columns.map((name,index)=>{
    const field=fields?.[index];
    return {name,type:normalizedInteger(field?.type),characterSet:normalizedInteger(field?.characterSet),flags:normalizedInteger(field?.flags)};
  });
}

function captureRows(result) {
  const {columns,rows}=result||{};
  if(!Array.isArray(columns)||!columns.length||columns.length>limits.columns||!columns.every(fitsColumn)||
      !Array.isArray(rows)||rows.length>limits.rows)throw Error('Capture at most 500 rows and 256 columns.');
  const encoded=rows.map(row=>{
    if(!Array.isArray(row)||row.length!==columns.length||!row.every(scalar))throw Error('The result contains an unsupported cell representation.');
    return row.map(value=>Object.is(value,-0)?['-0']:value);
  });
  return {columns:[...columns],fields:normalizeFields(columns,result.fields),rows:encoded,truncated:result.truncated===true||result.browse?.hasNext===true};
}

function restoredRows(value) {
  if(!value||!Array.isArray(value.columns)||!value.columns.length||value.columns.length>limits.columns||
      !value.columns.every(fitsColumn)||!Array.isArray(value.rows)||value.rows.length>limits.rows||typeof value.truncated!=='boolean')return null;
  const {columns}=value;
  const rows=[];
  for(const row of value.rows) {
    if(!Array.isArray(row)||row.length!==columns.length||!row.every(cell=>scalar(cell)||isNegativeZero(cell)))return null;
    rows.push(row.map(cell=>isNegativeZero(cell)?-0:cell));
  }
  return {columns:[...columns],fields:normalizeFields(columns,value.fields),rows,rowCount:rows.length,truncated:value.truncated,
    durationMs:0,affectedRows:0,offlineCapture:true};
}

function createResultSnapshotStore(state,allowed) {
  let writes=Promise.resolve();
  const requireWorkspace=()=>{if(!allowed())throw Error('Open a trusted workspace folder to use saved result snapshots.');};
  const storedKey=id=>prefix+id;
  const serialize=task=>{
    const next=writes.then(task);
    writes=next.catch(()=>{});
    return next;
  };
  function read(id) {
    if(typeof id!=='string'||!idPattern.test(id))return null;
    const saved=state.get(storedKey(id));
    if(!saved||saved.id!==id||typeof saved.title!=='string'||saved.title!==forTitle(saved.title)||
      !Number.isSafeInteger(saved.capturedAt)||saved.capturedAt<0)return null;
    const size=Buffer.byteLength(JSON.stringify(saved));
    if(size>limits.bytes)return null;
    const result=restoredRows(saved.payload);
    if(!result)return null;
    return {id,title:saved.title,capturedAt:saved.capturedAt,rows:result.rowCount,columns:result.columns.length,
      bytes:size,truncated:result.truncated,result};
  }
  function entries() {
    requireWorkspace();
    return state.keys().filter(key=>key.startsWith(prefix)).flatMap(key=>{
      const item=read(key.slice(prefix.length));
      if(!item)return [];
      const {result,...summary}=item;
      return [summary];
    }).sort((left,right)=>right.capturedAt-left.capturedAt);
  }
  function get(id) {
    requireWorkspace();
    const item=read(id);
    if(!item)throw Error('The captured result snapshot is unavailable.');
    return item;
  }
  function save(title,payload) {
    return serialize(async()=>{
      requireWorkspace();
      const id=randomUUID(),saved={id,title:forTitle(title),capturedAt:Date.now(),payload:captureRows(payload)};
      const bytes=Buffer.byteLength(JSON.stringify(saved));
      if(bytes>limits.bytes)throw Error('The captured result exceeds the 1 MiB snapshot limit.');
      const existing=entries();
      if(existing.length>=limits.snapshots||existing.reduce((sum,item)=>sum+item.bytes,0)+bytes>limits.totalBytes) {
        throw Error('The result snapshot space is full. Remove a snapshot before saving more.');
      }
      await state.update(storedKey(id),saved);
      const {result,...summary}=get(id);
      return summary;
    });
  }
  function remove(id) {
    return serialize(async()=>{get(id);await state.update(storedKey(id),undefined);});
  }
  return {save,get,list:entries,remove};
}

function registerResultSnapshots(context,vscode,results,command) {
  const available=()=>vscode.workspace.isTrusted&&Boolean(vscode.workspace.workspaceFolders?.length);
  const store=createResultSnapshotStore(context.workspaceState,available);
  const eligible=record=>results.exportable(record)&&record.readOnly&&!record.result.offlineCapture&&
    !record.sessionState?.inTransaction;
  function candidates() {
    return results.history.filter(eligible).map(record=>({id:record.id,title:record.tabName||'Captured result '+record.id,
      revision:record.chart?.revision||0,rows:record.result.rows.length,columns:record.result.columns.length}));
  }
  function save(id,title,revision) {
    const current=results.history.find(record=>record.id===id);
    if(!eligible(current)||(current.chart?.revision||0)!==revision)throw Error('Choose a completed, current read-only result without a pending transaction.');
    return store.save(title,current.result);
  }
  async function open(id) {
    const {title,result}=store.get(id);
    await results.show();
    if(!available())throw Error('The workspace changed while opening the result snapshot.');
    store.get(id);
    const recordId=results.begin('','Saved result · '+title,{readOnly:true});
    results.finish(recordId,result);
    await results.activateResult(recordId);
    return {id,recordId,readOnly:true,executedSql:false};
  }
  async function choose(title) {
    const items=store.list().map(snapshot=>({label:snapshot.title,
      description:new Date(snapshot.capturedAt).toLocaleString(),detail:snapshot.rows+' rows · '+snapshot.columns+' columns',snapshot}));
    if(!items.length)throw Error('There are no saved results in this workspace.');
    return (await vscode.window.showQuickPick(items,{title}))?.snapshot;
  }
  command('rocketbrain.results.saveSnapshot',async()=>{
    const items=candidates().map(record=>({label:record.title,detail:record.rows+' rows · '+record.columns+' columns',record}));
    if(!items.length)throw Error('Run a read-only query to choose a result snapshot.');
    const selected=await vscode.window.showQuickPick(items,{title:'Save Query Result Snapshot'});
    if(!selected)return;
    const name=await vscode.window.showInputBox({title:'Name the Saved Result',value:selected.record.title,
      prompt:'The captured rows are stored locally in this workspace. Save only rows you intend to keep.'});
    if(name!==undefined)return save(selected.record.id,name,selected.record.revision);
  });
  command('rocketbrain.results.openSnapshot',async()=>{
    const item=await choose('Open Saved Query Result');
    if(item)return open(item.id);
  });
  command('rocketbrain.results.removeSnapshot',async()=>{
    const item=await choose('Remove Saved Query Result');
    if(item&&await vscode.window.showWarningMessage('Remove '+item.title+' from saved results?',{modal:true},'Remove Snapshot')==='Remove Snapshot') {
      await store.remove(item.id);
    }
  });
  return {candidates,save,open,list:store.list,remove:store.remove};
}

module.exports={createResultSnapshotStore,registerResultSnapshots};
