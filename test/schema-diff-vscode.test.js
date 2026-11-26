'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {registerSchemaComparison}=require('../src/db/schema-diff-vscode');
const {fixture,addColumn}=require('./helpers/schema-diff-fixture');
const {makePlan}=require('../src/db/schema-recovery');
function host(capture,options={}){
 const commands=new Map(),providers=new Map(),vscode={workspace:{isTrusted:true,registerTextDocumentContentProvider(scheme,provider){providers.set(scheme,provider);return {dispose(){providers.delete(scheme);}};}},commands:{registerCommand(name,handler){commands.set(name,handler);return {dispose(){commands.delete(name);}};}},window:{showErrorMessage:async()=>{}}};
 return {vscode,commands,providers,api:registerSchemaComparison({},vscode,{capture,...options})};
}

test('reprojection review can select an unchanged InnoDB geometry table without offering unrelated unchanged tables',async()=>{
 const raw=fixture(),spatial=raw.tables[0];spatial.name='locations';spatial.columns.push({...spatial.columns[0],name:'location',type:'geometry',key:'',ordinal:2});raw.tables.push({...structuredClone(fixture().tables[0]),name:'plain'});
 const current=require('../src/db/schema-diff').normalizeSnapshot(raw,{verifyFingerprint:false}),h=host(async()=>current);let picks=0,offered;
 h.vscode.window.showQuickPick=async items=>{picks++;if(picks===1)return items[0];offered=items;return undefined;};
 try{const comparison=await h.api.compare(structuredClone(current));assert.equal(comparison.changes.length,0);await h.commands.get('rocketbrain.schema.reviewRebuild')();assert.deepEqual(offered,['locations']);assert.equal(picks,2);}finally{await h.api.dispose();}
});

