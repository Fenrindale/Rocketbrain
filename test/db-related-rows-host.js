'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const mysql = require('mysql2/promise');

async function runRelatedRowsChecks(api, vscode, checks) {
  const runtime = JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const owner = JSON.parse(fs.readFileSync(path.join(path.dirname(runtime.dbConfigPath), 'owner.json'), 'utf8'));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1','RocketbrainDisposableOracleMysqlFixture-v1'].includes(owner.kind));
  const config = JSON.parse(fs.readFileSync(runtime.dbConfigPath,'utf8'));
  assert.equal(config.host,'127.0.0.1');
  assert.equal(runtime.dbEngine,process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE);
  const actor = await mysql.createConnection(config);
  const suffix = randomBytes(5).toString('hex');
  const parent = 'rb_related_parent_' + suffix;
  const child = 'rb_related_child_' + suffix;
  const value = "O'Reilly\\_지점";
  let connected = false;
  async function table(name) {
    await vscode.commands.executeCommand('rocketbrain.openTable',name);
    const record = api.results().at(-1);
    assert.equal(record.result.edit.table,name);
    return record;
  }
  const row = (record, index) => ({rowId:record.result.edit.rowIds[index],modelId:record.result.edit.modelId});
  async function follow(record, index, target, direction) {
    const rowSelection = row(record,index);
    const candidates = await api.inspectRelatedRows(record.id,rowSelection);
    const match = candidates.find(item=>item.table===target && item.direction===direction);
    assert.ok(match,target);
    const id = await api.openRelatedRows(record.id,rowSelection,match.key);
    const result = api.results().find(item=>item.id===id);
    assert.equal(result.state,'done',result.error);
    assert.equal(result.readOnly,true);
    assert.notEqual(result.sessionId,record.sessionId);
    assert.equal(result.result.edit.table,target);
    return { result, match };
  }
  try {
    await actor.query('CREATE TABLE '+parent+' (tenant INT, dept VARCHAR(50), PRIMARY KEY(tenant,dept)) ENGINE=InnoDB');
    await actor.query('CREATE TABLE '+child+' (id INT PRIMARY KEY, tenant INT NULL, dept VARCHAR(50) NULL, '+
      'FOREIGN KEY (tenant,dept) REFERENCES '+parent+'(tenant,dept)) ENGINE=InnoDB');
    await actor.execute('INSERT INTO '+parent+' VALUES (?,?),(?,?)',[1,value,2,value]);
    await actor.execute('INSERT INTO '+child+' VALUES (?,?,?),(?,?,?),(?,?,?),(?,?,?)',
      [1,1,value,2,1,value,3,2,value,4,null,value]);
    await api.connectMysql(config);
    connected = true;
    const people = await table('rb_spring_person');
    const forward = await follow(people,0,'rb_spring_department','referenced');
    assert.equal(forward.result.result.rowCount,1);
    const returned = await follow(forward.result,0,'rb_spring_person','referencing');
    assert.equal(returned.result.result.rowCount,2);
    const children = await table(child);
    const relatedParent = await follow(children,0,parent,'referenced');
    assert.equal(relatedParent.result.result.rowCount,1);
    assert.deepEqual(relatedParent.result.result.rows[0].map(String),['1',value]);
    assert.deepEqual(relatedParent.result.result.browse.filters.map(item=>item.value.text),['1',value]);
    const relatedChildren = await follow(relatedParent.result,0,child,'referencing');
    assert.deepEqual(relatedChildren.result.result.rows.map(cells=>Number(cells[0])),[1,2]);
    assert.deepEqual(await api.inspectRelatedRows(children.id,row(children,3)),[]);
    await assert.rejects(api.openRelatedRows(children.id,row(children,0),relatedParent.match.key+'invalid'),/foreign key or visible row/);
    await assert.rejects(api.inspectRelatedRows(children.id,{...row(children,0),modelId:'stale'}),/current saved row/);
    const response = await fetch(runtime.baseUrl+'/probe/testing-state',{signal:AbortSignal.timeout(7000)});
    assert.equal(response.status,200);
    const jdbc = await response.json();
    assert.deepEqual(jdbc,{people:2,departments:1,rolledBackNames:0});
    checks.push('Native read-only related-row previews use fresh physical FKs, both directions and ordered composite values. NULL, invalid and stale choices retain the original results.');
    return { springParentRows:1,springChildRows:2,compositeParentRows:1,compositeChildRows:2,
      nullSkipped:true,staleRefused:true,readOnlySeparateSessions:true,jdbc };
  } finally {
    try {
      if (connected) await api.disconnectMysql();
    } finally {
      try {
        await actor.query('DROP TABLE IF EXISTS '+child);
        await actor.query('DROP TABLE IF EXISTS '+parent);
      } finally {
        await actor.end();
      }
    }
  }
}

module.exports = { runRelatedRowsChecks };
