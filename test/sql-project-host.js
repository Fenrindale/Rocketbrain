'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
async function runSqlProjectChecks(api,vscode,checks){
 const runtime=JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG,'utf8')),fixtureRoot=path.resolve(__dirname,'fixtures'),folder=fs.mkdtempSync(path.join(fixtureRoot,'sql-project-v10-')),owner=crypto.randomUUID();
 fs.writeFileSync(path.join(folder,'owner.json'),JSON.stringify({kind:'RocketbrainSqlProjectNative-v1',id:owner}));
 const sources={
  'a.sql':"SELECT p.display_name AS stable FROM rb_spring_person p WHERE p.display_name<>'display_name' /* display_name stays */;",
  'b.sql':'WITH x AS (SELECT display_name FROM rb_spring_person) SELECT x.display_name FROM x ORDER BY x.display_name;',
  'c.sql':'SELECT d.stable FROM (SELECT display_name AS stable FROM rb_spring_person) d;',
  'd.sql':'SELECT rb_spring_person.id FROM rb_spring_person;'
 };
 for(const [name,source]of Object.entries(sources))fs.writeFileSync(path.join(folder,name),source);
 const configuration=vscode.workspace.getConfiguration('rocketbrain.sql.project'),previous=configuration.inspect('roots')?.globalValue;
 let connected=false;
 try{
  await configuration.update('roots',[folder],vscode.ConfigurationTarget.Global);
  await api.connectMysql(JSON.parse(fs.readFileSync(runtime.dbConfigPath,'utf8')));connected=true;
  const catalog=await api.databaseCatalog();assert.ok(catalog.tables.some(t=>t.name==='rb_spring_person'),'Use standard naming for SQL project native checks.');await api.sqlAnalysis.refreshMetadata();
  const target={kind:'column',database:catalog.database,table:'rb_spring_person',column:'display_name'},found=await api.sqlAnalysis.findCatalogReferences(target);assert.equal(found.coverage.complete,true);assert.equal(found.references.length,6);assert.equal(new Set(found.references.map(r=>r.uri)).size,3);
  const document=await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(folder,'a.sql')));await vscode.window.showTextDocument(document);const position=document.positionAt(sources['a.sql'].indexOf('p.display_name')+3);
  assert.deepEqual(api.sqlAnalysis.catalogTargetAt(document,position),target);
  const nativeReferences=await vscode.commands.executeCommand('vscode.executeReferenceProvider',document.uri,position);assert.equal(nativeReferences.length,6);assert.equal(new Set(nativeReferences.map(r=>r.uri.toString())).size,3);
  checks.push('Native SQL Find References binds the actual catalog column across multiple workspace SQL files and implicit CTE outputs while preserving explicit output aliases and ignoring literal/comment text.');
  const plan=await api.sqlAnalysis.planCatalogRename(target,'person_label');assert.equal(plan.documents.length,4);assert.equal(plan.edits.size,3);assert.equal(plan.atomicWithDatabaseDDL,false);assert.equal(document.getText(),sources['a.sql']);
  const edit=await api.sqlAnalysis.catalogRenameEdit(plan.id,undefined,{reviewed:true});assert.equal(await vscode.workspace.applyEdit(edit),true);assert.ok(document.getText().includes('p.`person_label`'));assert.ok(document.getText().includes("'display_name' /* display_name stays */"));
  const c=await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(folder,'c.sql')));assert.equal(c.getText(),'SELECT d.stable FROM (SELECT `person_label` AS stable FROM rb_spring_person) d;');
  await vscode.window.showTextDocument(document);await vscode.commands.executeCommand('undo');for(const [name,source]of Object.entries(sources)){const doc=await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(folder,name)));assert.equal(doc.getText(),source,'Multi-file SQL edits undo together: '+name);}
  const tablePlan=await api.sqlAnalysis.planCatalogRename({kind:'table',database:catalog.database,table:'rb_spring_person'},'people_after_rename');assert.equal(tablePlan.documents.reduce((sum,d)=>sum+d.edits.length,0),5);assert.equal(tablePlan.edits.size,4);
  checks.push('Physical SQL source rename returns a reviewable multi-file WorkspaceEdit, propagates implicit column names, preserves explicit aliases and supports one native Undo without executing database DDL.');
  let guarded=await api.sqlAnalysis.planCatalogRename(target,'person_label');await api.sqlAnalysis.refreshMetadata();await assert.rejects(api.sqlAnalysis.validateCatalogRename(guarded.id),/metadata or connection changed/);
  guarded=await api.sqlAnalysis.planCatalogRename(target,'person_label');const append=new vscode.WorkspaceEdit();append.insert(document.uri,document.positionAt(document.getText().length),' ');await vscode.workspace.applyEdit(append);await assert.rejects(api.sqlAnalysis.catalogRenameEdit(guarded.id),/buffer changed/);await vscode.commands.executeCommand('undo');assert.equal(document.getText(),sources['a.sql']);
  guarded=await api.sqlAnalysis.planCatalogRename(target,'person_label');const extra=path.join(folder,'new.sql');fs.writeFileSync(extra,'SELECT id FROM rb_spring_person;');await assert.rejects(api.sqlAnalysis.validateCatalogRename(guarded.id),/file set/);fs.unlinkSync(extra);
  const migration=path.join(folder,'migration.sql');fs.writeFileSync(migration,'ALTER TABLE rb_spring_person ADD unknown_column int;');const partial=await api.sqlAnalysis.findCatalogReferences(target);assert.equal(partial.coverage.complete,false);assert.ok(partial.coverage.unknownFiles.some(f=>f.uri?.endsWith('/migration.sql')));await assert.rejects(api.sqlAnalysis.planCatalogRename(target,'person_label'),e=>e.code==='SQL_PROJECT_INCOMPLETE');fs.unlinkSync(migration);
  guarded=await api.sqlAnalysis.planCatalogRename(target,'person_label');fs.appendFileSync(path.join(folder,'d.sql'),' ');await assert.rejects(api.sqlAnalysis.validateCatalogRename(guarded.id),/disk|buffer changed/);fs.writeFileSync(path.join(folder,'d.sql'),sources['d.sql']);
  assert.deepEqual((await api.databaseCatalog()).tables,catalog.tables);
  checks.push('Project SQL plans reject changed buffers, external disk changes, changed file sets and catalog epochs; unsupported migration statements remain explicit partial coverage and block a complete source rename.');
  fs.writeFileSync(path.resolve(__dirname,'../test-output/'+(process.env.ROCKETBRAIN_TEST_REPORT_PREFIX||"v0.10")+'-native-sql-project-'+runtime.dbEngine+'.json'),JSON.stringify({asOf:new Date().toISOString(),version:'0.10.0',engine:runtime.dbEngine,files:4,nativeReferences:6,referenceFiles:3,tableRenameEdits:5,columnRenameEdits:6,nativeReferencesProvider:true,reviewableMultiFileWorkspaceEdit:true,nativeUndo:true,explicitAliasesPreserved:true,implicitOutputsPropagated:true,literalsCommentsPreserved:true,sourceVersionGuard:true,externalDiskGuard:true,workspaceFileSetGuard:true,catalogEpochGuard:true,unsupportedMigrationCoverageExplicit:true,incompleteSourcePlanRefused:true,schemaUnchanged:true,scope:'Selected local SQL query roots; supported SELECT/WITH statements only. DDL application and source edits are separately reviewed and not atomic.'},null,2)+'\n');
 }finally{
  await configuration.update('roots',previous,vscode.ConfigurationTarget.Global);
  for(const [name,source]of Object.entries(sources))fs.writeFileSync(path.join(folder,name),source);
  for(const doc of vscode.workspace.textDocuments){if(doc.uri.scheme!=='file'||path.dirname(doc.uri.fsPath)!==folder||!doc.isDirty||!fs.existsSync(doc.uri.fsPath))continue;await vscode.window.showTextDocument(doc);await vscode.commands.executeCommand('workbench.action.files.revert');}
  if(connected)await vscode.commands.executeCommand('rocketbrain.useDemo');
  const marker=JSON.parse(fs.readFileSync(path.join(folder,'owner.json'),'utf8'));assert.equal(marker.id,owner);assert.equal(path.dirname(path.resolve(folder)),fixtureRoot);assert.ok(path.basename(folder).startsWith('sql-project-v10-'));fs.rmSync(folder,{recursive:true,force:true});
 }
}
module.exports={runSqlProjectChecks};
