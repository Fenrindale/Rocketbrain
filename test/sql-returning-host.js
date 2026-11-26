'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const mysql = require('mysql2/promise');
const { MysqlService } = require('../src/db/mysql');
const { analyzeSql, completionsAt } = require('../src/db/sql-analysis');
const { analyzeDmlUsage } = require('../src/db/sql-dml-usages');
const { liveNavigation, quickInfo } = require('../src/db/sql-live-navigation');
const { analyzeLiveDdlScript } = require('../src/db/ddl-model');

const tick = String.fromCharCode(96);
const quote = value => tick + value + tick;
const read = async file => JSON.parse(await fs.readFile(file,'utf8'));
const springState = { people:2, departments:1, rolledBackNames:0 };
const owned = new Set(['RocketbrainDisposableMariaDbFixture-v1','RocketbrainDisposableOracleMysqlFixture-v1']);

function dialectOptions(catalog) {
  return { dialect:catalog.dialect, serverVersion:catalog.serverVersion, database:catalog.database,
    sqlMode:catalog.sqlMode, catalogComplete:true, tableNameCaseSensitive:catalog.tableNameCaseSensitive };
}

async function verifyReturning(runtimePath, native) {
  const runtime = await read(runtimePath);
  const folder=path.dirname(await fs.realpath(runtime.dbConfigPath));
  const owner=await read(path.join(folder,'owner.json'));
  assert.equal(owner.id,path.basename(folder));
  assert.ok(owned.has(owner.kind));
  assert.equal(new URL(runtime.baseUrl).hostname,'127.0.0.1');
  const config = await read(runtime.dbConfigPath);
  assert.equal(config.host,'127.0.0.1');
  assert.equal(config.database,'rocketbrain_fixture');
  const actor = await mysql.createConnection(config);
  const tag = randomBytes(4).toString('hex');
  const name = 'rb_returning_' + tag, target = quote(name);
  const scope = new MysqlService(config);
  try {
    await actor.query('CREATE TABLE ' + target + ' (id INT PRIMARY KEY, amount DECIMAL(12,2) NOT NULL, memo VARCHAR(24)) ENGINE=InnoDB');
    await actor.query('INSERT INTO ' + target + " VALUES(1,10,'original')");
    const catalog = await scope.metadata(), opts = dialectOptions(catalog), maria = catalog.dialect === 'mariadb';
    const aliasAllowed = maria && /^(?:12|13)\./.test(catalog.serverVersion);
    const cases = [
      { kind:'INSERT VALUES', sql:'INSERT INTO ' + target + " (id,amount) VALUES(3,20.50) RETURNING id,amount AS saved,amount+1 AS next",
        rows:[{id:3,saved:'20.50',next:'21.50'}], columns:['id','saved','next'], native:true },
      { kind:'INSERT SELECT', sql:'INSERT INTO ' + target + ' (id,amount) SELECT id,200 FROM rb_spring_person WHERE id=2 RETURNING amount AS saved',
        rows:[{saved:'200.00'}], columns:['saved'] },
      { kind:'INSERT ON DUPLICATE KEY', sql:'INSERT INTO ' + target + ' (id,amount) VALUES(1,30) ON DUPLICATE KEY UPDATE amount=30 RETURNING amount',
        rows:[{amount:'30.00'}], columns:['amount'] },
      { kind:'REPLACE SET', sql:'REPLACE ' + target + " SET id=1,amount=40 RETURNING amount AS replacement",
        rows:[{replacement:'40.00'}], columns:['replacement'] },
      { kind:'DELETE LIMIT', sql:'DELETE FROM ' + target + ' ORDER BY id LIMIT 1 RETURNING ' + target + '.amount',
        rows:[{amount:'10.00'}], columns:['amount'] },
      { kind:'DELETE scalar subquery', sql:'DELETE FROM ' + target + ' WHERE id=1 RETURNING (SELECT MAX(id) FROM rb_spring_person) AS people',
        rows:[{people:2}], columns:['people'] }
    ];
    const controls = [
      { code:'sql.returning.version', sql:'UPDATE ' + target + ' SET amount=12 WHERE id=1 RETURNING amount', expected:'ER_PARSE_ERROR' },
      { code:'sql.returning.aggregate', sql:'DELETE FROM ' + target + ' WHERE id=1 RETURNING COUNT(amount)', expected:'ER_INVALID_GROUP_FUNC_USE' },
      { code:'sql.name.column', sql:'REPLACE INTO ' + target + ' VALUES(1,20,NULL) RETURNING absent_field', expected:'ER_BAD_FIELD_ERROR' },
      { code:'sql.returning.singleTable', sql:'DELETE d FROM ' + target + ' AS d JOIN rb_spring_person AS p ON d.id=p.id RETURNING d.id', expected:'ER_PARSE_ERROR' }
    ];
    const alias='DELETE FROM ' + target + ' d WHERE d.id=1 RETURNING d.amount';
    if(aliasAllowed)cases.push({kind:'DELETE alias',sql:alias,rows:[{amount:'10.00'}],columns:['amount']});
    else controls.push({code:'sql.returning.deleteAlias',sql:alias,expected:'ER_PARSE_ERROR'});
    const analyze = sql => analyzeSql(sql,catalog,opts);
    const diagnostic = (sql,code) => {
      const result = analyze(sql);
      assert.equal(result.state,'invalid',sql);
      const item = result.diagnostics.find(value=>value.code===code);
      assert.ok(item,JSON.stringify(result.diagnostics));
      assert.equal(sql.slice(item.start,item.end),code==='sql.returning.aggregate'?'COUNT':code==='sql.name.column'?'absent_field':'RETURNING');
    };

    for (const item of cases) {
      if (!maria) { diagnostic(item.sql,'sql.returning.dialect'); continue; }
      const model = analyze(item.sql);
      assert.equal(model.state,'known',JSON.stringify(model.diagnostics));
      assert.deepEqual(model.projections.map(value=>value.name),item.columns);
      assert.equal(model.executedSql,false);
      assert.equal(model.validityVerified,false);
      const expected = item.kind==='DELETE scalar subquery'?'rb_spring_person':name;
      assert.ok(model.projections.every(value=>value.inputs.length && value.inputs.every(origin=>origin.table===expected)));
      assert.equal(model.returning.rowImage,item.kind.startsWith('DELETE')?'deleted':'written');
      if(item.kind==='INSERT SELECT')assert.ok(analyzeDmlUsage(item.sql,catalog,opts).references
        .some(ref=>ref.physicalColumn?.table==='rb_spring_person'&&ref.physicalColumn.column==='id'));
    }
    for(const item of controls)diagnostic(item.sql,maria?item.code:'sql.returning.dialect');

    const prefix='INSERT INTO ' + target + ' (id,amount) VALUES(3,20) RETURNING am';
    const candidates=completionsAt(analyze(prefix),prefix.length);
    assert.deepEqual(candidates.map(item=>item.label),maria?['amount']:[]);
    if(maria)assert.equal(prefix.slice(candidates[0].start,candidates[0].end),'am');
    const main = cases[0].sql, columnOffset=main.indexOf('amount AS saved')+1;
    const definition=liveNavigation(main,columnOffset,catalog,opts);
    if(maria){
      assert.deepEqual(definition.object,{schema:config.database,kind:'table',name});
      assert.equal(definition.member.name,'amount');
      assert.match(quickInfo(definition),/INSERT RETURNING result column/);
    }else assert.equal(definition,undefined);

    const modeScript="SET SESSION sql_mode='ANSI_QUOTES';\nDELETE FROM \""+name+"\" WHERE \"id\"=1 RETURNING \"amount\";";
    const mode = analyzeLiveDdlScript(modeScript,catalog).statements[1];
    assert.deepEqual(mode.sqlMode,['ANSI_QUOTES']);
    assert.equal(mode.model.state,maria?'known':'invalid');
    const snapshot = async () => (await actor.query('SELECT id,amount,memo FROM '+target+' ORDER BY id'))[0];
    const untouched = [{id:1,amount:'10.00',memo:'original'}];
    assert.deepEqual(await snapshot(),untouched);
    if(native)await native({config,name,maria,cases,main,columnOffset,prefix,modeScript, actor});
    assert.deepEqual(await snapshot(),untouched);

    for(const item of [...cases,...controls]){
      await actor.beginTransaction();
      try{
        if(maria&&item.rows)assert.deepEqual((await actor.query(item.sql))[0],item.rows,item.kind);
        else await assert.rejects(actor.query(item.sql),{code:maria?item.expected:'ER_PARSE_ERROR'});
      }finally{await actor.rollback();}
    }
    assert.deepEqual(await snapshot(),untouched);
    const response=await fetch(runtime.baseUrl+'/probe/testing-state',{signal:AbortSignal.timeout(9000)});
    assert.equal(response.ok,true);
    assert.deepEqual(await response.json(),springState);
    return { engine:catalog.dialect, version:catalog.serverVersion, realAccepted:maria?cases.map(item=>item.kind):[],
      realRejected:maria?controls.length:cases.length+controls.length, returningProjectionOnly:true, targetDdlBinding:maria,
      declaredAnsiQuotes:true, autocompleteTargetFields:maria, schemaAndDataUnchangedDuringAnalysis:true,
      transactionalQueryControlsRestored:true, spring:springState };
  } finally {
    try { await scope.dispose(); await actor.query('DROP TABLE IF EXISTS ' + target); }
    finally { await actor.end(); }
  }
}