test('dependency and lossy approvals are independent, strict and checked before consuming the immutable rebuild review',async()=>{
 const current=fixture(),desired=fixture();desired.tables[0].columns[0].type='bigint';const target=require('../src/db/schema-diff').normalizeSnapshot(desired,{verifyFingerprint:false});let applications=0,preparations=0;
 const h=host(async()=>current,{prepareRebuild:async request=>{preparations++;assert.deepEqual(request.conversions,{});const plan=makePlan(request.current,request.desired,{tables:request.tables});plan.requiresDependencyChangeApproval=true;plan.requiresLossyConversionApproval=true;return{plan,reviewId:plan.id,expiresAt:Date.now()+120000,connectionEpoch:5};},applyRebuild:async request=>{applications++;assert.equal(request.allowDependencyChanges,true);assert.equal(request.allowLossyConversions,true);return{id:request.reviewId,state:'applied',steps:[]};}});
 try{const comparison=await h.api.compare(target),plan=await h.api.planRebuild(comparison.id,['people'],{conversions:{}}),base={allowDestructive:true,allowImplicitCommit:true,allowLossyConversions:true};plan.requiresDependencyChangeApproval=false;plan.requiresLossyConversionApproval=false;await assert.rejects(h.api.applyRebuild(plan.id,base),/dependency/i);await assert.rejects(h.api.applyRebuild(plan.id,{...base,allowDependencyChanges:'true'}),/dependency/i);await assert.rejects(h.api.applyRebuild(plan.id,{...base,allowDependencyChanges:true,allowLossyConversions:false}),/lossy|conversion/i);assert.equal(applications,0);assert.equal((await h.api.applyRebuild(plan.id,{...base,allowDependencyChanges:true,allowLossyConversions:true})).state,'applied');assert.equal(applications,1);assert.equal(preparations,1);}finally{await h.api.dispose();}
});
test('destructive rebuild UI keeps private plans, requires explicit scope approvals and carries recovery epochs',async()=>{
 const current=fixture(),desired=fixture();desired.tables[0].columns[0].type='bigint';const target=require('../src/db/schema-diff').normalizeSnapshot(desired,{verifyFingerprint:false});let applied=0,recovered=0;
 const h=host(async()=>current,{prepareRebuild:async request=>{const plan=makePlan(request.current,request.desired,{tables:request.tables});plan.requiresUnverifiedDependencyApproval=true;return{plan,reviewId:plan.id,expiresAt:Date.now()+120000,connectionEpoch:7};},applyRebuild:async request=>{applied++;assert.equal(request.connectionEpoch,7);assert.equal(request.allowUnverifiedDependencies,true);return{id:request.reviewId,state:'applied',steps:[]};},listRecoveries:async()=>({connectionEpoch:8,operations:[{operationId:'a'.repeat(32),state:'applied',tables:['people']}]}),recoverRebuild:async request=>{recovered++;assert.equal(request.connectionEpoch,8);return{operationId:request.operationId,state:'recovered',originalSchemaAndDataVerified:true,steps:[]};}});
 try{const comparison=await h.api.compare(target),plan=await h.api.planRebuild(comparison.id,['people']);plan.sql='DROP DATABASE other';const text=h.providers.get('rocketbrain-schema-compare').provideTextDocumentContent({path:'/'+plan.id+'/migration.sql'});assert.doesNotMatch(text,/DROP DATABASE/);await assert.rejects(h.api.applyRebuild(plan.id),/Acknowledge/);await assert.rejects(h.api.applyRebuild(plan.id,{allowDestructive:true,allowImplicitCommit:true}),/uninspectable/);assert.equal(applied,0);const result=await h.api.applyRebuild(plan.id,{allowDestructive:true,allowImplicitCommit:true,allowUnverifiedDependencies:true});assert.equal(result.state,'applied');await assert.rejects(h.api.applyRebuild(plan.id,{allowDestructive:true,allowImplicitCommit:true}),/Prepare/);const operations=await h.api.listRecoveries();assert.equal(operations.connectionEpoch,8);const recovery=await h.api.recoverRebuild(operations.operations[0].operationId,{connectionEpoch:8,allowDestructive:true,allowImplicitCommit:true,allowUnverifiedDependencies:true});assert.equal(recovery.state,'recovered');assert.match(h.api.applicationText(recovery.id),/retained|retaining|retention|retained/i);assert.equal(recovered,1);}finally{await h.api.dispose();}
});
test('disposing rebuild UI aborts and awaits its own running recovery operation',async()=>{
 const current=fixture(),desired=fixture();desired.tables[0].columns[0].type='bigint';const target=require('../src/db/schema-diff').normalizeSnapshot(desired,{verifyFingerprint:false});let entered,aborted=false;const started=new Promise(resolve=>entered=resolve);
 const h=host(async()=>current,{prepareRebuild:async request=>{const plan=makePlan(request.current,request.desired,{tables:request.tables});return{plan,reviewId:plan.id,expiresAt:Date.now()+120000,connectionEpoch:7};},applyRebuild:request=>new Promise(resolve=>{entered();request.cancellation.addEventListener('abort',()=>{aborted=true;resolve({id:request.reviewId,state:'needs-recovery',steps:[]});},{once:true});})});
 const comparison=await h.api.compare(target),plan=await h.api.planRebuild(comparison.id,['people']),work=h.api.applyRebuild(plan.id,{allowDestructive:true,allowImplicitCommit:true});await started;await h.api.dispose();assert.equal(aborted,true);assert.equal((await work).state,'needs-recovery');await assert.rejects(h.api.listRecoveries(),/closed/);
});

test('preflight refusal has a report without a recoverable operation ID', async () => {
 const current=fixture(),target=addColumn(structuredClone(current));
 const h=host(async()=>current,{
  prepareRebuild:async request=>{
   const plan=makePlan(request.current,request.desired,{tables:request.tables});
   return {plan,reviewId:plan.id,expiresAt:Date.now()+120000,connectionEpoch:7};
  },
  applyRebuild:async request=>({id:request.reviewId,state:'preflight-refused',recoveryRequired:false,error:{message:'Lookup metadata changed.'}})
 });
 try{
  const comparison=await h.api.compare(target);
  const plan=await h.api.planRebuild(comparison.id,['people']);
  const flags={allowDestructive:true,allowImplicitCommit:true};
  const report=await h.api.applyRebuild(plan.id,flags);
  assert.equal(report.operationId,undefined);
  const text=h.api.applicationText(report.id);
  assert.match(text,/Lookup metadata changed/u);
  assert.match(text,/Stopped before sending any schema or recovery journal writes/u);
  assert.doesNotMatch(text,/quarantine|Operation:/u);
  await assert.rejects(h.api.applyRebuild(plan.id,flags),/Prepare a reviewed rebuild/u);
 }finally{await h.api.dispose();}
});

