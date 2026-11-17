'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {registerSchemaRename}=require('../src/db/schema-vscode');
function host(){
 let ddlCalls=0,sourceCalls=0,refreshCalls=0,sourceChanged=false,unknown=false;
 const vscode={Uri:{parse:value=>value},workspace:{isTrusted:true,openTextDocument:async()=>({getText:()=> 'SELECT label FROM people;'}),registerTextDocumentContentProvider:()=>({dispose(){}}),applyEdit:async()=>{sourceCalls++;return true;}},commands:{registerCommand:()=>({dispose(){}})}};
 const database={previewSchemaRename:async request=>({...request,schema:'fixture',reviewId:'ddl',connectionEpoch:7,expiresAt:Date.now()+120000}),applySchemaRename:async()=>{ddlCalls++;sourceChanged=true;if(unknown)throw Object.assign(new Error('connection lost'),{state:'unknown',outcomeUnknown:true});return{state:'applied',verified:true};},refreshSchema:async()=>{refreshCalls++;}};
 const sqlAnalysis={findCatalogReferences:async()=>({coverage:{complete:true},references:[]}),planCatalogRename:async()=>({id:'source',documents:[{uri:'file:///query.sql'}]}),validateCatalogRename:async()=>true,catalogRenameEdit:async()=>{if(sourceChanged)throw new Error('Source file changed after review');return {};}};
 const api=registerSchemaRename({},vscode,{database,sqlAnalysis});
 return {api,vscode,database,sqlAnalysis,get counts(){return{ddlCalls,sourceCalls,refreshCalls};},set changed(value){sourceChanged=value;},set unknown(value){unknown=value;}};
}
test('schema source edits stop when files change during DDL without claiming database rollback',async()=>{
 const h=host();try{const plan=await h.api.preview({kind:'table',table:'people',newName:'members'});const result=await h.api.apply(plan.id,{updateSql:true});assert.equal(result.state,'applied');assert.equal(result.sourceState,'pending');assert.equal(result.atomicAcrossDatabaseAndFiles,false);assert.deepEqual(h.counts,{ddlCalls:1,sourceCalls:0,refreshCalls:1});await assert.rejects(h.api.apply(plan.id),/expired/);}finally{await h.api.dispose();}
});
test('an unknown DDL outcome is preserved and never triggers source edits or automatic retry',async()=>{
 const h=host();h.unknown=true;try{const plan=await h.api.preview({kind:'column',table:'people',column:'name',newName:'label'});const result=await h.api.apply(plan.id,{updateSql:true});assert.equal(result.state,'unknown');assert.equal(result.outcomeUnknown,true);assert.equal(h.counts.ddlCalls,1);assert.equal(h.counts.sourceCalls,0);assert.equal(h.counts.refreshCalls,1);}finally{await h.api.dispose();}
});
test('incomplete SQL scope requires database-only review and trust is rechecked before apply',async()=>{
 const h=host();h.sqlAnalysis.findCatalogReferences=async()=>({coverage:{complete:false,unknownFiles:['migration.sql']},references:[]});
 try{const plan=await h.api.preview({kind:'table',table:'people',newName:'members'});assert.equal(plan.sourcePlanId,undefined);await assert.rejects(h.api.apply(plan.id,{updateSql:true}),/incomplete/);h.vscode.workspace.isTrusted=false;await assert.rejects(h.api.apply(plan.id),/Trust/);assert.equal(h.counts.ddlCalls,0);}finally{await h.api.dispose();}
});
test('hidden dependency acknowledgment is explicit and a rejected default does not consume the review',async()=>{
 const h=host();h.database.previewSchemaRename=async request=>({...request,schema:'fixture',reviewId:'ddl',connectionEpoch:7,requiresUnverifiedDependencyApproval:true,expiresAt:Date.now()+120000});
 try{const plan=await h.api.preview({kind:'table',table:'people',newName:'members'});await assert.rejects(h.api.apply(plan.id),/acknowledge/);assert.equal(h.counts.ddlCalls,0);const result=await h.api.apply(plan.id,{allowUnverifiedDependencies:true});assert.equal(result.state,'applied');assert.equal(h.counts.ddlCalls,1);}finally{await h.api.dispose();}
});
