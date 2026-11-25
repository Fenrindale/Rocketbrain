'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const mysql = require('mysql2/promise');
const {ObserverClient} = require('../src/jpa/observer-client');

const SELECT = 'select p.id as ownerId, p.displayName as displayName from Person p where p.id >= :consoleFloor order by p.id';
const POSITIONAL = 'select d.name as department, count(p.id) as total from Person p join p.department d where p.id >= ?1 group by d.name order by d.name';
const BY_NAME = 'select p.displayName as displayName from Person p where p.displayName = :consoleName';

function readConfig() {
  const file=process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG;
  const config=JSON.parse(fs.readFileSync(file,'utf8'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(path.dirname(file),'owner.json'),'utf8')).kind,'RocketbrainSpringProjectFixture-v1');
  const databaseOwner=JSON.parse(fs.readFileSync(path.join(path.dirname(config.dbConfigPath),'owner.json'),'utf8'));
  assert.ok(['RocketbrainDisposableOracleMysqlFixture-v1','RocketbrainDisposableMariaDbFixture-v1'].includes(databaseOwner.kind));
  assert.ok(['mysql','mariadb'].includes(config.dbEngine));
  const database=JSON.parse(fs.readFileSync(config.dbConfigPath,'utf8'));
  assert.equal(database.host,'127.0.0.1');
  return {config,database,token:fs.readFileSync(config.observerTokenFile,'utf8').trim()};
}

async function verifyDatabase(database) {
  const connection=await mysql.createConnection(database);
  try {
    const [[{version}]]=await connection.query('SELECT VERSION() AS version');
    await connection.query('START TRANSACTION READ ONLY');
    try {
      await assert.rejects(connection.query('UPDATE rb_spring_person SET display_name=display_name WHERE 1=0'),
        error=>error.errno===1792 || error.sqlState==='25006');
    } finally { await connection.rollback(); }
    const [rows]=await connection.query('SELECT display_name FROM rb_spring_person ORDER BY id');
    assert.deepEqual(rows.map(row=>row.display_name),['Alex','Mina']);
    return {version,readOnlyWriteRejected:true};
  } finally { await connection.end(); }
}

