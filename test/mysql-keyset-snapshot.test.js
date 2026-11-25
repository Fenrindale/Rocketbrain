'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');
const { browseQuery,columnDefinition } = require('../src/db/grid');
const { MysqlService } = require('../src/db/mysql');

test('keyset continuation uses exact casts and nullable mixed directions',() => {
  const columns=[
    columnDefinition(['id','bigint unsigned','NO',null,'PRI','']),
    columnDefinition(['rank_value','decimal(30,10)','YES',null,'',''])
  ];
  const plan=browseQuery({name:'table',columns},{pageSize:2,sort:[{column:'rank_value',direction:'desc'}]},'schema',false,
    ['12345678901234567890.0123456789','9007199254740993']);
  assert.match(plan.sql,/WHERE .*rank_value.*< CAST\(\? AS DECIMAL\(30,10\)\) OR .*rank_value.* IS NULL/);
  assert.match(plan.sql,/id.*> CAST\(\? AS UNSIGNED\)/);
  assert.doesNotMatch(plan.sql,/\bOFFSET\b/);
  assert.deepEqual(plan.parameters,['12345678901234567890.0123456789','12345678901234567890.0123456789','9007199254740993']);
  const nullable=browseQuery({name:'table',columns},{sort:[{column:'rank_value',direction:'asc'}]},'schema',false,[null,'9']);
  assert.match(nullable.sql,/IS NOT NULL/);
  assert.deepEqual(nullable.parameters,['9']);
});

async function ownedGridFixture() {
  const configPath=process.env.ROCKETBRAIN_MYSQL_TEST_CONFIG;
  const spring=JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG,'utf8'));
  assert.equal(spring.dbConfigPath,configPath);
  const owner=JSON.parse(await fs.readFile(path.join(path.dirname(configPath),'owner.json'),'utf8'));
  assert.ok(['RocketbrainDisposableOracleMysqlFixture-v1','RocketbrainDisposableMariaDbFixture-v1'].includes(owner.kind));
  assert.equal(owner.id,path.basename(path.dirname(configPath)));
  return JSON.parse(await fs.readFile(configPath,'utf8'));
}

async function verifyKeysetSnapshot() {
  const config=await ownedGridFixture();
  const writer=await require('mysql2/promise').createConnection(config);
  const database=new MysqlService(config);
  const name='rb_snapshot_'+randomUUID().replaceAll('-','').slice(0,12);
  let opened,created=false;
  try {
    await writer.query('CREATE TABLE '+name+' (id BIGINT UNSIGNED PRIMARY KEY, rank_value DECIMAL(30,10) NULL, label VARCHAR(30)) ENGINE=InnoDB');
    created=true;
    const ids=Array.from({length:6},(_,index)=>String(9007199254740993n+BigInt(index)));
    await writer.query('INSERT INTO '+name+' (id,rank_value,label) VALUES ?', [ids.map((id,index)=>[id,
      ['12345678901234567890.0123456789','12345678901234567890.0123456789','10.5000000001','10.5000000000',null,null][index],
      'row-'+index])]);
    const options={pageSize:2,sort:[{column:'rank_value',direction:'desc'}]};
    opened=await database.openKeysetBrowser(name,options);
    const keys=result=>result.rows.map(row=>String(row[0]));
    assert.deepEqual(keys(opened.result),ids.slice(0,2));
    assert.equal(opened.result.state.inTransaction,true);
    assert.equal(opened.result.state.readOnly,true);
    assert.equal(opened.result.browse.keyset,true);
    assert.equal(opened.result.edit.canEdit,false);
    await assert.rejects(database.readKeysetPage(opened.id,{...options,page:2}),/one page/);
    await writer.execute('UPDATE '+name+' SET rank_value=NULL WHERE id=CAST(? AS UNSIGNED)',[ids[2]]);
    await writer.execute('DELETE FROM '+name+' WHERE id=CAST(? AS UNSIGNED)',[ids[3]]);
    await writer.execute('INSERT INTO '+name+' (id,rank_value,label) VALUES (?,?,?)',['18014398509481985','99','new']);
    const second=await database.readKeysetPage(opened.id,{...options,page:1});
    const third=await database.readKeysetPage(opened.id,{...options,page:2});
    assert.deepEqual(keys(second),ids.slice(2,4));
    assert.deepEqual(keys(third),ids.slice(4));
    assert.equal(third.browse.hasNext,false);
    assert.equal(third.browse.hasPrevious,true);
    assert.equal(second.state.connectionId,opened.result.state.connectionId);
    assert.equal(third.state.connectionId,opened.result.state.connectionId);
    assert.deepEqual(keys(await database.readKeysetPage(opened.id,{...options,page:1})),ids.slice(2,4));
    await database.closeKeysetBrowser(opened.id);
    await assert.rejects(database.readKeysetPage(opened.id,{...options,page:0}),/current table snapshot/);
    const changed=await database.openKeysetBrowser(name,options);
    try {
      const page=await database.readKeysetPage(changed.id,{...options,page:1});
      assert.ok(keys(page).includes('18014398509481985'));
      assert.ok(!keys(page).includes(ids[3]));
    } finally { await database.closeKeysetBrowser(changed.id); }
    return { engine:springEngine(),rows:6,exactCompositeSeek:true,concurrentWritesExcluded:true,closedRefused:true };
  } finally {
    if(opened)await database.closeKeysetBrowser(opened.id);
    await database.dispose();
    try { if(created)await writer.query('DROP TABLE '+name); }
    finally { await writer.end(); }
  }
}

function springEngine() { return process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE; }

test('real MySQL or MariaDB keyset pages retain a full read view after concurrent writes',
  {skip:!process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG},async () => verifyKeysetSnapshot());
