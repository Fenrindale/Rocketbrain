'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const quote=name=>'`'+name.replaceAll('`','``')+'`';
async function runSqlScriptChecks(api,vscode,checks){
 const runtime=JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG,'utf8')),config=JSON.parse(fs.readFileSync(runtime.dbConfigPath,'utf8'));
 const marker=JSON.parse(fs.readFileSync(path.join(path.dirname(runtime.dbConfigPath),'owner.json'),'utf8'));assert.ok(['RocketbrainDisposableMariaDbFixture-v1','RocketbrainDisposableOracleMysqlFixture-v1'].includes(marker.kind));
 const actor=await require('mysql2/promise').createConnection(config),suffix=crypto.randomBytes(5).toString('hex'),table='rb_script_native_'+suffix,ddlTable=table+'_ddl';let sessionId;
 const document=await vscode.workspace.openTextDocument({language:'sql',content:'SELECT :text AS echoed,:amount AS exact_value; SELECT :text AS repeated,:nil IS NULL AS null_value;'});await vscode.window.showTextDocument(document);
 const replace=async text=>{const edit=new vscode.WorkspaceEdit();edit.replace(document.uri,new vscode.Range(document.positionAt(0),document.positionAt(document.getText().length)),text);assert.equal(await vscode.workspace.applyEdit(edit),true);};
 const reports=[];
 try{
  await actor.query('CREATE TABLE '+quote(table)+' (id INT PRIMARY KEY,label VARCHAR(100)) ENGINE=InnoDB');await api.connectMysql(config);
  const described=await api.sqlScripts.describe(document);sessionId=described.sessionId;assert.equal(described.parameterStyle,'named');assert.equal(described.parameterDefinitions.find(p=>p.name==='text').occurrences,2);
  const literal='literal; DROP TABLE '+table+'; --',exact='9007199254740993.25',parameters={text:{kind:'text',value:literal},amount:{kind:'decimal',value:exact},nil:{kind:'null'}};
  const preview=await api.sqlScripts.preview(described.id,parameters);assert.equal(JSON.stringify(preview).includes(literal),false);const result=await api.sqlScripts.run(preview.id);assert.equal(result.state,'completed');assert.equal(result.completed,2);assert.equal(result.statements[0].result.rows[0][0],literal);assert.equal(String(result.statements[0].result.rows[0][1]),exact);assert.equal(Number(result.statements[1].result.rows[0][1]),1);
  const countBefore=Number((await actor.query('SELECT COUNT(*) AS n FROM '+quote(table)))[0][0].n);assert.equal(countBefore,0);const opened=await api.sqlScripts.openStatement(result.resultId,0);assert.equal(opened.executedSql,false);
  reports.push({kind:'prepared-read',statements:result.completed,repeatedParameter:true,exactDecimal:true,sqlNull:true,literalNotExecuted:true,reviewContainsParameterValues:false,cachedResultRerunsSql:false});
  checks.push('SQL scripts bind repeated named text, exact decimal and SQL NULL parameters through prepared values; SQL-looking text stays literal, parameters are absent from the public review and cached statement results open without rerunning SQL.');
  await api.configureConsoleSession(sessionId,{readOnly:false,autocommit:false});
  await replace('INSERT INTO '+quote(table)+' VALUES (1,:label); SELECT label FROM '+quote(table)+' WHERE id=1; SELECT missing_column FROM '+quote(table)+'; INSERT INTO '+quote(table)+' VALUES (2,:label);');
  const writeDescription=await api.sqlScripts.describe(document),writePreview=await api.sqlScripts.preview(writeDescription.id,{label:{kind:'text',value:'private pending row'}}),write=await api.sqlScripts.run(writePreview.id);
  assert.equal(write.state,'failed');assert.equal(write.completed,2);assert.equal(write.failed,1);assert.equal(write.notRun,1);assert.equal(write.autoRetried,false);assert.equal(write.stateAfter.inTransaction,true);assert.equal(Number((await actor.query('SELECT COUNT(*) AS n FROM '+quote(table)))[0][0].n),0);await api.controlConsoleSession(sessionId,'rollback');assert.equal(Number((await actor.query('SELECT COUNT(*) AS n FROM '+quote(table)))[0][0].n),0);
  reports.push({kind:'stop-on-error',completed:write.completed,failed:write.failed,notRun:write.notRun,autoRetried:write.autoRetried,manualTransactionPreserved:true,rollbackVerified:true});
  checks.push('A write script stops at the first server error, leaves later statements unrun, reports earlier successes without retrying and preserves the manual transaction for an explicit rollback.');
  await replace('CREATE TABLE '+quote(ddlTable)+' (id INT PRIMARY KEY) ENGINE=InnoDB; INSERT INTO '+quote(ddlTable)+' VALUES (1);');
  const ddlDescription=await api.sqlScripts.describe(document),ddlPreview=await api.sqlScripts.preview(ddlDescription.id,[]);assert.equal(ddlPreview.requiresImplicitCommitApproval,true);await assert.rejects(api.sqlScripts.run(ddlPreview.id),/acknowledge/);
  const ddl=await api.sqlScripts.run(ddlPreview.id,{allowImplicitCommit:true});assert.equal(ddl.state,'completed');assert.equal(ddl.atomic,false);await api.controlConsoleSession(sessionId,'rollback');assert.equal(Number((await actor.query('SELECT COUNT(*) AS n FROM '+quote(ddlTable)))[0][0].n),0);
  const staleDescription=await api.sqlScripts.describe(document);await replace(document.getText()+'\n-- changed');await assert.rejects(api.sqlScripts.preview(staleDescription.id,[]),/changed/);
  reports.push({kind:'DDL',explicitApprovalRequired:true,atomic:false,tableSurvivedRollback:true,insertRolledBack:true,staleSourceRejected:true});
  checks.push('Schema scripts require explicit implicit-commit approval, demonstrate that DDL survives a later rollback and reject source text changed after preparation.');
  const isolation=await(await fetch(runtime.baseUrl+'/probe/testing-state')).json();assert.deepEqual(isolation,{people:2,departments:1,rolledBackNames:0});fs.writeFileSync(path.resolve(__dirname,'../test-output/'+(process.env.ROCKETBRAIN_TEST_REPORT_PREFIX||'v0.11')+'-native-sql-script-'+runtime.dbEngine+'.json'),JSON.stringify({asOf:new Date().toISOString(),version:process.env.ROCKETBRAIN_RELEASE_VERSION||'0.11.0',engine:runtime.dbEngine,reports,isolation,scope:'Owned fresh tables, actual managed script backend and native result history; typed parameter UI uses the same preview/run path.'},null,2)+'\n');
 }finally{
  if(sessionId)await api.closeConsoleSession(sessionId);await vscode.commands.executeCommand('rocketbrain.useDemo');for(const name of [table,ddlTable])await actor.query('DROP TABLE IF EXISTS '+quote(name));await actor.end();
 }
}
async function runDelimiterScriptChecks(api,vscode,checks) {
 const runtime=JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG,'utf8'));
 const config=JSON.parse(fs.readFileSync(runtime.dbConfigPath,'utf8'));
 const owner=JSON.parse(fs.readFileSync(path.join(path.dirname(runtime.dbConfigPath),'owner.json'),'utf8'));
 assert.ok(['RocketbrainDisposableMariaDbFixture-v1','RocketbrainDisposableOracleMysqlFixture-v1'].includes(owner.kind));
 assert.equal(config.host,'127.0.0.1');
 assert.equal(config.database,'rocketbrain_fixture');
 const actor=await require('mysql2/promise').createConnection(config);
 const name='rb_script_program_'+crypto.randomBytes(5).toString('hex');
 const proc=quote(name+'_proc'),trigger=quote(name+'_trigger'),table=quote(name);
 const workspace=vscode.workspace.workspaceFolders[0].uri.fsPath;
 assert.equal(path.resolve(workspace),path.resolve(process.env.ROCKETBRAIN_JAVA_TEST_WORKSPACE));
 const sourcePath=path.join(workspace,name+'.sql');
 const sql=[
  'DELIMITER $$',
  'CREATE PROCEDURE '+proc+"(IN n INT) BEGIN IF n > 0 THEN SELECT 'marker $$', n; ELSE SELECT 0; END IF; END$$",
  'DELIMITER //',
  'CREATE TRIGGER '+trigger+' BEFORE INSERT ON '+table+" FOR EACH ROW BEGIN SET NEW.label=CONCAT(NEW.label,'//ok'); END//",
  'DELIMITER ;', 'INSERT INTO '+table+' VALUES(1,:label);', 'SELECT label FROM '+table+' WHERE id=1;'
 ].join('\n');
 let sessionId;
 try {
  await actor.query('CREATE TABLE '+table+' (id INT PRIMARY KEY,label VARCHAR(80)) ENGINE=InnoDB');
  await api.connectMysql(config);
  fs.writeFileSync(sourcePath,'SELECT 1;', {flag:'wx'});
  const document=await vscode.workspace.openTextDocument(vscode.Uri.file(sourcePath));
  await vscode.window.showTextDocument(document);
  sessionId=(await api.sqlScripts.describe(document)).sessionId;
  await api.configureConsoleSession(sessionId,{readOnly:false});
  const edit=new vscode.WorkspaceEdit();
  edit.replace(document.uri,new vscode.Range(document.positionAt(0),document.positionAt(document.getText().length)),sql);
  assert.equal(await vscode.workspace.applyEdit(edit),true);
  assert.equal(await document.save(),true);
  const description=await api.sqlScripts.describe(document);
  assert.deepEqual(description.statements.slice(0,2).map(statement=>statement.program),['PROCEDURE','TRIGGER']);
  assert.equal(description.statementCount,4);
  const preview=await api.sqlScripts.preview(description.id,{label:{kind:'text',value:'native'}});
  assert.equal(preview.requiresImplicitCommitApproval,true);
  await assert.rejects(api.sqlScripts.run(preview.id),/acknowledge/);
  const result=await api.sqlScripts.run(preview.id,{allowImplicitCommit:true});
  assert.equal(result.state,'completed',JSON.stringify(result));
  assert.deepEqual(result.statements[3].result.rows,[['native//ok']]);
  const [[rows]]=await actor.query('CALL '+proc+'(7)');
  assert.deepEqual(Object.values(rows[0]).map(String),['marker $$','7']);
  const statement=await api.sqlScripts.openStatement(result.resultId,3);
  assert.equal(statement.executedSql,false);
  checks.push('The installed SQL editor reviewed compound DDL, approved its commit behavior and ran four exact boundaries with a bound value and actual trigger result.');
  return {engine:runtime.dbEngine,statements:4,nativeReview:true,liveProcedure:true,liveTrigger:true,
   boundAfterDelimiterReset:true,cachedResultNoReplay:true,ddlApproval:true};
 }finally {
  try { if(sessionId)await api.closeConsoleSession(sessionId); await api.disconnectMysql(); }
  finally {
   try { await actor.query('DROP TRIGGER IF EXISTS '+trigger); await actor.query('DROP PROCEDURE IF EXISTS '+proc); await actor.query('DROP TABLE IF EXISTS '+table); }
   finally { try { await actor.end(); } finally { fs.rmSync(sourcePath,{force:true}); } }
  }
 }
}
module.exports={runSqlScriptChecks,runDelimiterScriptChecks};
