'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const mysql = require('mysql2/promise');
const { MysqlService } = require('../src/db/mysql');
const { scopedDmlColumns } = require('../src/db/sql-dml-completion');
const { jdbcReadback } = require('./java-source-analysis-host');

const read = async filename => JSON.parse(await fs.readFile(filename,'utf8'));
const quote = name => '`' + name.replaceAll('`','``') + '`';

async function withColumns(callback) {
  const runtime = await read(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG);
  const config = await read(runtime.dbConfigPath);
  const owner = await read(path.join(path.dirname(runtime.dbConfigPath),'owner.json'));
  const cross = await read(process.env.ROCKETBRAIN_SCHEMA_CROSS_CONFIG);
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1','RocketbrainDisposableOracleMysqlFixture-v1'].includes(owner.kind));
  assert.equal(config.host,'127.0.0.1');
  assert.equal(config.database,'rocketbrain_fixture');
  assert.equal(cross.fixtureId,owner.id);
  assert.ok(cross.schemas.includes('rocketbrain_related'));
  const table = 'rbdml_'+randomBytes(5).toString('hex'), schema = 'rocketbrain_related';
  const remote = quote(schema)+'.'+quote(table), local = quote(config.database)+'.'+quote(table);
  const db = await mysql.createConnection(config);
  const created=[];
  try {
    await db.query('CREATE TABLE '+remote+' (id INT AUTO_INCREMENT PRIMARY KEY,score_value DECIMAL(14,4),score_generated DECIMAL(14,4) GENERATED ALWAYS AS (score_value*2) STORED,label VARCHAR(40)) ENGINE=InnoDB');
    created.unshift(remote);
    await db.query('CREATE TABLE '+local+' (id INT PRIMARY KEY,local_field INT) ENGINE=InnoDB');
    created.unshift(local);
    const proof = await callback({runtime,config,table,schema});
    return {engine:runtime.dbEngine,...proof,jdbc:await jdbcReadback()};
  } finally {
    try { for (const name of created) await db.query('DROP TABLE IF EXISTS '+name); }
    finally { await db.end(); }
  }
}

async function checkColumns(fixture,complete) {
  const relation = quote(fixture.schema)+'.'+quote(fixture.table);
  const cases = [
    {sql:'INSERT INTO '+relation+' (sc|)',label:'score_value',type:'Writable column · decimal(14,4)'},
    {sql:'UPDATE '+relation+" AS p SET score_value=ABS(2), p.la|=?",label:'label',type:'Writable column · varchar(40)'},
    {sql:'DELETE FROM '+relation+' AS p WHERE p.score_g|',label:'score_generated',type:'Filter column · decimal(14,4)'}
  ];
  for (const {sql,label,type} of cases) {
    const actual = await complete(sql);
    const offers = actual.filter(item=>item.detail === type);
    assert.ok(offers.some(item=>item.label===label && item.insertText===quote(label)),
      JSON.stringify({label,type,received:actual.map(item=>[item.label,item.detail])}));
    if (sql.startsWith('INSERT')) {
      assert.ok(!actual.some(item=>item.label==='score_generated' || item.label==='id' || item.label==='local_field'));
    }
  }
  assert.ok(!(await complete('UPDATE '+relation+' p JOIN '+quote(fixture.table)+' q ON p.id=q.id SET sc|=?'))
    .some(item=>item.detail?.startsWith('Writable column')));
  return {exactObservedTypes:true,qualifiedSource:true,generatedWritesExcluded:true,joinedMutationExcluded:true,completedCases:cases.length};
}

async function verifyDmlColumnBackend() {
  return withColumns(async fixture=>{
    const db=new MysqlService(fixture.config);
    try {
      const catalog=await db.metadata();
      const remote=await db.joinCompletionCatalog({endpoints:[{schema:fixture.schema,table:fixture.table}],includeEdges:false});
      assert.ok(remote.tables[0]?.columns.some(column=>column.name==='score_value' && column.extra===''),
        JSON.stringify(remote.tables.map(item=>item.columns.map(column=>[column.name,column.type,column.extra]))));
      const opts={database:catalog.database,catalogComplete:true,sqlMode:catalog.sqlMode,
        tableNameCaseSensitive:catalog.tableNameCaseSensitive};
      return await checkColumns(fixture,sql=>scopedDmlColumns(sql.replace('|',''),sql.indexOf('|'),catalog,opts,
        request=>db.joinCompletionCatalog(request)));
    } finally { await db.dispose(); }
  });
}

async function runDmlColumnCompletionChecks(api,vscode,checks) {
  return withColumns(async fixture=>{
    await api.connectMysql(fixture.config);
    try {
      const proof = await checkColumns(fixture,async sql=>{
        const document = await vscode.workspace.openTextDocument({language:'sql',content:sql.replace('|','')});
        const result = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider',document.uri,
          document.positionAt(sql.indexOf('|')));
        return result?.items.map(item=>({...item,label:typeof item.label==='string'?item.label:item.label.label})) ?? [];
      });
      checks.push('The installed SQL completion provider used qualified live column types and separated writable columns from filter columns.');
      return {...proof,nativeCompletion:true};
    } finally { await api.disconnectMysql(); }
  });
}

if (require.main===module) verifyDmlColumnBackend().then(result=>console.log(JSON.stringify(result)))
  .catch(error=>{console.error(error.stack);process.exitCode=1;});

module.exports={runDmlColumnCompletionChecks,verifyDmlColumnBackend};