test('table designer removes the recovery action after a terminal preflight refusal', async () => {
 const {registerTableDesigner}=require('../src/db/schema-designer-vscode');
 const posted=[],disposable={dispose(){}},draft={name:'people'};
 const panel={...disposable,onDidDispose:()=>disposable,webview:{onDidReceiveMessage:()=>disposable,postMessage:message=>posted.push(message)}};
 const vscode={ViewColumn:{One:1},window:{createWebviewPanel:()=>panel,showWarningMessage:async(_message,_options,action)=>action},
  workspace:{isTrusted:true,registerTextDocumentContentProvider:()=>disposable},commands:{registerCommand:()=>disposable}};
 let recoveryReads=0;
 const api=registerTableDesigner({subscriptions:[]},vscode,{database:{
  openTableDesigner:async()=>({modelId:'design',mode:'edit',draft}),
  previewTableDesign:async()=>({kind:'rebuild',plan:{id:'plan'},reviewId:'review',connectionEpoch:1}),
  applyTableDesign:async()=>({state:'preflight-refused',recoveryRequired:false,error:{message:'Lookup metadata changed.'}}),
  listSchemaRecoveries:async()=>{recoveryReads++;return {connectionEpoch:1,operations:[]};}
 }});
 try{
  await api.openDesigner({table:'people'});
  await api.reviewDesigner('design',draft);
  await api.handleDesigner('design',{type:'apply',modelId:'design',revision:1,draft});
  assert.equal(posted.at(-1).canRecover,false);
  assert.match(posted.at(-1).status,/Stopped before schema or journal writes/u);
  await assert.rejects(api.recoverDesigner('design',{}),/no retained rebuild/u);
  assert.equal(recoveryReads,0);
 }finally{await api.dispose();}
});
test('schema reviews keep private typed SQL and refresh metadata before producing a readonly plan',async()=>{
 const current=fixture(),desired=addColumn(structuredClone(current));let reads=0;const {api,providers}=host(async()=>{reads++;return current;});
 try{
  const report=await api.compare(desired);assert.equal(reads,1);const id=report.changes[0].id;report.changes[0].sql='DROP TABLE people';
  const plan=await api.plan(report.id,[id]);assert.equal(reads,2);assert.match(plan.steps[0].sql,/ADD COLUMN/);assert.equal(plan.executesSql,false);assert.equal(plan.automaticApplyImplemented,false);
  plan.steps[0].sql='DROP TABLE people';const content=providers.get('rocketbrain-schema-compare').provideTextDocumentContent({path:'/'+plan.id+'/migration.sql'});assert.match(content,/ADD COLUMN/);assert.doesNotMatch(content,/DROP TABLE/);assert.match(api.reviewText(report.id),/No row data was compared/);
  assert.equal((await api.validate(plan.id)).state,'fresh');assert.equal(reads,3);
 }finally{await api.dispose();assert.equal(providers.size,0);}
});

test('owned schema Apply uses its private selected review and exposes readonly per-step outcome',async()=>{
 const current=fixture(),desired=addColumn(structuredClone(current)),{planMigration}=require('../src/db/schema-diff');let calls=0,received;
 const h=host(async()=>current,{prepare:async request=>{const plan=planMigration(request.current,request.desired,{changeIds:request.changeIds});return{plan,reviewId:'private-backend-review',expiresAt:Date.now()+120000,connectionEpoch:4};},apply:async request=>{calls++;received=request;return{state:'applied',database:'one',completed:1,notRun:0,outcomeUnknown:false,steps:[{index:0,kind:'add-column',table:'people',object:'note',sql:'ALTER TABLE `one`.`people` ADD COLUMN `note` VARCHAR(30) NULL',status:'applied',acknowledged:true,verified:true}]};}});
 try{const compared=await h.api.compare(desired),plan=await h.api.plan(compared.id,[compared.changes[0].id]);assert.equal(plan.automaticApplyImplemented,true);plan.applicationReview.reviewId='attacker-token';plan.steps[0].sql='DROP DATABASE one';await assert.rejects(h.api.apply(plan.id),/acknowledge/);assert.equal(calls,0);const result=await h.api.apply(plan.id,{allowImplicitCommit:true});assert.equal(received.reviewId,'private-backend-review');assert.equal(received.connectionEpoch,4);assert.equal(Object.hasOwn(received,'sql'),false);assert.equal(calls,1);assert.match(h.api.applicationText(result.id),/Status: applied/);assert.doesNotMatch(h.api.applicationText(result.id),/DROP DATABASE/);const text=h.providers.get('rocketbrain-schema-compare').provideTextDocumentContent({path:'/'+result.id+'/application.md'});assert.match(text,/not one transaction/);await assert.rejects(h.api.apply(plan.id,{allowImplicitCommit:true}),/Prepare a new/);}finally{await h.api.dispose();}
});

