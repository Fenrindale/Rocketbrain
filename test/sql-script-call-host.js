'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomBytes}=require('node:crypto');
const mysql=require('mysql2/promise');
const {MysqlService}=require('../src/db/mysql');
const {jdbcReadback}=require('./java-source-analysis-host');

const inputValue='9007199254740993';
const args={key:{kind:'integer',value:inputValue}};
const exactRows=[[inputValue,'미등록 없음']];
const springState={people:2,departments:1,rolledBackNames:0};

async function withFixture(run){
  const runtime=JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG,'utf8'));
  const config=JSON.parse(await fs.readFile(runtime.dbConfigPath,'utf8'));
  const owned=JSON.parse(await fs.readFile(path.join(path.dirname(runtime.dbConfigPath),'owner.json'),'utf8'));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1','RocketbrainDisposableOracleMysqlFixture-v1'].includes(owned.kind));
  assert.equal(config.host,'127.0.0.1');
  assert.equal(config.database,'rocketbrain_fixture');
  const suffix=randomBytes(4).toString('hex');
  const table='rb_sc_table_'+suffix, procedure='rb_sc_proc_'+suffix, unsafe='rb_sc_unsafe_'+suffix;
  const actor=await mysql.createConnection(config);
  const create=label=>actor.query(`CREATE PROCEDURE ${procedure}(IN p_key BIGINT UNSIGNED) READS SQL DATA SQL SECURITY INVOKER BEGIN
    SELECT id,label FROM ${table} WHERE id=p_key;
    SELECT p_key AS echoed_key, '${label}' AS origin FROM ${table} WHERE id=p_key; END`);
  try{
    await actor.query(`CREATE TABLE ${table}(id BIGINT UNSIGNED PRIMARY KEY,label VARCHAR(80) NOT NULL) ENGINE=InnoDB`);
    await actor.execute(`INSERT INTO ${table} VALUES(?,?)`,exactRows[0]);
    await create('original');
    await actor.query(`CREATE PROCEDURE ${unsafe}() SQL SECURITY INVOKER BEGIN SET @rb_unsafe=1; SELECT 1; END`);
    const script=`SELECT CONNECTION_ID() AS original_session; CALL ${procedure}(:key); SELECT CONNECTION_ID() AS final_session;`;
    const change=async()=>{await actor.query(`DROP PROCEDURE ${procedure}`);await create('changed');};
    const jdbc=await jdbcReadback();
    assert.deepEqual(jdbc,springState);
    const [[{version}]]=await actor.query('SELECT VERSION() version');
    return await run({runtime,config,script,change,unsafe,jdbc,version});
  }finally{
    try{
      await actor.query(`DROP PROCEDURE IF EXISTS ${unsafe}`);
      await actor.query(`DROP PROCEDURE IF EXISTS ${procedure}`);
      await actor.query(`DROP TABLE IF EXISTS ${table}`);
    }finally{await actor.end();}
  }
}

function assertScript(result){
  assert.equal(result.state,'completed',JSON.stringify(result.statements.map(row=>row.error)));
  assert.equal(result.completed,3);
  assert.deepEqual(result.statements.map(row=>row.first),['SELECT','CALL','SELECT']);
  assert.deepEqual(result.statements[0].result.rows,result.statements[2].result.rows);
  const sets=result.statements[1].result.resultSets;
  assert.deepEqual(sets.map(set=>set.columns),[['id','label'],['echoed_key','origin']]);
  assert.deepEqual(sets[0].rows,exactRows);
  assert.deepEqual(sets[1].rows,[[inputValue,'original']]);
  assert.equal(result.stateAfter.inTransaction,false);
  assert.equal(result.stateAfter.readOnly,true);
}

async function verifyScriptCallBackend(){
  return withFixture(async({runtime,config,script,change,unsafe,jdbc,version})=>{
    const service=new MysqlService(config);
    try{
      await service.openSession('script-call',{readOnly:true});
      const preview=(parameters=args,sql=script)=>service.previewScript(sql,{sessionId:'script-call',parameters});
      await assert.rejects(preview({key:{kind:'text',value:inputValue}}),/input types/);
      await assert.rejects(preview([],`CALL ${unsafe}()`),/read-only|body made/);
      const draft=await preview();
      assert.equal(draft.statements[1].call.inputs,1);
      assert.equal(JSON.stringify(draft).includes(inputValue),false);
      assertScript(await service.runScript({reviewId:draft.reviewId}));
      const stale=await preview();
      await change();
      await assert.rejects(service.runScript({reviewId:stale.reviewId}),/changed after script review/);
      return {engine:runtime.dbEngine,version,jdbc,typedCall:true,sameSession:true,exactResultSets:2,
        changedDefinitionRefused:true,unsafeCallRefused:true};
    }finally{await service.dispose();}
  });
}

async function runScriptCallChecks(api,vscode,checks){
  return withFixture(async({runtime,config,script,change,jdbc,version})=>{
    await api.connectMysql(config);
    let session;
    try{
      const doc=await vscode.workspace.openTextDocument({language:'sql',content:script});
      await vscode.window.showTextDocument(doc,{preview:false});
      const description=await api.sqlScripts.describe(doc);
      session=description.sessionId;
      const review=await api.sqlScripts.preview(description.id,args);
      assert.equal(review.statements[1].call.inputs,1);
      const report=await api.sqlScripts.run(review.id);
      assertScript(report);
      const display=(resultSet)=>vscode.commands.executeCommand('rocketbrain.sql.openScriptResult',{resultId:report.resultId,index:1,resultSet});
      const first=await display(0),second=await display(1);
      assert.notEqual(first.resultId,second.resultId);
      assert.equal(first.executedSql,false);
      assert.equal(second.executedSql,false);
      assert.equal((await display(0)).resultId,first.resultId);
      assert.equal((await api.sqlScripts.openStatement(report.resultId,1)).resultId,first.resultId);
      assert.deepEqual(api.results().find(row=>row.id===first.resultId).result.rows,exactRows);
      assert.deepEqual(api.results().find(row=>row.id===second.resultId).result.rows,[[inputValue,'original']]);
      const stale=await api.sqlScripts.preview((await api.sqlScripts.describe(doc)).id,args);
      await change();
      await assert.rejects(api.sqlScripts.run(stale.id),/changed after script review/);
      checks.push('One reviewed read-only script ran a typed CALL between two SELECT statements in the same real console. Both native result sets reopened from capture without SQL replay.');
      return {engine:runtime.dbEngine,version,jdbc,typedCall:true,sameSession:true,exactResultSets:2,
        changedDefinitionRefused:true,nativeSeparateResultSets:true,noReplay:true};
    }finally{
      if(session)await api.closeConsoleSession(session);
      await api.disconnectMysql();
    }
  });
}

module.exports={verifyScriptCallBackend,runScriptCallChecks};
if(require.main===module)verifyScriptCallBackend().then(value=>console.log(JSON.stringify(value)))
  .catch(error=>{console.error(error.stack);process.exitCode=1;});
