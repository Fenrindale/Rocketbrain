'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {TableEditor}=require('../src/table-editor');
function host(){
 const model={modelId:'current',canEdit:true,insertable:true,rowIds:['one','two'],columns:[{name:'id',type:'int',kind:'integer',primaryKey:true,autoIncrement:true,editable:false,insertable:false,nullable:false},{name:'label',type:'varchar(40)',kind:'text',editable:true,insertable:true,required:true,nullable:false},{name:'note',type:'varchar(40)',kind:'text',editable:true,insertable:true,nullable:true}]};
 const record={id:1,readOnly:false,draftRevision:0,result:{edit:model,rows:[[1,'A','old'],[2,'B',null]]}},results={history:[record],editState(id,patch){Object.assign(record,patch);}},session={readOnly:false,connected:true,needsReconnect:false,outcomeUnknown:false},db={getSessionState:()=>session},editor=new TableEditor({results,connection:()=>({db,mysql:true,epoch:1}),withSession:async(id,action)=>action(id),trusted:()=>true});editor.contexts.set(1,{db,epoch:1,sessionId:'owned',table:'t'});return{editor,record,session,model};
}
test('bulk host prepares typed changes without executing or replacing current local drafts',async()=>{
 const h=host();await h.editor.handle(1,{type:'prepareBulk',operation:'paste',modelId:'current',draftRevision:0,anchorRowId:'one',anchorColumn:'label',text:'new\t\\N',delimiter:'\t',nullToken:'\\N'});assert.equal(h.record.bulkDraft.updates.length,1);assert.deepEqual(h.record.bulkDraft.updates[0].values.note,{kind:'null'});h.record.hasDraft=true;await h.editor.handle(1,{type:'prepareBulk',operation:'duplicate',modelId:'current',draftRevision:0,rowId:'one'});assert.match(h.record.editError,/current local draft/);assert.equal(h.record.hasDraft,true);
});
test('bulk host rejects stale model/revision and ignores old Webview draft-state frames',async()=>{
 const h=host();await h.editor.handle(1,{type:'inspectBulk',modelId:'old',draftRevision:0,text:'label\nnew',delimiter:',',hasHeader:true});assert.match(h.record.editError,/snapshot/);assert.equal(h.record.bulkSource,undefined);await h.editor.handle(1,{type:'draftChanged',modelId:'old',count:3,draftRevision:1});assert.equal(h.record.hasDraft,undefined);await h.editor.handle(1,{type:'prepareBulk',operation:'duplicate',modelId:'current',draftRevision:9,rowId:'one'});assert.match(h.record.editError,/snapshot/);assert.equal(h.record.bulkDraft,undefined);
});
test('inspected import sources remain model-bound and protected columns cannot be mapped',async()=>{
 const h=host();await h.editor.handle(1,{type:'inspectBulk',modelId:'current',draftRevision:0,text:'name\nnew',delimiter:',',hasHeader:true});const source=h.record.bulkSource;assert.equal(source.rowCount,1);await h.editor.handle(1,{type:'prepareBulk',operation:'import',modelId:'current',draftRevision:0,sourceId:source.id,mapping:[{source:0,target:'id'}]});assert.match(h.record.editError,/insertable/);assert.equal(h.record.bulkDraft,undefined);await h.editor.handle(1,{type:'prepareBulk',operation:'import',modelId:'current',draftRevision:0,sourceId:source.id,mapping:[{source:0,target:'label'}]});assert.equal(h.record.bulkDraft.inserts[0].values.label.text,'new');
});
test('read-only and unknown sessions cannot stage a bulk operation',async()=>{
 const h=host();for(const patch of [{readOnly:true},{readOnly:false,outcomeUnknown:true}]){Object.assign(h.session,patch);await h.editor.handle(1,{type:'prepareBulk',operation:'duplicate',modelId:'current',draftRevision:0,rowId:'one'});assert.match(h.record.editError,/connected writable/);assert.equal(h.record.bulkDraft,undefined);}
});
