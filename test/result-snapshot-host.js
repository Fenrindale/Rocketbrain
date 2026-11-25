'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const {createHash}=require('node:crypto');
const path=require('node:path');
const {jdbcReadback}=require('./java-source-analysis-host');

const title='Owned query result before restart';
const expectedJdbc={people:2,departments:1,rolledBackNames:0};
const sql="SELECT CAST('9007199254740993' AS UNSIGNED) AS exact_int, CAST('15.12000000' AS DECIMAL(30,8)) AS exact_decimal, " +
  "UNHEX('61FF') AS binary_value, NULL AS absent, '결과' AS label;";
const digest=result=>createHash('sha256').update(JSON.stringify([result.columns,result.rows])).digest('hex');

async function runtime() {
  const fixture=JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG,'utf8'));
  const config=JSON.parse(await fs.readFile(fixture.dbConfigPath,'utf8'));
  const owner=JSON.parse(await fs.readFile(path.join(path.dirname(fixture.dbConfigPath),'owner.json'),'utf8'));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1','RocketbrainDisposableOracleMysqlFixture-v1'].includes(owner.kind));
  assert.equal(config.host,'127.0.0.1');
  assert.equal(config.database,'rocketbrain_fixture');
  assert.deepEqual(await jdbcReadback(),expectedJdbc);
  return {fixture,config};
}

async function seedResultSnapshot(api,vscode,receipt) {
  const {fixture,config}=await runtime();
  await api.connectMysql(config);
  try{
    const document=await vscode.workspace.openTextDocument({language:'sql',content:sql});
    const editor=await vscode.window.showTextDocument(document,{preview:false});
    editor.selection=new vscode.Selection(document.positionAt(0),document.positionAt(sql.length));
    const id=await vscode.commands.executeCommand('rocketbrain.runQuery');
    const record=api.results().find(item=>item.id===id);
    assert.equal(record?.state,'done',record?.error);
    const [row]=record.result.rows;
    assert.deepEqual(row.slice(0,2),['9007199254740993','15.12000000']);
    assert.match(row[2],/61ff/i);
    assert.deepEqual(row.slice(3),[null,'결과']);
    const candidate=api.resultSnapshots.candidates().find(item=>item.id===id);
    assert.ok(candidate);
    assert.throws(()=>api.resultSnapshots.save(id,title,candidate.revision+1),/current read-only result/);
    const saved=await api.resultSnapshots.save(id,title,candidate.revision);
    assert.deepEqual([saved.rows,saved.columns,saved.truncated],[1,5,false]);
    await fs.writeFile(receipt,JSON.stringify({id:saved.id,engine:fixture.dbEngine,hostPid:process.pid,resultHash:digest(record.result)}),{flag:'wx'});
  }finally{await api.disconnectMysql();}
}

async function runResultSnapshotChecks(api,vscode,checks,receipt) {
  const {fixture}=await runtime();
  const saved=JSON.parse(await fs.readFile(receipt,'utf8'));
  assert.equal(saved.engine,fixture.dbEngine);
  assert.notEqual(saved.hostPid,process.pid);
  assert.deepEqual(api.sessions(),[]);
  assert.deepEqual(api.results(),[]);
  assert.equal(api.resultSnapshots.list().find(value=>value.id===saved.id)?.title,title);
  const commands=await vscode.commands.getCommands(true);
  for(const action of ['saveSnapshot','openSnapshot','removeSnapshot'])assert.ok(commands.includes('rocketbrain.results.'+action));
  const opened=await api.resultSnapshots.open(saved.id);
  assert.equal(opened.executedSql,false);
  const record=api.results().find(value=>value.id===opened.recordId);
  assert.equal(record.readOnly,true);
  assert.equal(record.sessionId,undefined);
  assert.equal(record.sql,'');
  assert.equal(record.result.offlineCapture,true);
  assert.equal(digest(record.result),saved.resultHash);
  assert.equal(record.result.fields[2].characterSet,63);
  assert.equal(record.result.edit,undefined);
  assert.equal(record.result.relatedRows,undefined);
  assert.equal(api.resultSnapshots.candidates().some(value=>value.id===opened.recordId),false);
  await api.resultSnapshots.remove(saved.id);
  await assert.rejects(api.resultSnapshots.open(saved.id),/unavailable/);
  assert.deepEqual(api.sessions(),[]);
  const jdbc=await jdbcReadback();
  assert.deepEqual(jdbc,expectedJdbc);
  checks.push('A different VS Code process opened the explicitly saved grid with exact BIGINT, DECIMAL, binary, Unicode and NULL while disconnected.');
  checks.push('The restored grid has no SQL source, session or writable row model. The saved record can be removed independently.');
  return {engine:fixture.dbEngine,separateHostPid:true,restoredGrid:true,typedValues:true,readonlyOffline:true,
    noQueryReplay:true,removedSnapshotRefused:true,jdbc};
}

module.exports={seedResultSnapshot,runResultSnapshotChecks};
