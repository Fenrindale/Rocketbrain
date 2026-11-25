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

async function withColumns(callback,readback=jdbcReadback) {
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
    await db.query('CREATE TABLE '+local+' (id INT PRIMARY KEY,local_field INT,score_value DECIMAL(10,2)) ENGINE=InnoDB');
    created.unshift(local);
    const proof = await callback({runtime,config,table,schema},db);
    return {engine:runtime.dbEngine,...proof,jdbc:await readback()};
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
  assert.ok(!(await complete('UPDATE '+relation+' p JOIN '+quote(fixture.table)+' q ON p.id=q.id SET missing.sc|=?'))
    .some(item=>item.detail?.startsWith('Writable column')));
  return {exactObservedTypes:true,qualifiedSource:true,generatedWritesExcluded:true,unboundJoinExcluded:true,completedCases:cases.length};
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

if (require.main===module) {
  const run=process.argv.includes('--joined')?verifyJoinedDmlCompletion:verifyDmlColumnBackend;
  run().then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error.stack);process.exitCode=1;});
}

function completionOffer(document,item) {
  const range = item.range?.replacing ?? item.range;
  return {label:typeof item.label==='string' ? item.label : item.label.label,detail:item.detail,insertText:item.insertText,
    ...(range&&{start:document.offsetAt(range.start),end:document.offsetAt(range.end)})};
}

async function verifyJoinedEdits(fixture,db,complete) {
  const local=quote(fixture.config.database)+'.'+quote(fixture.table),
    remote=quote(fixture.schema)+'.'+quote(fixture.table);
  await db.query('INSERT INTO '+local+' VALUES (1,10,11),(2,20,22)');
  await db.query('INSERT INTO '+remote+' (id,score_value,label) VALUES (1,12.50,NULL),(2,31.20,NULL)');
  const join=local+' localRow JOIN '+remote+' remoteRow ON localRow.id=remoteRow.id';
  const exec=async (source, fragment, label, kind, type) => {
    const candidates=await complete(source),body=source.replace('|','');
    const found=candidates.filter(item=>item.label===label && item.detail?.startsWith(kind+' · '+type));
    assert.equal(found.length,1,JSON.stringify({label,kind,received:candidates.map(item=>[item.label,item.detail])}));
    const [item]=found;
    assert.equal(body.slice(item.start,item.end),fragment);
    assert.equal(item.insertText,quote(label));
    return body.slice(0,item.start)+item.insertText+body.slice(item.end);
  };
  const update=await exec('UPDATE '+join+' SET localRow.lo|_field=ABS(remoteRow.score_value) - 0.50, remoteRow.label=? WHERE localRow.id=1',
    'lo_field','local_field','Writable column','int');
  const value=await exec('UPDATE '+join+' SET localRow.local_field=ABS(remoteRow.score_v|) - 0.20 WHERE localRow.id=2',
    'score_v','score_value','Value column','decimal(14,4)');
  const filter=await exec('DELETE remoteRow FROM '+join+' WHERE remoteRow.score_g|=25',
    'score_g','score_generated','Filter column','decimal(14,4)');
  const target=await exec('DELETE localRow, remote|.* FROM '+join+' WHERE localRow.id=2',
    'remote','remoteRow','DELETE target',fixture.schema+'.'+fixture.table);
  const using=await exec('DELETE FROM remote| USING '+join+' WHERE localRow.id=2',
    'remote','remoteRow','DELETE target',fixture.schema+'.'+fixture.table);
  for (const source of ['UPDATE '+join+' SET score_v|=1', 'UPDATE '+join+' SET remoteRow.score_g|=1',
    'UPDATE '+join+' SET remoteRow.id|=1','UPDATE '+join+' SET remoteRow.label=?, remoteRow.la|=?',
    'DELETE remoteRow FROM '+join+' WHERE score_v|=25', 'DELETE localRow, local| FROM '+join,
    'DELETE missing FROM '+join+' WHERE remoteRow.score_g|=25',
    'UPDATE '+join+' SET remoteRow.la| = broken.score_value']) {
    assert.ok(!(await complete(source)).some(item=>/^(?:Writable|Value|Filter) column · |^DELETE target · /u.test(item.detail)),source);
  }

  await db.beginTransaction();
  try {
    assert.equal((await db.execute(update,['checked']))[0].affectedRows,2);
    assert.equal((await db.execute(value))[0].affectedRows,1);
    const [rows]=await db.query('SELECT localRow.local_field, remoteRow.label FROM '+join+' ORDER BY localRow.id');
    assert.deepEqual(rows.map(row=>[row.local_field,row.label]),[[12,'checked'],[31,null]]);
    const counts=async()=> {
      const [[row]]=await db.query('SELECT (SELECT COUNT(*) FROM '+local+') l,(SELECT COUNT(*) FROM '+remote+') r');
      return [Number(row.l),Number(row.r)];
    };
    for(const [sql,affected,expected] of [[filter,1,[2,1]],[target,2,[1,1]],[using,1,[2,1]]]) {
      await db.query('SAVEPOINT rb_dml_completion');
      assert.equal((await db.execute(sql))[0].affectedRows,affected);
      assert.deepEqual(await counts(),expected);
      await db.query('ROLLBACK TO SAVEPOINT rb_dml_completion');
    }
  } finally { await db.rollback(); }
  const [after]=await db.query('SELECT localRow.local_field, remoteRow.label FROM '+join+' ORDER BY localRow.id');
  assert.deepEqual(after.map(row=>[row.local_field,row.label]),[[10,null],[20,null]]);
  const [[{version}]]=await db.query('SELECT VERSION() version');
  return {version,exactEdits:true,joinedUpdatesToBothOwners:true,readValueAndFilterColumns:true,
    generatedWritesExcluded:true,ambiguousUnqualifiedExcluded:true,unboundAndDuplicateOwnersExcluded:true,
    bothDeleteSyntaxes:true,completedStatementsExecuted:5,rollbackPreserved:true};
}

async function runJoinedDmlCompletionChecks(api,vscode,checks) {
  const proof=await withColumns(async (fixture,db)=>{
    await api.connectMysql(fixture.config);
    try {
      await api.sqlAnalysis.refreshMetadata();
      return await verifyJoinedEdits(fixture,db,async source=>{
        const document=await vscode.workspace.openTextDocument({language:'sql',content:source.replace('|','')});
        const result=await vscode.commands.executeCommand('vscode.executeCompletionItemProvider',document.uri,
          document.positionAt(source.indexOf('|')));
        return result?.items.map(item=>completionOffer(document,item)) ?? [];
      });
    } finally { await api.disconnectMysql(); }
  });
  checks.push('The installed SQL provider completed the observed joined UPDATE and both DELETE forms. Applying the exact edits to owned SQL produced the expected results and rolled back.');
  return {...proof,nativeCompletion:true};
}

function verifyJoinedDmlCompletion(readback) {
  return withColumns(async (fixture,db)=>{
    const service=new MysqlService(fixture.config);
    try {
      const catalog=await service.metadata();
      const options={dialect:catalog.dialect,database:catalog.database,catalogComplete:true,sqlMode:catalog.sqlMode,
        tableNameCaseSensitive:catalog.tableNameCaseSensitive};
      return await verifyJoinedEdits(fixture,db,source=>scopedDmlColumns(source.replace('|',''),source.indexOf('|'),
        catalog,options,request=>service.joinCompletionCatalog(request)));
    } finally { await service.dispose(); }
  },readback);
}

module.exports={runDmlColumnCompletionChecks,verifyDmlColumnBackend,runJoinedDmlCompletionChecks,verifyJoinedDmlCompletion};
