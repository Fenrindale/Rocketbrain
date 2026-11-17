'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
async function runSqlRenameChecks(api,vscode,checks){
  const runtime=JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG,'utf8'));
  await api.connectMysql(JSON.parse(fs.readFileSync(runtime.dbConfigPath,'utf8')));
  try{
    const catalog=await api.databaseCatalog();assert.ok(catalog.tables.some(t=>t.name==='rb_spring_person'),'Use standard naming for native SQL Rename checks.');
    const source="SELECT p.id FROM rb_spring_person p;\nWITH chosen AS (SELECT p.id AS person_id,p.display_name AS person_name FROM rb_spring_person p)\nSELECT c.person_name FROM chosen c WHERE c.person_name<>'person_name' /* person_name stays */ ORDER BY c.person_id;";
    const document=await vscode.workspace.openTextDocument({language:'sql',content:source});await vscode.window.showTextDocument(document);
    await api.sqlAnalysis.refreshMetadata();assert.equal(api.sqlAnalysis.analyzeDocument(document).state,'known');
    const position=document.positionAt(source.indexOf('c.person_name')+3),prepared=api.sqlAnalysis.prepareRename(document,position);assert.equal(prepared.placeholder,'person_name');assert.equal(document.getText(prepared.range),'person_name');
    const edit=await vscode.commands.executeCommand('vscode.executeDocumentRenameProvider',document.uri,position,'from');assert.ok(edit instanceof vscode.WorkspaceEdit);assert.equal(edit.size,1);assert.equal(document.getText(),source,'provider returns reviewable edits without applying them');
    const changed=source.replace('AS person_name','AS `from`').replaceAll('c.person_name','c.`from`');assert.equal(await vscode.workspace.applyEdit(edit),true);assert.equal(document.getText(),changed);assert.equal(api.sqlAnalysis.analyzeDocument(document).state,'known');
    const newPosition=document.positionAt(changed.indexOf('c.`from`')+4),definitions=await vscode.commands.executeCommand('vscode.executeDefinitionProvider',document.uri,newPosition);assert.ok(definitions.some(value=>(value.uri||value.targetUri)?.toString()===document.uri.toString()));
    await vscode.commands.executeCommand('undo');assert.equal(document.getText(),source,'the native edit participates in VS Code Undo');
    checks.push('Native SQL Rename returns a reviewable WorkspaceEdit for a CTE output, updates all semantic references, preserves the other statement/comments/literals, keeps definition navigation valid and supports Undo.');
    api.sqlAnalysis.prepareRename(document,position);await api.sqlAnalysis.refreshMetadata();await assert.rejects(()=>api.sqlAnalysis.renameDocument(document,position,'renamed'),/connection changed after preparation/);
    api.sqlAnalysis.prepareRename(document,position);const append=new vscode.WorkspaceEdit();append.insert(document.uri,document.positionAt(document.getText().length),' ');await vscode.workspace.applyEdit(append);await assert.rejects(()=>api.sqlAnalysis.renameDocument(document,position,'renamed'),/changed after preparation/);await vscode.commands.executeCommand('undo');assert.equal(document.getText(),source);
    const aliasPosition=document.positionAt(source.indexOf('p.id'));api.sqlAnalysis.prepareRename(document,aliasPosition);const relationEdit=await api.sqlAnalysis.renameDocument(document,aliasPosition,'person_source');assert.equal(relationEdit.get(document.uri).length,2,'only first statement alias and its reference are edited');
    assert.throws(()=>api.sqlAnalysis.prepareRename(document,document.positionAt(source.indexOf('p.id')+2)),/separate schema migration/);
    assert.deepEqual((await api.databaseCatalog()).tables,catalog.tables);
    checks.push('Prepared SQL Rename rejects stale document/catalog snapshots and physical catalog objects, applies no database DDL, and keeps edits within the selected statement.');
    fs.writeFileSync(path.resolve(__dirname,'../test-output/'+(process.env.ROCKETBRAIN_TEST_REPORT_PREFIX||"v0.9")+'-native-sql-rename-'+runtime.dbEngine+'.json'),JSON.stringify({asOf:new Date().toISOString(),engine:runtime.dbEngine,nativeProvider:true,reviewableWorkspaceEdit:true,allLocalReferences:true,unrelatedStatementPreserved:true,literalsCommentsPreserved:true,nativeDefinitionAfterRename:true,undo:true,documentVersionGuard:true,catalogEpochGuard:true,catalogUnchanged:true,schemaMutation:false,scope:'statement-local'},null,2)+'\n');
  }finally{await vscode.commands.executeCommand('rocketbrain.useDemo');}
}
module.exports={runSqlRenameChecks};
