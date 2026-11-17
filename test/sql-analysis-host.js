'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
async function runSqlAnalysisChecks(api,vscode,checks){
  const runtime=JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG,'utf8'));
  await api.connectMysql(JSON.parse(fs.readFileSync(runtime.dbConfigPath,'utf8')));
  try{
    const catalog=await api.databaseCatalog();
    const observer=await fetch(runtime.baseUrl+'/probe/metamodel');assert.equal(observer.status,200);
    // The standard native configuration uses the actual source table names.
    // Opaque naming has separate provider and raw-SQL runtime matrix evidence.
    const people=catalog.tables.find(t=>t.name==='rb_spring_person');assert.ok(people,'Use standard naming for this native SQL editor check.');
    const text='WITH chosen AS (SELECT p.id AS person_id, p.display_name AS person_name FROM rb_spring_person p)\nSELECT c.person_name FROM chosen c WHERE EXISTS (SELECT 1 FROM rb_spring_person p WHERE p.id=c.person_id) ORDER BY c.person_name;';
    const document=await vscode.workspace.openTextDocument({language:'sql',content:text});await vscode.window.showTextDocument(document);
    const report=await vscode.commands.executeCommand('rocketbrain.sql.analyze');assert.equal(report.state,'known',JSON.stringify(report.statements.map(s=>s.model.coverage)));assert.equal(report.executedSql,false);assert.equal(report.statements[0].model.projections[0].type.family,'string');
    const position=document.positionAt(text.indexOf('c.person_name')+3),defs=await vscode.commands.executeCommand('vscode.executeDefinitionProvider',document.uri,position);assert.ok(defs.some(d=>(d.uri||d.targetUri)?.toString()===document.uri.toString()));
    const hovers=await vscode.commands.executeCommand('vscode.executeHoverProvider',document.uri,position);assert.ok(hovers.some(h=>(h.contents||[]).some(x=>String(x.value||x).replace(/\\/g,'').includes('person_name'))));
    const completions=await vscode.commands.executeCommand('vscode.executeCompletionItemProvider',document.uri,document.positionAt(text.indexOf('c.person_name')+2));assert.ok(completions.items.some(i=>(typeof i.label==='string'?i.label:i.label.label)==='person_name'));
    checks.push('Native SQL completion, hover and local definition navigation resolve a CTE output through a correlated subquery using the actual connected database catalog.');
    const start=text.indexOf('c.person_name')+2,edit=new vscode.WorkspaceEdit();edit.replace(document.uri,new vscode.Range(document.positionAt(start),document.positionAt(start+'person_name'.length)),'missing_editor_column');await vscode.workspace.applyEdit(edit);
    const changed=api.sqlAnalysis.analyzeDocument(document);assert.equal(changed.state,'invalid');assert.ok(vscode.languages.getDiagnostics(document.uri).some(d=>d.source==='Rocketbrain SQL (source model)'&&d.code==='sql.name.column'));
    checks.push('An unsaved invalid CTE column produces a native SQL source diagnostic without executing the editor query; analysis remains separate from server execution.');
    await vscode.commands.executeCommand('rocketbrain.useDemo');assert.equal(api.sqlAnalysis.snapshot(),null);assert.equal(vscode.languages.getDiagnostics(document.uri).filter(d=>d.source==='Rocketbrain SQL (source model)').length,0);
    checks.push('Switching the database clears SQL semantic metadata and stale editor diagnostics instead of applying the previous connection catalog.');
    fs.writeFileSync(path.resolve(__dirname,'../test-output/'+(process.env.ROCKETBRAIN_TEST_REPORT_PREFIX||"v0.8")+'-native-sql-'+runtime.dbEngine+'.json'),JSON.stringify({asOf:new Date().toISOString(),engine:runtime.dbEngine,statements:report.statements.map(s=>({state:s.model.state,projections:s.model.projections,coverage:s.model.coverage})),executedSql:false,unsavedDiagnostic:true,connectionInvalidation:true},null,2)+'\n');
  }finally{await vscode.commands.executeCommand('rocketbrain.useDemo');}
}
module.exports={runSqlAnalysisChecks};
