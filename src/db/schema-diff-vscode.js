'use strict';
const fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const engine=require('./schema-diff');
const {isSelectableRebuildChange,projectSelectedRebuild}=require('./schema-rebuild-selection');

const rebuildChangeLabels={
 'add-column':'Add column','drop-column':'Drop column','change-column':'Change column',
 'add-index':'Add index','drop-index':'Drop index','change-index':'Change index',
 'change-foreignKeys':'Change foreign keys','change-view':'Change view definition'
};

function registerSchemaComparison(context,vscode,{capture,prepare,apply:applyPrepared,discard,prepareRebuild,applyRebuild:applyPreparedRebuild,recoverRebuild:recoverPrepared,listRecoveries:readRecoveries,discardRebuild}={}){
 const comparisons=new Map(),plans=new Map(),applications=new Map(),rebuildApplications=new Map(),reports=new Map(),controllers=new Set(),operations=new Set(),subscriptions=[];let closed=false;
 const trusted=()=>{if(closed)throw new Error('Schema comparison is closed.');if(!vscode.workspace.isTrusted){for(const application of applications.values()){const task=Promise.resolve().then(()=>discard?.(application.reviewId));operations.add(task);void task.finally(()=>operations.delete(task)).catch(()=>{});}for(const application of rebuildApplications.values()){const task=Promise.resolve().then(()=>discardRebuild?.(application.reviewId));operations.add(task);void task.finally(()=>operations.delete(task)).catch(()=>{});}rebuildApplications.clear();applications.clear();plans.clear();comparisons.clear();throw new Error('Trust the workspace before inspecting database schemas.');}};
 function scopeOptions(snapshot){return snapshot.scope.kind==='selected-tables'?{tables:snapshot.scope.tables}:{};}
 async function captureSnapshot(options={}){trusted();const value=engine.normalizeSnapshot(await capture(options));trusted();return value;}
 async function compare(desiredValue,{current,comparisonOptions}={}){
  trusted();const desired=engine.normalizeSnapshot(desiredValue),before=current?engine.normalizeSnapshot(current):await captureSnapshot({
   ...scopeOptions(desired),...(desired.storedObjects&&{includeStoredObjects:true})
  }),report=engine.compareSnapshots(before,desired,comparisonOptions);trusted();
  while(comparisons.size>=10)comparisons.delete(comparisons.keys().next().value);
  const id=randomUUID();comparisons.set(id,{current:before,desired,report,createdAt:Date.now()});return {id,...structuredClone(report)};
 }
 async function plan(comparisonId,changeIds){
  trusted();const comparison=comparisons.get(comparisonId);if(!comparison||Date.now()-comparison.createdAt>10*60*1000)throw new Error('The schema comparison expired. Compare again.');
  if(comparison.report.reviewOnly)throw new Error('Comparison options are review-only. Use a standard schema comparison to plan migration.');
  let migration=engine.planMigration(comparison.current,comparison.desired,{changeIds});const fresh=await captureSnapshot(scopeOptions(comparison.current));engine.validateMigrationPlan(migration,fresh);trusted();
  let application;if(prepare){application=await prepare({current:structuredClone(comparison.current),desired:structuredClone(comparison.desired),changeIds:[...changeIds]});try{trusted();engine.validateMigrationPlan(application.plan,fresh);migration=structuredClone(application.plan);}catch(error){await discard?.(application.reviewId);throw error;}}
  while(plans.size>=10){const oldest=plans.keys().next().value;plans.delete(oldest);const review=applications.get(oldest);if(review)await discard?.(review.reviewId);applications.delete(oldest);}plans.set(migration.id,migration);if(application)applications.set(migration.id,{reviewId:application.reviewId,expiresAt:application.expiresAt,connectionEpoch:application.connectionEpoch});return {...structuredClone(migration),...(application?{automaticApplyImplemented:true,applicationReview:structuredClone(applications.get(migration.id))}:{})};
 }
 async function validate(planId){trusted();const migration=plans.get(planId);if(!migration)throw new Error('This schema migration review is unavailable.');const fresh=await captureSnapshot(scopeOptions(migration));trusted();return engine.validateMigrationPlan(migration,fresh);}
 async function apply(planId,{allowImplicitCommit=false,cancellation}={}){
  trusted();const migration=plans.get(planId),application=applications.get(planId);if(!migration||!application||!applyPrepared)throw new Error('Prepare a new selected migration review before applying.');if(allowImplicitCommit!==true)throw new Error('Review the selected SQL and explicitly acknowledge implicit commits before applying.');
  if(application.expiresAt<=Date.now()){applications.delete(planId);await discard?.(application.reviewId);throw new Error('The schema application review expired. Compare again.');}
  applications.delete(planId);const controller=new AbortController();controllers.add(controller);let external;
  const stop=()=>controller.abort();if(cancellation?.isCancellationRequested||cancellation?.aborted)controller.abort();if(cancellation?.onCancellationRequested)external=cancellation.onCancellationRequested(stop);else if(cancellation?.addEventListener){cancellation.addEventListener('abort',stop,{once:true});external={dispose:()=>cancellation.removeEventListener('abort',stop)};}
  try{const result=await applyPrepared({...application,allowImplicitCommit:true,cancellation:controller.signal});const id=randomUUID(),report={...structuredClone(result),id,planId};while(reports.size>=10)reports.delete(reports.keys().next().value);reports.set(id,report);return structuredClone(report);}
  finally{external?.dispose();controllers.delete(controller);}
 }
 function rebuildComparison(comparisonId){
  trusted();
  const comparison=comparisons.get(comparisonId);
  if(!comparison||Date.now()-comparison.createdAt>10*60*1000)throw new Error('The comparison expired. Compare again.');
  if(comparison.report.reviewOnly)throw new Error('Comparison options are review-only. Use a standard schema comparison to plan rebuilding.');
  return comparison;
 }
 async function planRebuild(comparisonId,tables,{conversions:conversionRules={},columnMappings,changeIds}={}){
  if(!prepareRebuild){trusted();throw new Error('Reviewed rebuilding is unavailable.');}
  const comparison=rebuildComparison(comparisonId);
  const projection=changeIds===undefined?undefined:projectSelectedRebuild(comparison.current,comparison.desired,changeIds);
  if(projection&&(!Array.isArray(tables)||new Set(tables).size!==projection.tables.length||
    tables.length!==projection.tables.length||!projection.tables.every(table=>tables.includes(table)))){
   throw new Error('The selected tables do not match the reviewed schema changes.');
  }
  const prepared=await prepareRebuild({
   current:structuredClone(comparison.current),desired:structuredClone(comparison.desired),
   tables:projection?projection.tables:tables,conversions:structuredClone(conversionRules),
   ...(columnMappings===undefined?{}:{columnMappings:structuredClone(columnMappings)}),
   ...(projection&&{changeIds:projection.changes.map(change=>change.id)})
  });
  try{
   if(projection)rebuildComparison(comparisonId);
   else trusted();
  }catch(error){await discardRebuild?.(prepared.reviewId);throw error;}
  while(rebuildApplications.size>=10){
   const oldest=rebuildApplications.keys().next().value,old=rebuildApplications.get(oldest);
   await discardRebuild?.(old.reviewId);
   rebuildApplications.delete(oldest);
   plans.delete(oldest);
  }
  const review=structuredClone(prepared.plan);
  if(projection)review.selectedChanges=projection.changes.map(({id,kind,table,object})=>({id,kind,table,object}));
  plans.set(review.id,review);
  rebuildApplications.set(review.id,{reviewId:prepared.reviewId,connectionEpoch:prepared.connectionEpoch,expiresAt:prepared.expiresAt});
  return {...structuredClone(review),applicationReview:structuredClone(rebuildApplications.get(review.id))};
 }
 async function withController(cancellation,fn){const controller=new AbortController();controllers.add(controller);const stop=()=>controller.abort();let external;if(cancellation?.aborted||cancellation?.isCancellationRequested)stop();if(cancellation?.onCancellationRequested)external=cancellation.onCancellationRequested(stop);else if(cancellation?.addEventListener){cancellation.addEventListener('abort',stop,{once:true});external={dispose:()=>cancellation.removeEventListener('abort',stop)};}try{return await fn(controller.signal);}finally{external?.dispose();controllers.delete(controller);}}
 function retainRebuildReport(value){const id=randomUUID(),report={...structuredClone(value),operationId:value.state==='preflight-refused'?undefined:value.operationId||value.id,id,rebuild:true};while(reports.size>=10)reports.delete(reports.keys().next().value);reports.set(id,report);return structuredClone(report);}
 async function applyRebuild(planId,{allowDestructive=false,allowImplicitCommit=false,allowUnverifiedDependencies=false,allowDependencyChanges=false,allowLossyConversions=false,autoRecover=true,cancellation}={}){trusted();const plan=plans.get(planId),application=rebuildApplications.get(planId);if(!plan||!application||!applyPreparedRebuild)throw new Error('Prepare a reviewed rebuild first.');if(allowDestructive!==true||allowImplicitCommit!==true)throw new Error('Acknowledge destructive changes and implicit commits before applying.');if(plan.requiresUnverifiedDependencyApproval&&allowUnverifiedDependencies!==true)throw new Error('Explicitly acknowledge uninspectable dependency definitions before applying.');if(plan.requiresDependencyChangeApproval&&allowDependencyChanges!==true)throw new Error('Explicitly acknowledge write fences and temporary dependency disruption.');if(plan.requiresLossyConversionApproval&&allowLossyConversions!==true)throw new Error('Explicitly acknowledge the reviewed lossy conversion policy.');if(application.expiresAt<=Date.now()){rebuildApplications.delete(planId);await discardRebuild?.(application.reviewId);throw new Error('The rebuild review expired. Compare again.');}rebuildApplications.delete(planId);return withController(cancellation,async signal=>retainRebuildReport(await applyPreparedRebuild({...application,allowDestructive:true,allowImplicitCommit:true,allowUnverifiedDependencies:allowUnverifiedDependencies===true,allowDependencyChanges:allowDependencyChanges===true,allowLossyConversions:allowLossyConversions===true,autoRecover:autoRecover!==false,cancellation:signal})));}
 async function listRecoveries(){trusted();if(!readRecoveries)throw new Error('Schema recovery is unavailable.');const value=await readRecoveries();trusted();return structuredClone(value);}
 async function recoverRebuild(operationId,{connectionEpoch,allowDestructive=false,allowImplicitCommit=false,allowUnverifiedDependencies=false,allowDependencyChanges=false,cancellation}={}){trusted();if(!recoverPrepared||allowDestructive!==true||allowImplicitCommit!==true)throw new Error('Acknowledge recovery swaps and implicit commits first.');return withController(cancellation,async signal=>retainRebuildReport(await recoverPrepared({operationId,connectionEpoch,allowDestructive:true,allowImplicitCommit:true,allowUnverifiedDependencies:allowUnverifiedDependencies===true,allowDependencyChanges:allowDependencyChanges===true,cancellation:signal})));}
 function applicationText(id){const report=reports.get(id);if(!report)return '# Schema application report unavailable';
  if(report.rebuild&&report.state==='preflight-refused')return ['# Schema rebuild refused during preflight','',report.error?.message||'The review is no longer applicable.','','Stopped before sending any schema or recovery journal writes. Refresh the comparison and create a new review.'].join('\n');
  if(report.rebuild)return ['# Schema rebuild/recovery '+report.state,`Operation: ${report.operationId}`,`Catalog refresh: ${report.metadataRefresh?.state||'not reported'}`,report.metadataRefresh?.message||'','','Original backups and after-state quarantine tables are retained. Automatic compensation is not a transaction rollback; changed application data blocks replacement.','MySQL uses a multi-name publish; MariaDB uses two journaled ALTER RENAME statements. Cross-table atomicity and all-reference safety are not promised.','','```json',JSON.stringify({state:report.state,operationId:report.operationId,steps:report.steps,automaticRecovery:report.automaticRecovery,error:report.error,recoveryError:report.recoveryError},null,2),'```'].join('\n');return ['# Schema application '+report.state,`Database: ${report.database}`,`Verified steps: ${report.completed}; not run: ${report.notRun}; outcome uncertain: ${report.outcomeUnknown===true}`,`Catalog refresh: ${report.metadataRefresh?.state||'not reported'}`,report.metadataRefresh?.message||'','','DDL steps are not one transaction. No automatic retry or reverse DDL was attempted. Inspect uncertain or partial results before making a new plan.','',...(report.steps||[]).flatMap(step=>[`## ${step.index+1}. ${step.kind} ${step.table}.${step.object}`,`Status: ${step.status}; acknowledged: ${step.acknowledged}; verified: ${step.verified}`,step.error?.message||'','```sql',step.sql+';','```','']),report.error?.message||''].join('\n');}
 function readSnapshot(uri){
  trusted();if(uri?.scheme!=='file'||uri.authority)throw new Error('Select a local schema snapshot file.');const handle=fs.openSync(uri.fsPath,'r');
  try{const stat=fs.fstatSync(handle);if(!stat.isFile()||stat.size>engine.LIMITS.snapshotBytes)throw new Error('Schema snapshots must be local JSON files no larger than 8 MiB.');const data=Buffer.alloc(engine.LIMITS.snapshotBytes+1),size=fs.readSync(handle,data,0,data.length,0);if(size>engine.LIMITS.snapshotBytes)throw new Error('The schema snapshot exceeds 8 MiB.');return engine.normalizeSnapshot(JSON.parse(data.subarray(0,size).toString('utf8').replace(/^\uFEFF/,'')));}finally{fs.closeSync(handle);}
 }
 function reviewText(comparisonId){
  const value=comparisons.get(comparisonId);if(!value)return 'Schema comparison expired.';const report=value.report;
  const rebuildIds=new Set(!prepareRebuild||report.reviewOnly?[]:report.changes.filter(change=>
   isSelectableRebuildChange(change,value.current,value.desired)).map(change=>change.id));
  return ['# Schema comparison',`Current: ${report.currentDatabase} · ${report.currentServer.dialect} ${report.currentServer.version}`,`Desired: ${report.desiredDatabase} · ${report.desiredServer.dialect} ${report.desiredServer.version}`,
   ...comparisonOptionLines(report),
   '',`${report.summary.changes} differences; ${report.summary.selectable} additive SQL candidates; ${report.summary.blocked} changes need separate migration work.`,
   ...(rebuildIds.size?['Use Review Selected Schema Rebuild to choose individual changes for a guarded rebuild.']:[]),
   '',...report.warnings.map(v=>'- '+v),'','No row data was compared. Account visibility and non-atomic metadata reads limit this report.','',
   ...report.changes.flatMap(change=>[change.kind==='change-view'&&rebuildIds.has(change.id)
    ?`## View definition: ${report.currentDatabase}.${change.table}`:`## ${change.kind}: ${change.table}.${change.object}`,
    change.selectable?'Selectable additive SQL review candidate.':rebuildIds.has(change.id)?'Selectable in a reviewed rebuild.':'Not selectable: '+change.reason,
    change.sql?'```sql\n'+change.sql+';\n```':'```json\n'+JSON.stringify({before:change.before,after:change.after},null,2)+'\n```','']),
   ...storedReviewLines(report.storedObjects)].join('\n');
 }
 function comparisonOptionLines(report){
  if(!report.reviewOnly)return [];
  const rule=server=>server.tableNameCaseSensitive?'case sensitive (lower_case_table_names = 0)':'case insensitive (lower_case_table_names = 1 or 2)';
  const {identifierCase,definer}=report.comparisonOptions;
  return ['', '## Review-only comparison options',
   'Identifier comparison: '+(identifierCase==='exact'?'exact spelling':'ASCII case-insensitive'),
   'DEFINER account: '+(definer==='include'?'included':'ignored in recognized CREATE headers'),
   `Table lookups on each engine: current ${rule(report.currentServer)}; desired ${rule(report.desiredServer)}.`,
   'SQL SECURITY mode and definition bodies remain comparable. Use Open Compared Table or View DDL to inspect exact captured source.',
   `${report.caseCollisions} ambiguous table/view case groups. Ambiguous groups are not paired.`,
   ...report.foldedPairs.map(pair=>`- Paired observed names: ${JSON.stringify(pair.current)} ↔ ${JSON.stringify(pair.desired)}`)];
 }
 function storedReviewLines(stored) {
  if(!stored)return [];
  if(stored.state==='not-compared')return ['## Stored-object comparison',stored.reason,''];
  return ['## Stored-object comparison',stored.note,
   'Missing inventory or source stays unresolved. An object visible on only one side may exist under different permissions.',
   'Use Open Stored Object Diff for side-by-side source. Stored objects cannot be selected for migration.',
   '',`${stored.matchedExact} exact source/context matches; ${stored.differences.length} differences or unresolved objects.`,
   ...(Object.hasOwn(stored,'matchedByOptions')?[`${stored.matchedByOptions} additional matches under comparison options.`]:[]),
   '```json',JSON.stringify({current:stored.current,desired:stored.desired},null,2),'```','',
   ...stored.differences.flatMap(change=>[`### ${change.kind} ${change.name}`,`State: ${change.state}. Aspects: ${change.aspects.join(', ')||'none confirmed'}.`,
    ...(change.state==='ambiguous-identifier-case'?[`Current names: ${JSON.stringify(change.currentNames)}. Desired names: ${JSON.stringify(change.desiredNames)}.`]:[]),
    'Current: '+(change.before?.state||'outside visible inventory')+'. Desired: '+(change.after?.state||'outside visible inventory')+'.',
    ...(change.aspects.some(aspect=>aspect!=='definition')?['```json',JSON.stringify({
     current:{settings:change.before?.settings,trigger:change.before?.trigger},desired:{settings:change.after?.settings,trigger:change.after?.trigger}
    },null,2),'```']:[]),''])];
 }
 function storedSource(comparisonId,objectId,side){
  trusted();
  const change=comparisons.get(comparisonId)?.report.storedObjects?.differences.find(item=>item.id===objectId);
  const object=side==='current.sql'?change?.before:side==='desired.sql'?change?.after:undefined;
  return object?.state==='observed'?object.definition:'-- Complete source is unavailable on this side of the comparison.\n';
 }
 async function openStoredDiff(comparisonId,objectId){
  trusted();
  const item=comparisons.get(comparisonId)?.report.storedObjects?.differences.find(change=>change.id===objectId);
  if(!item||item.state==='ambiguous-identifier-case')throw Error('Choose an unambiguous retained stored-object difference.');
  const prefix='rocketbrain-schema-compare:/'+comparisonId+'/stored/'+objectId+'/';
  const current=vscode.Uri.parse(prefix+'current.sql'),desired=vscode.Uri.parse(prefix+'desired.sql');
  await vscode.commands.executeCommand('vscode.diff',current,desired,item.kind+' '+item.name+' · Stored Object');
  return {current:current.toString(),desired:desired.toString(),state:item.state,executedSql:false};
 }
 function definitionSource(comparisonId,definitionId,side){
  trusted();
  const comparison=comparisons.get(comparisonId),pair=comparison?.report.definitionPairs?.find(item=>item.id===definitionId);
  const source=side==='current.sql'?'current':side==='desired.sql'?'desired':null;
  return source&&pair&&comparison[source].tables.find(item=>item.name===pair[source])?.createSql||'-- Complete source is unavailable on this side of the comparison.\n';
 }
 async function openDefinitionDiff(comparisonId,definitionId){
  trusted();
  const pair=comparisons.get(comparisonId)?.report.definitionPairs?.find(item=>item.id===definitionId);
  if(!pair)throw Error('Choose an unambiguous table or view from a retained comparison with options.');
  const prefix='rocketbrain-schema-compare:/'+comparisonId+'/definition/'+definitionId+'/';
  const current=vscode.Uri.parse(prefix+'current.sql'),desired=vscode.Uri.parse(prefix+'desired.sql');
  await vscode.commands.executeCommand('vscode.diff',current,desired,(pair.desired??pair.current)+' · Captured DDL');
  return {current:current.toString(),desired:desired.toString(),executedSql:false};
 }
 function migrationText(planId){
  const plan=plans.get(planId);
  if(!plan?.sql)return '-- This schema migration review is unavailable.';
  if(!plan.selectedChanges)return plan.sql;
  return ['-- Selected schema changes',...plan.selectedChanges.map(change=>{
   const target=change.kind==='change-view'?[plan.database,change.table]:[change.table,change.object];
   return '-- '+rebuildChangeLabels[change.kind]+' '+target.map(part=>JSON.stringify(part)).join('.')+'  '+change.id;
  }),'',plan.sql].join('\n');
 }
 subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('rocketbrain-schema-compare',{provideTextDocumentContent(uri){const pieces=uri.path.split('/').filter(Boolean);if(pieces[1]==='migration.sql')return migrationText(pieces[0]);if(pieces[1]==='application.md')return applicationText(pieces[0]);if(pieces[1]==='stored')return storedSource(pieces[0],pieces[2],pieces[3]);if(pieces[1]==='definition')return definitionSource(pieces[0],pieces[2],pieces[3]);return reviewText(pieces[0]);}}));
 async function saveSnapshotCommand(includeStoredObjects=false){
  const value=await api.capture({includeStoredObjects}),destination=await vscode.window.showSaveDialog({title:includeStoredObjects?'Save Schema Snapshot with Stored Objects':'Save Schema Snapshot',filters:{'Rocketbrain schema snapshot':['json']},defaultUri:vscode.Uri.file(path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath||process.cwd(),value.database+'-schema.json'))});
  if(!destination)return;trusted();if(destination.scheme!=='file'||destination.authority)throw new Error('Save the snapshot to a local JSON file.');
  const body=Buffer.from(JSON.stringify(value,null,includeStoredObjects?undefined:2)+'\n','utf8');
  if(body.length>engine.LIMITS.snapshotBytes)throw Error('The saved schema snapshot would exceed 8 MiB.');
  await vscode.workspace.fs.writeFile(destination,body);
  return {state:'saved',uri:destination.toString(),fingerprint:value.fingerprint,
   ...(value.storedObjects&&{storedObjectsFingerprint:value.storedObjects.fingerprint}),rowDataIncluded:false};
 }
 async function compareCommand(withOptions=false){
  const files=await vscode.window.showOpenDialog({title:'Choose Desired Schema Snapshot',canSelectMany:false,filters:{'Rocketbrain schema snapshot':['json']}});if(!files?.[0])return;
  const desired=readSnapshot(files[0]);
  const comparisonOptions=withOptions?await chooseComparisonOptions():undefined;if(withOptions&&!comparisonOptions)return;
  const report=await api.compare(desired,{comparisonOptions});const document=await vscode.workspace.openTextDocument(vscode.Uri.parse('rocketbrain-schema-compare:/'+report.id+'/comparison.md'));await vscode.window.showTextDocument(document,{preview:false});
  if(report.reviewOnly)return report;
  const selectable=report.changes.filter(c=>c.selectable);if(!selectable.length){await vscode.window.showInformationMessage('No supported additive SQL candidates. Review the comparison for changed or destructive definitions.');return report;}
  const selected=await vscode.window.showQuickPick(selectable.map(change=>({label:change.kind+' · '+change.table+'.'+change.object,description:'Additive SQL review; not executed',change})),{title:'Select Changes for Migration SQL Review',canPickMany:true});if(!selected?.length)return report;
  const migration=await api.plan(report.id,selected.map(value=>value.change.id)),review=await vscode.workspace.openTextDocument(vscode.Uri.parse('rocketbrain-schema-compare:/'+migration.id+'/migration.sql'));await vscode.window.showTextDocument(review,{preview:false});
  await vscode.window.showInformationMessage(prepare?'Review the selected SQL, then use Apply Reviewed Schema Migration. Each DDL can commit independently.':'Migration SQL is a review plan. Revalidate the current schema before explicit execution; DDL steps are not one transaction.');return migration;
 }
 async function chooseComparisonOptions(){
  const identifierCase=await vscode.window.showQuickPick([
   {label:'Exact observed spelling',value:'exact'},
   {label:'Ignore ASCII case in identifiers',description:'Pair unambiguous names in full visible database snapshots',value:'ascii-insensitive'}
  ],{title:'Schema Comparison · Identifier Case'});if(!identifierCase)return null;
  const definer=await vscode.window.showQuickPick([
   {label:'Include DEFINER accounts',value:'include'},
   {label:'Ignore DEFINER accounts',description:'Skip only an observed CREATE header account for this comparison',value:'ignore'}
  ],{title:'Schema Comparison · DEFINER Account'});if(!definer)return null;
  return {identifierCase:identifierCase.value,definer:definer.value};
 }
 function command(name,fn){subscriptions.push(vscode.commands.registerCommand(name,async()=>{try{return await fn();}catch(error){if(!closed)await vscode.window.showErrorMessage('Rocketbrain Schema: '+error.message);}}));}
 command('rocketbrain.schema.saveSnapshot',saveSnapshotCommand);command('rocketbrain.schema.compareSnapshot',compareCommand);
 command('rocketbrain.schema.compareSnapshotWithOptions',()=>compareCommand(true));
 command('rocketbrain.schema.openComparedDefinition',async()=>{
  trusted();
  const items=[...comparisons].flatMap(([comparisonId,{report}])=>(report.definitionPairs||[]).map(pair=>({
   label:pair.desired??pair.current,description:report.currentDatabase+' ↔ '+report.desiredDatabase,comparisonId,definitionId:pair.id
  })));
  if(!items.length)throw Error('Compare a schema with options first.');
  const selected=await vscode.window.showQuickPick(items,{title:'Open Compared Table or View DDL'});
  if(selected)return api.openDefinitionDiff(selected.comparisonId,selected.definitionId);
 });
 command('rocketbrain.schema.saveSnapshotWithStoredObjects',()=>saveSnapshotCommand(true));
 command('rocketbrain.schema.openStoredObjectDiff',async()=>{
  trusted();
  const items=[...comparisons].flatMap(([comparisonId,{report}])=>(report.storedObjects?.differences||[]).filter(change=>change.state!=='ambiguous-identifier-case').map(change=>({
   label:change.kind+' '+change.name,description:change.state,detail:report.currentDatabase+' ↔ '+report.desiredDatabase,comparisonId,objectId:change.id
  })));
  if(!items.length)throw Error('Compare snapshots with stored-object metadata first.');
  const selected=await vscode.window.showQuickPick(items,{title:'Open Stored Object Diff'});
  if(selected)return openStoredDiff(selected.comparisonId,selected.objectId);
 });
 command('rocketbrain.schema.validateMigration',async()=>{trusted();const items=[...plans.values()].filter(p=>p.format==='RocketbrainSchemaMigrationPlan');if(!items.length)throw new Error('Create a selected schema migration review first.');const selected=await vscode.window.showQuickPick(items.map(p=>({label:p.database+' · '+p.steps.length+' step(s)',description:p.createdAt,plan:p})),{title:'Revalidate Migration Review'});if(!selected)return;const result=await api.validate(selected.plan.id);await vscode.window.showInformationMessage('Current schema still matches this migration review. Exported SQL does not enforce this check at later execution.');return result;});
 command('rocketbrain.schema.applyMigration',async()=>{trusted();const choices=[...plans.values()].filter(p=>applications.has(p.id)).map(p=>({label:p.database+' · '+p.steps.length+' selected step(s)',description:p.createdAt,plan:p}));if(!choices.length)throw new Error('Create a selected migration review first.');const selected=await vscode.window.showQuickPick(choices,{title:'Apply Reviewed Schema Migration'});if(!selected)return;const document=await vscode.workspace.openTextDocument(vscode.Uri.parse('rocketbrain-schema-compare:/'+selected.plan.id+'/migration.sql'));await vscode.window.showTextDocument(document,{preview:false});const accepted=await vscode.window.showWarningMessage('Apply this reviewed SQL? Each schema statement can commit implicitly. Earlier successful steps remain when a later one fails; automatic retry and rollback are unavailable.',{modal:true},'Apply Reviewed Schema');if(accepted!=='Apply Reviewed Schema')return;trusted();const report=await vscode.window.withProgress({title:'Applying reviewed schema changes',location:vscode.ProgressLocation.Notification,cancellable:true},(_progress,cancellation)=>api.apply(selected.plan.id,{allowImplicitCommit:true,cancellation}));const outcome=await vscode.workspace.openTextDocument(vscode.Uri.parse('rocketbrain-schema-compare:/'+report.id+'/application.md'));await vscode.window.showTextDocument(outcome,{preview:false});return report;});
 async function reviewRebuildTarget(comparisonId,current,desired,tables,selectedChanges){
  const conversion=require('./schema-conversion-vscode');
  const columnMappings=await conversion.chooseColumnMappings(vscode,current,desired,tables);
  if(columnMappings===null)return;
  let selectedColumns;
  if(selectedChanges){
   rebuildComparison(comparisonId);
   selectedColumns=new Map();
   for(const {kind,table,object} of selectedChanges){
    if(kind!=='add-column'&&kind!=='change-column')continue;
    if(!selectedColumns.has(table))selectedColumns.set(table,new Set());
    selectedColumns.get(table).add(object);
   }
  }
  const conversions=await conversion.chooseConversions(vscode,current,desired,tables,{columnMappings,selectedColumns});
  if(conversions===null)return;
  const plan=await api.planRebuild(comparisonId,tables,{changeIds:selectedChanges?.map(change=>change.id),conversions,columnMappings});
  const document=await vscode.workspace.openTextDocument(vscode.Uri.parse('rocketbrain-schema-compare:/'+plan.id+'/migration.sql'));
  await vscode.window.showTextDocument(document,{preview:false});
  await vscode.window.showInformationMessage(selectedChanges
   ?'Review the selected changes, retained backups and dependency warnings. Then apply the reviewed rebuild.'
   :'Review the rebuild SQL, retained backup names, conversion limits and dependency warnings, then Apply Reviewed Schema Rebuild.');
  return plan;
 }
 command('rocketbrain.schema.reviewRebuild',async()=>{
  trusted();
  const choices=[...comparisons].filter(([,c])=>!c.report.reviewOnly).map(([id,c])=>({label:c.current.database+' · '+c.report.changes.length+' differences',id,value:c}));
  const selected=await vscode.window.showQuickPick(choices,{title:'Review Complex or Destructive Schema Rebuild'});
  if(!selected)return;
  const {current,desired,report}=selected.value;
  const spatialTables=current.tables.filter(table=>table.kind==="table"&&String(table.engine).toUpperCase()==="INNODB"&&
   table.columns.some(column=>/^(?:geometry|point|linestring|polygon|multipoint|multilinestring|multipolygon|geometrycollection|geomcollection)$/i.test(column.type.trim()))).map(table=>table.name);
  const names=[...new Set([...report.changes.map(change=>change.table),...spatialTables])].filter(name=>current.tables.some(table=>table.name===name));
  const tables=await vscode.window.showQuickPick(names,{title:'Select Existing Tables to Rebuild or Retire',canPickMany:true});
  if(tables?.length)return reviewRebuildTarget(selected.id,current,desired,tables);
 });
 command('rocketbrain.schema.reviewSelectedRebuild',async()=>{
  trusted();
  if(!prepareRebuild)throw new Error('Reviewed rebuilding is unavailable.');
  const choices=[];
  for(const [id,comparison] of comparisons){
   if(comparison.report.reviewOnly||Date.now()-comparison.createdAt>10*60*1000)continue;
   const count=comparison.report.changes.filter(change=>isSelectableRebuildChange(change,comparison.current,comparison.desired)).length;
   if(count)choices.push({label:comparison.current.database+' · '+count+' available changes',
    description:'Desired '+comparison.desired.database,detail:'Compared '+new Date(comparison.createdAt).toISOString(),id});
  }
  if(!choices.length)throw new Error('Compare snapshots with supported changes to existing tables first.');
  const selected=await vscode.window.showQuickPick(choices,{title:'Review Selected Schema Rebuild'});
  if(!selected)return;
  const comparison=rebuildComparison(selected.id),{current,desired,report}=comparison;
  const byId=new Map(report.changes.map(change=>[change.id,change]));
  const choicesForChanges=report.changes.filter(change=>isSelectableRebuildChange(change,current,desired)).map(change=>{
   if(change.kind==='change-view')return {label:current.database+'.'+change.table,
    description:rebuildChangeLabels[change.kind],changeId:change.id,
    detail:'Select a base table change and every view that references a column you map.'};
   const dependencies=(change.dependencies||[]).map(id=>byId.get(id)).filter(Boolean);
   const required=dependencies.slice(0,3).map(item=>item.table+'.'+item.object).join(', ');
   return {label:change.table+'.'+change.object,description:rebuildChangeLabels[change.kind],changeId:change.id,
    detail:required?'Also select '+required+(dependencies.length>3?' and '+(dependencies.length-3)+' more':''):undefined};
  });
  const picked=await vscode.window.showQuickPick(choicesForChanges,{
   title:'Select Individual Rebuild Changes',canPickMany:true,matchOnDescription:true,matchOnDetail:true,
   placeHolder:'Select the changes to rebuild, including any required dependencies'
  });
  if(!picked?.length)return;
  rebuildComparison(selected.id);
  const changeIds=picked.map(item=>item.changeId);
  const projected=projectSelectedRebuild(current,desired,changeIds);
  return reviewRebuildTarget(selected.id,current,projected.desired,projected.tables,projected.changes);
 });
 async function outcome(report){const document=await vscode.workspace.openTextDocument(vscode.Uri.parse('rocketbrain-schema-compare:/'+report.id+'/application.md'));await vscode.window.showTextDocument(document,{preview:false});return report;}
 async function disruptionAck(plan){if(!plan.requiresDependencyChangeApproval)return true;const choice=await vscode.window.showWarningMessage('This plan temporarily detaches and restores the schema-qualified foreign keys, structured triggers and views listed in the readonly review, including related databases on this server. Owned database triggers reject normal client writes during the operation and can remain after interruption until recovery. Quiesce replication appliers, privileged bypasses and admin DDL; these are outside the fences.',{modal:true},'Accept Reviewed Dependency Disruption');return choice==='Accept Reviewed Dependency Disruption';}
 async function lossyAck(plan){if(!plan.requiresLossyConversionApproval)return true;const choice=await vscode.window.showWarningMessage('The reviewed conversion rules include deliberate rounding or truncation. Original values remain in retained backups; forward target values can lose digits. Accept only the displayed finite conversion policies?',{modal:true},'Accept Reviewed Lossy Conversions');return choice==='Accept Reviewed Lossy Conversions';}
 async function dependencyAck(plan){if(!plan?.requiresUnverifiedDependencyApproval)return false;const result=await vscode.window.showWarningMessage('Some stored dependency definitions are not visible. Known dependencies remain blocked; hidden application references are not proven safe. Accept this unverified scope?',{modal:true},'Accept Unverified Dependency Scope');return result==='Accept Unverified Dependency Scope';}
 command('rocketbrain.schema.applyRebuild',async()=>{
  trusted();
  const choices=[...plans.values()].filter(plan=>rebuildApplications.has(plan.id)).map(plan=>({
   label:plan.database+' · '+plan.steps.length+' table(s)',
   ...(plan.selectedChanges&&{description:plan.selectedChanges.length+' selected change(s)'}),plan
  }));
  const selected=await vscode.window.showQuickPick(choices,{title:'Apply Reviewed Schema Rebuild'});
  if(!selected)return;
  const {plan}=selected;
  const document=await vscode.workspace.openTextDocument(vscode.Uri.parse('rocketbrain-schema-compare:/'+plan.id+'/migration.sql'));
  await vscode.window.showTextDocument(document,{preview:false});
  const unknown=await dependencyAck(plan);
  if(plan.requiresUnverifiedDependencyApproval&&!unknown)return;
  if(!await disruptionAck(plan)||!await lossyAck(plan))return;
  const question=plan.selectedChanges
   ?'Apply the '+plan.selectedChanges.length+' selected change(s) through a destructive rebuild?'
   :'Apply the reviewed destructive rebuild?';
  const accepted=await vscode.window.showWarningMessage(question+' Columns/table names may disappear. Original tables and data remain in named backups. DDL commits implicitly; guarded automatic compensation can fail or refuse changed live data.',{modal:true},'Apply Rebuild with Guarded Recovery');
  if(accepted!=='Apply Rebuild with Guarded Recovery')return;
  return outcome(await vscode.window.withProgress({title:'Rebuilding reviewed tables',location:vscode.ProgressLocation.Notification,cancellable:true},
   (_,cancellation)=>api.applyRebuild(plan.id,{allowDestructive:true,allowImplicitCommit:true,
    allowUnverifiedDependencies:unknown,allowDependencyChanges:plan.requiresDependencyChangeApproval===true,
    allowLossyConversions:plan.requiresLossyConversionApproval===true,autoRecover:true,cancellation})));
 });
 command('rocketbrain.schema.recoverRebuild',async()=>{const value=await api.listRecoveries(),selected=await vscode.window.showQuickPick(value.operations.map(operation=>({label:operation.state+' · '+operation.tables.join(', '),description:operation.operationId,operation})),{title:'Recover Retained Original Tables'});if(!selected)return;const unknown=await dependencyAck({requiresUnverifiedDependencyApproval:true});if(!unknown)return;if(!await disruptionAck({requiresDependencyChangeApproval:selected.operation.requiresDependencyChangeApproval===true}))return;const accepted=await vscode.window.showWarningMessage('Restore retained originals? Recovery verifies the current server, owned journal, backup schema/data and unchanged published rows before renaming. Changed live data is preserved and recovery is refused. Original/after tables are retained.',{modal:true},'Recover Verified Originals');if(accepted!=='Recover Verified Originals')return;return outcome(await vscode.window.withProgress({title:'Recovering retained original tables',location:vscode.ProgressLocation.Notification,cancellable:true},(_,cancellation)=>api.recoverRebuild(selected.operation.operationId,{connectionEpoch:value.connectionEpoch,allowDestructive:true,allowImplicitCommit:true,allowUnverifiedDependencies:true,allowDependencyChanges:selected.operation.requiresDependencyChangeApproval===true,cancellation})));});
 function tracked(fn){return(...args)=>{const work=fn(...args);operations.add(work);void work.finally(()=>operations.delete(work)).catch(()=>{});return work;};}
 const api={capture:tracked(captureSnapshot),compare:tracked(compare),openStoredDiff:tracked(openStoredDiff),openDefinitionDiff:tracked(openDefinitionDiff),plan:tracked(plan),validate:tracked(validate),apply:tracked(apply),planRebuild:tracked(planRebuild),applyRebuild:tracked(applyRebuild),recoverRebuild:tracked(recoverRebuild),listRecoveries:tracked(listRecoveries),readSnapshot,reviewText,applicationText,async dispose(){if(closed)return;closed=true;for(const controller of controllers)controller.abort();await Promise.allSettled([...operations]);await Promise.allSettled([...applications.values()].map(application=>discard?.(application.reviewId)));await Promise.allSettled([...rebuildApplications.values()].map(application=>discardRebuild?.(application.reviewId)));comparisons.clear();plans.clear();applications.clear();rebuildApplications.clear();reports.clear();for(const subscription of subscriptions)subscription.dispose();}};return api;
}
module.exports={registerSchemaComparison};
