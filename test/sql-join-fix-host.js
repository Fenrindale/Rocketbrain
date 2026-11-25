'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const mysql = require('mysql2/promise');
const { sqlJoinFixes } = require('../src/db/sql-join-fixes');
const { jdbcReadback } = require('./java-source-analysis-host');
const { MysqlService } = require('../src/db/mysql');

const expected = [[1,'correct registrar']];
const jdbcExpected = { people:2,departments:1,rolledBackNames:0 };
const junction='rocketbrain.sql.applyJoinQuickFix';

async function withFixture(action) {
  const runtime=JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG,'utf8'));
  const config=JSON.parse(await fs.readFile(runtime.dbConfigPath,'utf8'));
  const owner=JSON.parse(await fs.readFile(path.join(path.dirname(runtime.dbConfigPath),'owner.json'),'utf8'));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1','RocketbrainDisposableOracleMysqlFixture-v1'].includes(owner.kind));
  assert.equal(config.host,'127.0.0.1');
  assert.equal(config.database,'rocketbrain_fixture');
  const suffix=randomBytes(4).toString('hex');
  const parent='rb_qf_parent_'+suffix,child='rb_qf_child_'+suffix,relation='rb_qf_'+suffix;
  const actor=await mysql.createConnection(config);
  try {
    await actor.query(`CREATE TABLE ${parent}(tenant INT NOT NULL,id BIGINT UNSIGNED NOT NULL,label VARCHAR(40),PRIMARY KEY(tenant,id)) ENGINE=InnoDB`);
    await actor.query(`CREATE TABLE ${child}(id INT PRIMARY KEY,tenant INT NOT NULL,parent_id BIGINT UNSIGNED NOT NULL,
      CONSTRAINT ${relation} FOREIGN KEY(tenant,parent_id) REFERENCES ${parent}(tenant,id)) ENGINE=InnoDB`);
    await actor.execute(`INSERT INTO ${parent} VALUES (1,?,'correct registrar'),(2,?,'other tenant')`,['9007199254740993','9007199254740993']);
    await actor.execute(`INSERT INTO ${child} VALUES (1,1,?)`,['9007199254740993']);
    const select=`SELECT c.id,p.label FROM ${child} AS c LEFT JOIN ${parent} AS p`;
    const sql=select+' ON';
    const jdbc=await jdbcReadback();
    assert.deepEqual(jdbc,jdbcExpected);
    const [[value]]=await actor.query('SELECT VERSION() serverVersion');
    const dropKey=()=>actor.query(`ALTER TABLE ${child} DROP FOREIGN KEY ${relation}`);
    return await action({runtime,config,actor,sql,select,relation,jdbc,dropKey,version:value.serverVersion});
  } finally {
    try { await actor.query(`DROP TABLE IF EXISTS ${child},${parent}`); }
    finally { await actor.end(); }
  }
}

async function verifyJoinFixBackend() {
  return withFixture(async ({runtime,config,actor,sql,relation,dropKey,version,jdbc})=>{
    const db=new MysqlService(config);
    try {
      const catalog=await db.metadata();
      const prove=()=>sqlJoinFixes(sql,sql.length,catalog,request=>db.joinCompletionCatalog(request));
      const [fix]=await prove();
      assert.equal(fix?.title,'Complete JOIN using '+relation);
      assert.equal(fix.replacement,' `c`.`tenant` = `p`.`tenant` AND `c`.`parent_id` = `p`.`id`');
      const [result]=await actor.query({sql:sql+fix.replacement,rowsAsArray:true});
      assert.deepEqual(result,expected);
      await dropKey();
      assert.deepEqual(await prove(),[]);
      return {engine:runtime.dbEngine,version,jdbc,compositePredicate:true,liveJoinExact:true,removedKeyRefused:true};
    } finally { await db.dispose(); }
  });
}

async function runSqlJoinQuickFixChecks(api,vscode,checks) {
  return withFixture(async ({runtime,config,sql,select,relation,jdbc,dropKey,version})=>{
    await api.connectMysql(config);
    try {
      const source='SELECT 42;\n'+sql+' WHERE c.id=1;',document=await vscode.workspace.openTextDocument({language:'sql',content:source});
      const editor=await vscode.window.showTextDocument(document,{preview:false});
      const on=source.indexOf(' ON')+3;
      const actions=async (doc,offset)=>{
        const at=doc.positionAt(offset),range=new vscode.Range(at,at);
        return (await vscode.commands.executeCommand('vscode.executeCodeActionProvider',doc.uri,range,'quickfix'))
          .filter(item=>item.command?.command===junction);
      };
      const command=async (doc,offset)=>{
        const items=await actions(doc,offset);
        assert.equal(items.length,1);
        assert.equal(items[0].title,'Complete JOIN using '+relation);
        return items[0].command;
      };
      const run=action=>vscode.commands.executeCommand(action.command,...action.arguments);
      const first=await command(document,on);
      assert.equal(await editor.edit(edit=>edit.insert(document.positionAt(source.length),'\n')),true);
      assert.equal(await run(first),false);
      assert.equal(document.getText(),source+'\n');
      const fresh=await command(document,on);
      assert.equal(await run(fresh),true);
      const expectedText='SELECT 42;\n'+select+' ON `c`.`tenant` = `p`.`tenant` AND `c`.`parent_id` = `p`.`id` WHERE c.id=1;\n';
      assert.equal(document.getText(),expectedText);
      assert.deepEqual(await actions(document,on),[]);
      editor.selection=new vscode.Selection(document.positionAt('SELECT 42;\n'.length),document.positionAt(expectedText.length));
      const resultId=await vscode.commands.executeCommand('rocketbrain.runQuery');
      assert.deepEqual(api.results().find(item=>item.id===resultId)?.result?.rows,expected);

      const bare=await vscode.workspace.openTextDocument({language:'sql',content:select});
      const stale=await command(bare,select.length);
      await dropKey();
      assert.equal(await run(stale),false);
      assert.equal(bare.getText(),select);
      assert.deepEqual(await actions(bare,select.length),[]);
      checks.push('Native JOIN Quick Fix inserts every observed composite key component and retains existing aliases, clauses and adjacent SQL. The real query joins only the matching tenant.');
      checks.push('Revalidation rejects edited source, existing ON text, and a foreign key removed by another connection.');
      return {engine:runtime.dbEngine,version,jdbc,compositePredicate:true,liveJoinExact:true,removedKeyRefused:true,
        dirtySourceRefused:true,nativeQuickFix:true,existingOnPreserved:true,adjacentSqlPreserved:true};
    } finally { await api.disconnectMysql(); }
  });
}

module.exports={verifyJoinFixBackend,runSqlJoinQuickFixChecks};
if(require.main===module)verifyJoinFixBackend().then(result=>console.log(JSON.stringify(result)))
  .catch(error=>{console.error(error.stack);process.exitCode=1;});