async function verifyReturningBackend(runtimePath = process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG) {
  return verifyReturning(runtimePath);
}

async function runSqlReturningChecks(api,vscode,checks) {
  const result = await verifyReturning(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG,async fixture=>{
    await api.connectMysql(fixture.config);
    await api.sqlAnalysis.refreshMetadata();
    const opened = new Set();
    const open = async content=>{
      const doc=await vscode.workspace.openTextDocument({language:'sql',content});
      opened.add(doc.uri.toString());
      return doc;
    };
    try{
      const doc=await open(fixture.main);
      const report=api.sqlAnalysis.analyzeDocument(doc);
      assert.equal(report.statements[0].model.state,fixture.maria?'known':'invalid');
      const diagnostics=vscode.languages.getDiagnostics(doc.uri);
      const dialect=diagnostics.find(item=>item.code==='sql.returning.dialect');
      if(fixture.maria)assert.equal(dialect,undefined);
      else assert.equal(doc.getText(dialect.range),'RETURNING');

      const partial=await open(fixture.prefix);
      const outcome=await vscode.commands.executeCommand('vscode.executeCompletionItemProvider',partial.uri,partial.positionAt(fixture.prefix.length));
      const suggestion=outcome?.items.find(item=>item.label==='amount'&&item.detail?.startsWith('RETURNING ·'));
      if(fixture.maria){
        assert.ok(suggestion,'MariaDB RETURNING completion was missing');
        assert.equal(partial.getText(suggestion.range?.replacing || suggestion.range),'am');
        const position=doc.positionAt(fixture.columnOffset);
        const links=await vscode.commands.executeCommand('vscode.executeDefinitionProvider',doc.uri,position);
        const live=links.find(item=>(item.uri||item.targetUri).scheme==='rocketbrain-object-source');
        assert.ok(live,'MariaDB RETURNING target DDL was not opened');
        const ddl=await vscode.workspace.openTextDocument(live.uri||live.targetUri);
        opened.add(ddl.uri.toString());
        assert.equal(ddl.getText(live.range||live.targetSelectionRange),quote('amount'));
        const [[direct]]=await fixture.actor.query('SHOW CREATE TABLE '+quote(fixture.name));
        assert.equal(ddl.getText(),direct['Create Table']);
        const hovers=await vscode.commands.executeCommand('vscode.executeHoverProvider',doc.uri,position);
        const hoverText=hovers.flatMap(item=>item.contents.map(value=>
          (typeof value==='string'?value:value.value).replace(/&nbsp;|\u00a0/g,' ')));
        assert.ok(hoverText.some(value=>value.includes('INSERT RETURNING result column')),JSON.stringify(hoverText));
      }else assert.equal(suggestion,undefined);
      const mixed=await open(fixture.modeScript);
      const shadow=api.sqlAnalysis.analyzeDocument(mixed).statements[1];
      assert.equal(shadow.model.state,fixture.maria?'known':'invalid');
      assert.deepEqual(shadow.sqlMode,['ANSI_QUOTES']);
    }finally{
      const tabs=vscode.window.tabGroups.all.flatMap(group=>group.tabs).filter(tab=>opened.has(tab.input?.uri?.toString()));
      if(tabs.length)await vscode.window.tabGroups.close(tabs);
      await api.disconnectMysql();
    }
  });
  checks.push('Native SQL RETURNING used exact MariaDB target row projections and reported MariaDB version and Oracle MySQL dialect boundaries.');
  return {...result,nativeReturningProviders:true};
}

module.exports = { verifyReturningBackend, runSqlReturningChecks };
if(require.main===module)verifyReturningBackend().then(result=>console.log(JSON.stringify(result)))
  .catch(error=>{console.error(error.stack);process.exitCode=1;});
