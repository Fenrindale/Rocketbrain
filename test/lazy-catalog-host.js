'use strict';

const fs=require('node:fs');
const assert=require('node:assert/strict');
const mysql=require('mysql2/promise');

async function runLazyCatalogChecks(api,vscode,checks){
  const runtime=JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG,'utf8'));
  const config=JSON.parse(fs.readFileSync(runtime.dbConfigPath,'utf8'));
  assert.equal(config.host,'127.0.0.1');
  const tools=api.lazyCatalog;
  assert.ok(tools);
  assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.db.browseObjectNames'));
  const db=await mysql.createConnection(config);
  try{
    await api.connectMysql(config);
    const page=await tools.list({prefix:'rb_spring_'});
    assert.equal(page.detailQueries,0);
    const [expectedNames]=await db.execute(
      "SELECT TABLE_NAME,TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() "+
      "AND TABLE_NAME LIKE 'rb=_spring=_%' ESCAPE '=' AND TABLE_TYPE IN ('VIEW','BASE TABLE') ORDER BY CAST(TABLE_NAME AS BINARY)");
    assert.deepEqual(page.items.map(item=>[item.name,item.kind]),expectedNames.map(row=>
      [row.TABLE_NAME,row.TABLE_TYPE==='VIEW'?'view':'table']));
    assert.ok(page.items.every(item=>Object.keys(item).length===3));
    const index=page.items.findIndex(item=>item.name==='rb_spring_person');
    assert.ok(index>=0);
    const description=await tools.inspect(page.id,index);
    const [columns]=await db.execute('SELECT COLUMN_NAME,COLUMN_TYPE FROM information_schema.COLUMNS '+
      "WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='rb_spring_person' ORDER BY ORDINAL_POSITION");
    assert.deepEqual(description.columns.map(item=>[item.name,item.type]),columns.map(row=>[row.COLUMN_NAME,row.COLUMN_TYPE]));
    assert.ok(description.indexColumns.some(item=>item.name==='PRIMARY'&&item.column==='id'&&item.unique));
    assert.ok(description.indexColumns.some(item=>item.column==='department_id'));
    assert.equal(description.rowDataIncluded,false);
    await api.connectMysql(config);
    await assert.rejects(tools.inspect(page.id,index),/current catalog page|connection changed/);
    const response=await fetch(runtime.baseUrl+'/probe/testing-state',{signal:AbortSignal.timeout(10000)});
    const jdbc={people:2,departments:1,rolledBackNames:0};
    assert.equal(response.ok,true);
    assert.deepEqual(await response.json(),jdbc);
    checks.push('Database Object Names initially listed only name and type from the actual Spring schema. Opening an exact table loaded its observed columns and indexes. Reconnecting expired the earlier page, and Spring JDBC counts stayed unchanged.');
    return {names:page.items.length,onlyNamesAtFirst:true,columns:description.columns.length,
      indexColumns:description.indexColumns.length,stalePageRefused:true,jdbc};
  }finally{
    const exit=await Promise.allSettled([db.end(),api.disconnectMysql()]);
    for(const result of exit)if(result.status==='rejected')throw result.reason;
  }
}

module.exports={runLazyCatalogChecks};
