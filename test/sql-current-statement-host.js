'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const mysql = require('mysql2/promise');
const { jdbcReadback } = require('./java-source-analysis-host');

const read = async filename => JSON.parse(await fs.readFile(filename,'utf8'));
const quote = name => '`' + name.replaceAll('`','``') + '`';

async function runCurrentSqlStatementChecks(api,vscode,checks) {
  const runtime = await read(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG);
  const owner = await read(path.join(path.dirname(runtime.dbConfigPath),'owner.json'));
  const config = await read(runtime.dbConfigPath);
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1','RocketbrainDisposableOracleMysqlFixture-v1'].includes(owner.kind));
  assert.equal(config.host,'127.0.0.1');
  assert.equal(config.database,'rocketbrain_fixture');
  const workspace = await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
  assert.equal(path.relative(workspace,await fs.realpath(process.env.ROCKETBRAIN_JAVA_TEST_WORKSPACE)),'');
  const name = 'rb_stmt_cursor_' + randomBytes(4).toString('hex');
  const actor = await mysql.createConnection(config);
  const source = path.join(workspace,name+'.sql');
  const routine = quote(name), before = quote(name+'_before'), after = quote(name+'_after');
  const sql = ['CREATE TABLE '+before+' (id INT);','DELIMITER //',
    'CREATE PROCEDURE '+routine+"() BEGIN SELECT 'literal // text'; SELECT 9 AS n; END//",
    'DELIMITER ;','SELECT 23 AS chosen;', 'CREATE TABLE '+after+' (id INT);'].join('\n');
  let sessionId, created;
  try {
    await api.connectMysql(config);
    await fs.writeFile(source,sql,{flag:'wx'});
    created = true;
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(source));
    const editor = await vscode.window.showTextDocument(document);
    const cursor = document.positionAt(sql.indexOf('SELECT 23'));
    editor.selection = new vscode.Selection(cursor,cursor);
    const query = await vscode.commands.executeCommand('rocketbrain.runQuery');
    assert.equal(query.completed,1);
    const cached = await api.sqlScripts.openStatement(query.resultId,0);
    assert.equal(cached.executedSql,false);
    const result = api.results().find(item=>item.id===cached.resultId);
    assert.deepEqual(result.result.rows.map(row=>row.map(String)),[['23']]);
    sessionId = result.sessionId ?? api.results().find(item=>item.id===query.resultId).sessionId;
    assert.ok(sessionId);
    await api.configureConsoleSession(sessionId,{readOnly:false});
    await assert.rejects(api.sqlScripts.describeCurrent(document,sql.indexOf('DELIMITER //')),/outside the DELIMITER directives/);
    const description = await api.sqlScripts.describeCurrent(document,sql.indexOf('SELECT 9'));
    assert.deepEqual(description.statements.map(item=>item.program),['PROCEDURE']);
    assert.equal(description.compound,true);
    assert.equal(sql.slice(description.editorRange.start, description.editorRange.end),
      'CREATE PROCEDURE '+routine+"() BEGIN SELECT 'literal // text'; SELECT 9 AS n; END//");
    const selection = {start:sql.indexOf('CREATE PROCEDURE'),end:description.editorRange.end-2};
    const selected = await api.sqlScripts.describeCurrent(document,selection.end,selection);
    assert.equal(selected.sourceSqlHash,description.sourceSqlHash);
    assert.equal(await api.sqlScripts.describeCurrent(document,selection.end,{...selection,start:selection.start+1}),undefined);
    const reviewed = await api.sqlScripts.preview(selected.id,[]);
    await assert.rejects(api.sqlScripts.run(reviewed.id),/acknowledge/);
    const deployed = await api.sqlScripts.run(reviewed.id,{allowImplicitCommit:true});
    assert.equal(deployed.completed,1);
    const [createdTables] = await actor.execute('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (?,?)',
      [name+'_before',name+'_after']);
    assert.equal(createdTables.length,0);
    const [outputs] = await actor.query('CALL '+routine+'()');
    assert.deepEqual(outputs.slice(0,2).map(rows=>Object.values(rows[0]).map(String)),[['literal // text'],['9']]);
    const jdbc = await jdbcReadback();
    assert.deepEqual(jdbc,{people:2,departments:1,rolledBackNames:0});
    checks.push('The installed current-statement command respected client separators and the reviewed routine excluded adjacent DDL.');
    return {engine:runtime.dbEngine,installedRunQuery:true,compoundStatementOnly:true,adjacentDdlExcluded:true,
      directiveRowsRefused:true,exactBody:true,exactSelection:true,partialSelectionExcluded:true,jdbc};
  } finally {
    try {
      if (sessionId) await api.closeConsoleSession(sessionId);
      await api.disconnectMysql();
    } finally {
      try {
        for (const typeAndName of ['PROCEDURE '+routine,'TABLE '+before,'TABLE '+after]) {
          const [type,name] = typeAndName.split(' ');
          await actor.query('DROP '+type+' IF EXISTS '+name);
        }
      } finally {
        await actor.end();
        if (created) await fs.unlink(source);
      }
    }
  }
}

module.exports = {runCurrentSqlStatementChecks};
