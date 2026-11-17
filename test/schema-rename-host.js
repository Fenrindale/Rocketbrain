'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const quote=name=>'`'+name.replaceAll('`','``')+'`';
async function runSchemaRenameChecks(api,vscode,checks){
 const runtime=JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG,'utf8')),config=JSON.parse(fs.readFileSync(runtime.dbConfigPath,'utf8'));
 const actor=await require('mysql2/promise').createConnection(config),suffix=crypto.randomBytes(4).toString('hex'),table='rb_schema_native_'+suffix,renamed=table+'_new';
 const directory=path.resolve(__dirname,'fixtures','sql-schema-v010-'+suffix);fs.mkdirSync(directory);const files=[path.join(directory,'one.sql'),path.join(directory,'two.sql')],documents=[];const reports=[];
 try{
  await actor.query('CREATE TABLE '+quote(table)+' (id INT PRIMARY KEY,label VARCHAR(40) NOT NULL DEFAULT \'default\') ENGINE=InnoDB');await actor.query('INSERT INTO '+quote(table)+' VALUES (1,\'Alpha\'),(2,\'Beta\')');
  fs.writeFileSync(files[0],'SELECT p.id,p.label AS visible_name FROM '+quote(table)+' p ORDER BY p.id;\n-- '+table+' is literal documentation\n');
  fs.writeFileSync(files[1],'WITH wanted(key_id,person_name) AS (SELECT id,label FROM '+quote(config.database)+'.'+quote(table)+') SELECT key_id,person_name FROM wanted ORDER BY key_id;\n');
  for(const file of files)documents.push(await vscode.workspace.openTextDocument(vscode.Uri.file(file)));
  const before=[];for(const document of documents)before.push((await actor.query(document.getText()))[0]);
  await api.connectMysql({...config,readOnly:true});const scope={roots:[directory]};
  for(const change of [{kind:'table',table,newName:renamed},{kind:'column',table:renamed,column:'label',newName:'display_name'}]){
   const plan=await api.schemaRename.preview(change,{scope});assert.ok(plan.sourcePlanId,plan.sourceError);assert.equal(plan.references.coverage.complete,true);assert.equal(plan.ddl.implicitCommit,true);assert.equal(plan.ddl.transactionalRollback,false);assert.ok(plan.sourcePreviews.length>=1);
   let unacknowledgedRejected=false;if(plan.ddl.requiresUnverifiedDependencyApproval){await assert.rejects(api.schemaRename.apply(plan.id,{updateSql:true}),/acknowledge/);unacknowledgedRejected=true;}
   const result=await api.schemaRename.apply(plan.id,{updateSql:true,allowUnverifiedDependencies:plan.ddl.requiresUnverifiedDependencyApproval===true});assert.equal(result.state,'applied',JSON.stringify(result));assert.equal(result.verified,true);assert.equal(result.sourceState,'applied',JSON.stringify(result));assert.equal(result.atomicAcrossDatabaseAndFiles,false);
   for(let index=0;index<documents.length;index++){assert.deepEqual((await actor.query(documents[index].getText()))[0],before[index]);assert.equal(await documents[index].save(),true);}
   reports.push({kind:change.kind,sql:plan.ddl.sql,verified:result.verified,sourceState:result.sourceState,references:plan.references.references.length,unverifiedDependenciesAcknowledged:result.unverifiedDependenciesAccepted||false,unacknowledgedRejected});
  }
  assert.ok(documents[0].getText().includes('-- '+table+' is literal documentation'),'Comments remain untouched');assert.ok(documents[0].getText().includes('display_name'));assert.ok(documents[0].getText().includes(renamed));
  const stale=await api.schemaRename.preview({kind:'table',table:renamed,newName:renamed+'_stale'},{scope});const edit=new vscode.WorkspaceEdit();edit.insert(documents[0].uri,documents[0].positionAt(0),'-- changed after preview\n');await vscode.workspace.applyEdit(edit);
  await assert.rejects(api.schemaRename.apply(stale.id,{updateSql:true,allowUnverifiedDependencies:true}),/changed/);assert.equal((await actor.query('SELECT COUNT(*) AS n FROM '+quote(renamed)))[0][0].n,2);
  checks.push('Physical table and column Rename apply one reviewed DDL on an isolated connection, verify server metadata and update exact SQL references across two files while preserving query results and comments.');
  checks.push('Schema rename exposes implicit commit and non-atomic source changes, requires explicit acknowledgment of hidden stored dependencies and refuses source edits changed after preview before submitting DDL.');
  const isolation=await(await fetch(runtime.baseUrl+'/probe/testing-state')).json();assert.deepEqual(isolation,{people:2,departments:1,rolledBackNames:0});
  fs.writeFileSync(path.resolve(__dirname,'../test-output/'+(process.env.ROCKETBRAIN_TEST_REPORT_PREFIX||"v0.10")+'-native-schema-rename-'+runtime.dbEngine+'.json'),JSON.stringify({asOf:new Date().toISOString(),engine:runtime.dbEngine,reports,staleSourceRejected:true,isolation,scope:'Fresh owned tables in the actual Spring database; SQL roots explicitly limited to the two owned SELECT query files.'},null,2)+'\n');
 }finally{
  for(const document of documents){if(document.isDirty)await document.save();}
  for(const name of [table,renamed,renamed+'_stale'])await actor.query('DROP TABLE IF EXISTS '+quote(name));await actor.end();
  // These paths were created in this invocation and are validated inside its fixture directory.
  const root=path.resolve(__dirname,'fixtures');assert.equal(path.dirname(directory),root);fs.rmSync(directory,{recursive:true,force:true});
 }
}
module.exports={runSchemaRenameChecks};