test('owned schema Apply rechecks workspace trust and discards unapplied reviews on close',async()=>{
 const current=fixture(),desired=addColumn(structuredClone(current)),{planMigration}=require('../src/db/schema-diff'),discarded=[];let calls=0;
 const h=host(async()=>current,{prepare:async request=>{const plan=planMigration(request.current,request.desired,{changeIds:request.changeIds});return{plan,reviewId:'backend',expiresAt:Date.now()+120000};},apply:async()=>{calls++;},discard:id=>discarded.push(id)});
 const compared=await h.api.compare(desired),plan=await h.api.plan(compared.id,[compared.changes[0].id]);h.vscode.workspace.isTrusted=false;await assert.rejects(h.api.apply(plan.id,{allowImplicitCommit:true}),/Trust/);assert.equal(calls,0);await h.api.dispose();assert.deepEqual(discarded,['backend']);
});

test('schema UI disposal cancels and awaits its in-flight owned application',async()=>{
 const current=fixture(),desired=addColumn(structuredClone(current)),{planMigration}=require('../src/db/schema-diff');let aborted=false;
 const h=host(async()=>current,{prepare:async request=>{const plan=planMigration(request.current,request.desired,{changeIds:request.changeIds});return{plan,reviewId:'backend',expiresAt:Date.now()+120000};},apply:request=>new Promise(resolve=>request.cancellation.addEventListener('abort',()=>{aborted=true;resolve({state:'cancelled',database:'one',steps:[],completed:0,notRun:1});},{once:true}))});
 const compared=await h.api.compare(desired),plan=await h.api.plan(compared.id,[compared.changes[0].id]),running=h.api.apply(plan.id,{allowImplicitCommit:true});await h.api.dispose();assert.equal(aborted,true);assert.equal((await running).state,'cancelled');
});
test('schema UI rejects drift, workspace distrust and disposed captures without producing SQL',async()=>{
 const current=fixture(),desired=addColumn(structuredClone(current));let latest=current;const {api,vscode}=host(async()=>latest);
 const report=await api.compare(desired,{current});latest=desired;await assert.rejects(api.plan(report.id,[report.changes[0].id]),/changed/);latest=current;
 const migration=await api.plan(report.id,[report.changes[0].id]);latest=desired;await assert.rejects(api.validate(migration.id),/changed/);
 vscode.workspace.isTrusted=false;await assert.rejects(api.capture(),/Trust/);vscode.workspace.isTrusted=true;await api.dispose();await assert.rejects(api.capture(),/closed/);
});
test('local snapshot imports validate fingerprints and enforce bounded regular files',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'rocketbrain-schema-ui-')),file=path.join(directory,'snapshot.json'),large=path.join(directory,'oversized.json'),{api}=host(async()=>fixture());
 try{
  const snapshot=fixture();fs.writeFileSync(file,JSON.stringify(snapshot));const uri={scheme:'file',authority:'',fsPath:file};assert.equal(api.readSnapshot(uri).fingerprint,snapshot.fingerprint);
  snapshot.tables[0].columns[0].type='bigint';fs.writeFileSync(file,JSON.stringify(snapshot));assert.throws(()=>api.readSnapshot(uri),/fingerprint/);
  assert.throws(()=>api.readSnapshot({...uri,scheme:'https'}),/local/);assert.throws(()=>api.readSnapshot({...uri,authority:'remote-host'}),/local/);assert.throws(()=>api.readSnapshot({...uri,fsPath:directory}),/files/);
  const fd=fs.openSync(large,'w');fs.ftruncateSync(fd,8*1024*1024+1);fs.closeSync(fd);assert.throws(()=>api.readSnapshot({...uri,fsPath:large}),/8 MiB/);
 }finally{await api.dispose();for(const owned of [file,large])fs.unlinkSync(owned);fs.rmdirSync(directory);}
});
