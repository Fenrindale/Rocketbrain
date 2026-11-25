'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const mysql = require('mysql2/promise');
const { jdbcReadback } = require('./java-source-analysis-host');
const { until } = require('./helpers/stdio-lsp');

async function runDatasetSyncChecks(api, vscode, checks) {
  const read = async file => JSON.parse(await fs.readFile(file,'utf8'));
  const runtime = await read(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG);
  const config = await read(runtime.dbConfigPath);
  const owner = await read(path.join(path.dirname(runtime.dbConfigPath),'owner.json'));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1','RocketbrainDisposableOracleMysqlFixture-v1'].includes(owner.kind));
  assert.equal(config.host,'127.0.0.1');
  assert.equal(config.database,'rocketbrain_fixture');
  const actor = await mysql.createConnection({ ...config,rowsAsArray:true,supportBigNumbers:true,bigNumberStrings:true });
  const suffix = randomBytes(5).toString('hex'), target = 'rb_sync_dst_'+suffix, source = 'rb_sync_src_'+suffix;
  const baseline = { people:2,departments:1,rolledBackNames:0 };
  const targetRows = [['9007199254740993','12.00000000','old'],['9007199254740994',null,'remove'],['9007199254740995','8.10000000','same']];
  const originRows = [['9007199254740993','12.00000001',null],['9007199254740995','8.10000000','same'],['9007199254740996','17.50000000','new']];
  const live = async table => (await actor.query(`SELECT id,amount,label FROM ${table} ORDER BY id`))[0];
  const mapping = [0,1,2].map(index=>({source:index,target:index,key:index===0}));
  const record = id => api.results().find(item=>item.id===id);
  let targetId;
  async function tableAction(type, patch = {}, refusal) {
    const current = record(targetId);
    await api.tableAction(targetId,{type,modelId:current.result.edit.modelId,draftRevision:current.draftRevision||0,...patch});
    if(refusal)assert.match(record(targetId).editError||'',refusal);
    else assert.equal(record(targetId).editError,undefined,record(targetId).editError);
  }
  async function table(name) {
    await vscode.commands.executeCommand('rocketbrain.openTable',name);
    const current=api.results().at(-1);
    assert.equal(current.result?.edit?.table,name,current.error);
    return current.id;
  }
  async function stage(comparison) {
    const current=record(targetId), rowIds=comparison.rows.filter(row=>row.canStage).map(row=>row.index);
    await api.stageDatasetComparison(targetId,{reviewId:comparison.reviewId,rows:rowIds,modelId:current.result.edit.modelId,
      draftRevision:current.draftRevision||0});
    const draft=await until(()=>record(targetId).hasDraft&&record(targetId).bulkDraft,8000);
    await tableAction('reviewChanges',{changes:{updates:draft.updates,deletes:draft.deletes,inserts:draft.inserts}});
    const review=record(targetId).review;
    assert.deepEqual(review.summary,{updates:1,deletes:1,inserts:1});
    assert.deepEqual(review.statements.map(statement=>statement.sql.split(' ')[0]),['UPDATE','DELETE','INSERT']);
    return review.reviewId;
  }
  try {
    await actor.query(`CREATE TABLE ${target} (id BIGINT UNSIGNED PRIMARY KEY, amount DECIMAL(32,8), label VARCHAR(30)) ENGINE=InnoDB`);
    await actor.query(`CREATE TABLE ${source} LIKE ${target}`);
    for(const [table,rows] of [[target,targetRows],[source,originRows]]) {
      await actor.execute(`INSERT INTO ${table} VALUES (?,?,?),(?,?,?),(?,?,?)`,rows.flat());
    }
    await api.connectMysql(config);
    assert.deepEqual(await jdbcReadback(),baseline);
    const sourceId=await table(source);
    targetId=await table(target);
    await tableAction('enableEdit');
    const query=await vscode.workspace.openTextDocument({language:'sql',content:`SELECT id,amount,label FROM ${source} WHERE id>9007199254740993;`});
    const editor=await vscode.window.showTextDocument(query,{preview:false});
    editor.selection=new vscode.Selection(query.positionAt(0),query.positionAt(query.getText().length));
    const limited=await vscode.commands.executeCommand('rocketbrain.runQuery');
    const filtered=api.compareDatasets(targetId,limited,mapping);
    assert.equal(filtered.oneSidedChanges,false);
    assert.ok(filtered.rows.every(item=>item.state==='changed'||!item.canStage));

    const compare=()=>api.compareDatasets(targetId,sourceId,mapping);
    const report=compare();
    assert.equal(report.oneSidedChanges,true);
    assert.deepEqual(report.summary,{equal:1,changed:1,targetOnly:1,sourceOnly:1});
    assert.deepEqual(report.rows.map(item=>item.operation),['update','delete','insert']);
    const first=await stage(report);
    assert.deepEqual(await live(target),targetRows);
    await actor.execute(`UPDATE ${target} SET label='changed outside' WHERE id=?`,[targetRows[1][0]]);
    await tableAction('applyChanges',{reviewId:first},/row changed|row.*deleted/i);
    assert.deepEqual(await live(target),[targetRows[0],[targetRows[1][0],null,'changed outside'],targetRows[2]]);
    await tableAction('rollbackChanges');
    const second=await stage(compare());
    await tableAction('applyChanges',{reviewId:second});
    assert.equal((await live(target)).length,3);
    assert.equal((await live(target))[1][2],'changed outside');
    await tableAction('commitChanges');
    assert.deepEqual(await live(target),originRows);
    assert.deepEqual(await live(source),originRows);
    assert.deepEqual(compare().summary,{equal:3,changed:0,targetOnly:0,sourceOnly:0});
    const jdbc=await jdbcReadback();
    assert.deepEqual(jdbc,baseline);
    checks.push('Two complete native table captures staged a verified update, delete and insert. A concurrent row change rolled back the set and a later explicit Commit synchronized the exact data.');
    return {engine:runtime.dbEngine,completeCaptures:true,membershipChanges:[1,1],matchedUpdate:true,
      filteredCaptureReadOnlyForMembership:true,preciseBigintDecimal:true,staleDestinationRolledBack:true,
      nativeDraftAndSqlReview:true,repeatedComparisonEqual:true,jdbc};
  } finally {
    try {
      for (const session of api.sessions()) await api.closeConsoleSession(session.id);
      await api.disconnectMysql();
    } finally {
      try { await actor.query('DROP TABLE IF EXISTS '+source+', '+target); }
      finally { await actor.end(); }
    }
  }
}

module.exports = { runDatasetSyncChecks };