async function verifyConsole(client,owned) {
  const {config,database,token}=owned;
  const snapshot=await client.refresh();
  assert.equal(snapshot.consoleSelectEnabled,true);
  const factory=snapshot.factories.find(item=>item.entities.some(entity=>entity.javaType==='fixture.boot.Person'));
  assert.ok(factory);
  const target=factory.id;
  const described=await client.describeSelect(SELECT,target);
  assert.deepEqual(described.parameters,[{key:':consoleFloor',javaType:'java.lang.Long'}]);
  assert.deepEqual(described.columns,[{alias:'ownerId',javaType:'java.lang.Long'},{alias:'displayName',javaType:'java.lang.String'}]);
  assert.equal(described.sqlExecuted,false);
  const first=await client.select(SELECT,target,{':consoleFloor':'1'},1);
  assert.deepEqual(first.rows,[['1','Alex']]);
  assert.equal(first.hasMore,true);
  assert.equal(first.rolledBack,true);
  assert.equal(first.databaseReadOnlyTransaction,true);
  const position=await client.describeSelect(POSITIONAL,target);
  assert.deepEqual(position.parameters,[{key:'?1',javaType:'java.lang.Long'}]);
  const grouped=await client.select(POSITIONAL,target,{'?1':'1'});
  assert.deepEqual(grouped.rows,[['Engineering','2']]);
  assert.equal(grouped.hasMore,false);
  const named=await client.describeSelect(BY_NAME,target);
  assert.deepEqual(named.parameters,[{key:':consoleName',javaType:'java.lang.String'}]);
  assert.deepEqual((await client.select(BY_NAME,target,{':consoleName':'Mina'})).rows,[['Mina']]);
  assert.deepEqual((await client.select(BY_NAME,target,{':consoleName':null})).rows,[]);
  assert.deepEqual((await client.select(BY_NAME,target,{':consoleName':"Alex's desk"})).rows,[]);
  assert.deepEqual((await client.select(SELECT,target,{':consoleFloor':'9223372036854775807'})).rows,[]);
  const invalid = [
    await client.select('update Person p set p.displayName = :ignored',target,{':ignored':'no'}),
    await client.select('select p from Person p',target,{}),
    await client.select('select rb_upper(p.displayName) from Person p',target,{}),
    await client.select('select p.id from Person p where p.id in :values',target,{':values':'1'}),
    await client.select(SELECT,target,{':consoleFloor':'not-a-long'}),
    await client.select(SELECT,target,{':consoleFloor':'1',':extra':'4'}),
    await client.select(SELECT,target,{})
  ];
  assert.deepEqual(invalid.map(item=>item.code),['unsupported_select_shape','scalar_projection_required','unsupported_select_shape',
    'unsupported_parameter_type','invalid_parameter_value','parameter_keys_mismatch','parameter_keys_mismatch']);
  assert.ok(invalid.every(item=>item.state==='rejected'));
  const again=await client.select(SELECT,target,{':consoleFloor':'1'},100);
  assert.deepEqual(again.rows,[['1','Alex'],['2','Mina']]);
  const after=await client.refresh();
  assert.equal(after.events.some(item=>item.query===SELECT || item.query===POSITIONAL || item.query===BY_NAME),false);
  assert.equal(JSON.stringify(after).includes(token),false);
  const control=await verifyDatabase(database);
  assert.equal(/mariadb/i.test(control.version),config.dbEngine==='mariadb');
  const readiness=await fetch(config.baseUrl+'/probe/testing-state',{signal:AbortSignal.timeout(5000),redirect:'error'});
  assert.equal(readiness.status,200);
  assert.deepEqual(await readiness.json(),{people:2,departments:1,rolledBackNames:0});
  return {engine:config.dbEngine,provider:factory.provider,providerVersion:factory.version,...control,target,
    typedNamed:true,typedPositional:true,typedNull:true,precisionPreserved:true,scalarAggregate:true,truncationObserved:true,
    sessionRecovered:true,counts:[first.rowCount,grouped.rowCount,again.rowCount],rejections:invalid.length,observerRetainedBoundValues:false};
}

async function backend() {
  const owned=readConfig();
  const client=new ObserverClient({url:owned.config.observerUrl,token:owned.token,timeoutMs:10000});
  try { return {...await verifyConsole(client,owned),nativeView:false}; }
  finally { client.dispose(); }
}

async function runJpqlConsoleChecks(api,vscode,checks) {
  const owned=readConfig();
  const preparation=await vscode.commands.executeCommand('rocketbrain.jpa.observer.prepare');
  assert.equal(preparation?.consoleSelectEnabled,false);
  assert.equal(JSON.parse(fs.readFileSync(preparation.configFile,'utf8')).consoleSelect,false);
  const client=new ObserverClient({url:owned.config.observerUrl,token:owned.token,timeoutMs:10000});
  try {
    const report=await verifyConsole(client,owned);
    await api.jpa.observer.connect({url:owned.config.observerUrl,token:owned.token,timeoutMs:10000});
    const run=await vscode.commands.executeCommand('rocketbrain.jpa.console.run',{
      approved:true,query:SELECT,factoryId:report.target,values:{':consoleFloor':'1'},limit:2
    });
    assert.equal(run?.view,'rocketbrain.jpql.result');
    assert.deepEqual(run.rows,[['1','Alex'],['2','Mina']]);
    const opened=()=>vscode.window.tabGroups.all.some(group=>group.tabs.some(tab=>tab.label==='JPQL Results'));
    const deadline=Date.now()+3000;
    while(!opened()&&Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,50));
    assert.ok(opened());
    checks.push('The installed JPQL console shows typed Hibernate SELECT rows in a script-free results table; execution uses a bounded rollback-only MySQL or MariaDB transaction.');
    return {...report,nativeView:true};
  } finally { client.dispose(); api.jpa.observer.disconnect(); }
}

module.exports={runJpqlConsoleChecks,readConfig};
if (require.main===module) backend().then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error.stack);process.exitCode=1;});
