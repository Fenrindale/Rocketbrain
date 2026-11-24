'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const mysql=require('mysql2/promise');

async function runVirtualDdlChecks(api,vscode,checks){
  const runtime=JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG,'utf8'));
  const config=JSON.parse(await fs.readFile(runtime.dbConfigPath,'utf8'));
  assert.equal(config.host,'127.0.0.1');
  const tools=api.sqlAnalysis;
  const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'rocketbrain-virtual-ddl-'));
  const file=path.join(temporary,'model.sql');
  const jdbc={people:2,departments:1,rolledBackNames:0};
  const open=text=>vscode.workspace.openTextDocument({language:'sql',content:text});
  const commands=await vscode.commands.getCommands(true);
  assert.ok(commands.includes('rocketbrain.sql.previewDdl'));
  assert.ok(commands.includes('rocketbrain.sql.clearDdlPreview'));
  const connection=await mysql.createConnection(config);
  try{
    await api.disconnectMysql();
    await fs.writeFile(file,'CREATE TABLE imported (id BIGINT NOT NULL, title VARCHAR(32), PRIMARY KEY (id)); CREATE VIEW names AS SELECT id, title FROM imported;','utf8');
    const offline=await open('SELECT n.title FROM names n;');
    const preview=await tools.useDdlPreview(offline,{file:vscode.Uri.file(file),database:'offline_fixture',dialect:runtime.dbEngine});
    assert.equal(preview.state,'known');
    assert.equal(preview.catalogVisibility,'local-ddl');
    assert.equal(preview.statements[0].model.projections[0].type.dbType.toLowerCase(),'varchar(32)');
    const completions=await vscode.commands.executeCommand('vscode.executeCompletionItemProvider',offline.uri,
      offline.positionAt(offline.getText().indexOf('n.title')+3));
    assert.ok(completions.items.some(item=>String(item.label.label||item.label)==='title'));
    assert.equal(tools.clearDdlPreview(offline),true);
    assert.equal(tools.analyzeDocument(offline).state,'not-connected');

    await api.connectMysql(config);
    const script=await open([
      'ALTER TABLE rb_spring_person ADD COLUMN rb_preview_amount DECIMAL(20,6) NOT NULL;',
      'CREATE VIEW rb_proposed_view AS SELECT p.rb_preview_amount AS amount FROM rb_spring_person p;',
      'SELECT v.amount FROM rb_proposed_view v;',
      'DROP VIEW rb_proposed_view;',
      'ALTER TABLE rb_spring_person RENAME COLUMN rb_preview_amount TO rb_preview_cost;',
      'SELECT p.rb_preview_cost FROM rb_spring_person p;'
    ].join('\n'));
    const report=await tools.useDdlPreview(script);
    assert.equal(report.state,'known',JSON.stringify(report.unknown));
    const changes=report.ddlChanges.map(item=>item.action);
    assert.deepEqual(changes,['alter','create','drop','alter']);
    assert.equal(report.statements[2].model.projections[0].type.dbType.toLowerCase(),'decimal(20,6)');
    assert.equal(report.statements.at(-1).model.projections[0].type.dbType.toLowerCase(),'decimal(20,6)');
    const cursor=script.positionAt(script.getText().lastIndexOf('rb_preview_cost'));
    assert.throws(()=>tools.prepareRename(script,cursor),/virtual DDL preview/i);
    assert.equal(tools.catalogTargetAt(script,cursor),null);
    const [columns]=await connection.execute(
      "SELECT column_name FROM information_schema.columns WHERE table_schema=DATABASE() AND column_name LIKE 'rb_preview_%'");
    const [views]=await connection.execute(
      "SELECT table_name FROM information_schema.views WHERE table_schema=DATABASE() AND table_name='rb_proposed_view'");
    assert.deepEqual(columns,[]);
    assert.deepEqual(views,[]);
    const response=await fetch(runtime.baseUrl+'/probe/testing-state',{signal:AbortSignal.timeout(10000)});
    assert.equal(response.ok,true);
    assert.deepEqual(await response.json(),jdbc);
    checks.push('Native SQL completion used a disconnected DDL snapshot. A second document projected typed columns through ALTER, CREATE VIEW, DROP VIEW and RENAME against the real catalog. Physical rename refused the preview, the database catalog was unchanged, and JDBC readback passed.');
    return {offlineColumns:true,nativeCompletion:true,changes,physicalRenameRefused:true,unchangedPhysicalCatalog:true,jdbc};
  }finally{
    await Promise.allSettled([connection.end(),api.disconnectMysql()]);
    await fs.unlink(file).catch(error=>{if(error.code!=='ENOENT')throw error;});
    await fs.rmdir(temporary);
  }
}

module.exports={runVirtualDdlChecks};
