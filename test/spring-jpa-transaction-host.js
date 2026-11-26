'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {setTimeout:delay}=require('node:timers/promises');
const mysql=require('mysql2/promise');
const { ObserverClient }=require('../src/jpa/observer-client');
const { renderTransactionTrace }=require('../src/jpa/transaction-trace-vscode');

const command='rocketbrain.jpa.observer.inspectTransactions', title='Spring JPA Transaction Outcomes';
const base='/probe/persistence-contexts/';
const read=async file=>JSON.parse(await fs.readFile(file,'utf8'));

async function withFixture(work){
  const runtime=await read(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG);
  for(const url of [runtime.baseUrl,runtime.observerUrl])assert.match(url,/^http:\/\/127\.0\.0\.1:\d+$/u);
  const dbFile=await fs.realpath(runtime.dbConfigPath);
  const dbFolder=path.dirname(dbFile), owner=await read(path.join(dbFolder,'owner.json'));
  const kind={mysql:'RocketbrainDisposableOracleMysqlFixture-v1',mariadb:'RocketbrainDisposableMariaDbFixture-v1'}[runtime.dbEngine];
  assert.ok(kind);
  assert.deepEqual([owner.kind,owner.id],[kind,path.basename(dbFolder)]);
  const config=await read(dbFile);
  assert.deepEqual([config.host,config.database],['127.0.0.1','rocketbrain_fixture']);
  const db=await mysql.createConnection(config);
  const token=(await fs.readFile(runtime.observerTokenFile,'utf8')).trim();
  const options={url:runtime.observerUrl,token,timeoutMs:10000};
  let opened=false;
  async function app(suffix,method='GET'){
    const response=await fetch(runtime.baseUrl+base+suffix,{method,signal:AbortSignal.timeout(18000),redirect:'error'});
    assert.equal(response.status,200,suffix+' owned fixture response');
    return response.json();
  }
  try{
    const [[server]]=await db.query('SELECT @@datadir AS datadir, VERSION() AS version');
    assert.equal(path.relative(dbFolder,path.dirname(await fs.realpath(server.datadir))),'');
    assert.equal(/mariadb/i.test(server.version),runtime.dbEngine==='mariadb');
    const ids=await app('open');opened=true;
    return await work({app,options,db,runtime,ids,version:server.version});
  } finally {
    try{if(opened)await app('close');}
    finally{await db.end();}
  }
}

async function verify({app,options,db,runtime,ids,version}){
  const client=new ObserverClient(options), endpoint=options.url+'/spring-transactions';
  try{
    const initial=await client.transactions();
    assert.equal(initial.state,'ready',JSON.stringify({trace:initial,warnings:(await client.refresh()).warnings}));
    assert.equal(initial.factoryHook,true);
    const baselineThrough=Math.max(0,...initial.transactions.map(row=>row.id));
    const contexts=await client.persistenceContexts();
    assert.equal(contexts.processId,initial.processId);
    const root=contexts.contexts.find(context=>context.id===ids.parentId);
    const child=contexts.contexts.find(context=>context.id===ids.childId);
    assert.ok(root&&child);
    const rootOwner={contextKey:root.key,factoryId:root.factories[0].factoryId,persistenceUnit:root.factories[0].persistenceUnit};
    const childOwner={contextKey:child.key,factoryId:child.factories[0].factoryId,persistenceUnit:child.factories[0].persistenceUnit};
    let since=baselineThrough;
    async function run(operation,count,complete=true){
      assert.deepEqual(await app('transactions/'+operation,'POST'),{complete});
      const report=await client.transactions();
      const latest=report.transactions.filter(row=>row.id>since);
      assert.equal(latest.length,count,JSON.stringify({operation,report}));
      since=Math.max(...latest.map(row=>row.id));
      for(const row of latest)assert.deepEqual(row.stages.begin,{spring:'returned',provider:'returned'});
      return latest;
    }
    const [[joined],[inner,outer],[secondary],[fault],[readOnly]]=[
      await run('joined',1),await run('independent',2),await run('child',1),
      await run('conflict',1,false),await run('read-only',1)
    ];
    const completed={spring:'returned',provider:'returned'};
    assert.deepEqual([joined.stages.commit,inner.stages.commit,outer.stages.rollback,secondary.stages.commit,readOnly.stages.commit],
      Array(5).fill(completed));
    assert.deepEqual(fault.stages.commit,{spring:'threw',provider:'threw'});
    for(const row of [joined,inner,outer,secondary,fault,readOnly])assert.deepEqual(row.stages.cleanup,{spring:'returned'});
    assert.equal(outer.stages.commit,undefined);
    assert.equal(inner.stages.rollback,undefined);
    assert.equal(readOnly.readOnly,true);
    assert.equal(joined.readOnly,false);
    assert.deepEqual([joined.owner,inner.owner,outer.owner,readOnly.owner],Array(4).fill(rootOwner));
    assert.deepEqual([secondary.owner,fault.owner],Array(2).fill(childOwner));
    assert.notEqual(joined.managerId,secondary.managerId);
    assert.equal(joined.managerType,'org.springframework.orm.jpa.JpaTransactionManager');
    assert.equal(joined.managerType,secondary.managerType);
    assert.deepEqual([inner.managerId,outer.managerId,readOnly.managerId],Array(3).fill(joined.managerId));

    const query='SELECT id,note FROM rb_context_child ORDER BY id';
    const [before]=await db.query(query);
    assert.deepEqual(before.map(row=>Number(row.id)),[91001,91002,91004,91005]);
    assert.ok(before.every(row=>row.note==='private-fixture-transaction-value'));
    assert.equal((await fetch(endpoint)).status,401);
    const auth={Authorization:'Bearer '+options.token};
    assert.equal((await fetch(endpoint,{method:'POST',headers:auth})).status,405);
    assert.equal((await fetch(endpoint+'?anything=1',{headers:auth})).status,400);
    const raw=await (await fetch(endpoint,{headers:auth})).text();
    const report=await client.transactions(), display=renderTransactionTrace(report);
    for(const secret of [options.token,'private-fixture-transaction-value','private-fixture-duplicate','rb_context_child','91003']){
      assert.equal(raw.includes(secret),false);
      assert.equal(display.includes(secret),false);
    }
    const [after]=await db.query(query);
    assert.deepEqual(after,before);
    assert.deepEqual(await client.transactions(),report);
    return {engine:runtime.dbEngine,version,springFramework:'7.0.10',baselineThrough,
      transactionCount:report.transactions.filter(transaction=>transaction.id>baselineThrough).length,
      joinedPhysicalTransactions:1,independentPhysicalTransactions:2,actualJdbcCommitRollback:true,commitFailure:true,
      exactManagerFactoryOwnership:true,readOnlyFlag:true,noPayloadOrSqlRetained:true,authenticatedGetOnly:true,observerDidNotChangeRows:true};
  }finally{client.dispose();}
}

async function runSpringJpaTransactionChecks(api,vscode,checks){
  return withFixture(async fixture=>{
    const proof=await verify(fixture);
    const prepare=await vscode.commands.executeCommand('rocketbrain.jpa.observer.prepare');
    assert.equal(prepare?.jpaTransactionTraceEnabled,false);
    assert.equal((await read(prepare.configFile)).jpaTransactionTrace,false);
    await api.jpa.observer.connect(fixture.options);
    const visible=()=>vscode.window.tabGroups.all.some(group=>group.tabs.some(tab=>tab.label===title));
    async function wait(expected){
      const cutoff=Date.now()+5000;
      while(visible()!==expected&&Date.now()<cutoff)await delay(50);
      assert.equal(visible(),expected);
    }
    try{
      const report=await vscode.commands.executeCommand(command);
      assert.equal(report?.view,command);
      const reviewed=report.transactions.filter(transaction=>transaction.id>proof.baselineThrough);
      assert.equal(reviewed.length,6);
      assert.equal(new Set(reviewed.map(transaction=>transaction.owner?.factoryId)).size,2);
      assert.ok(reviewed.some(transaction=>transaction.stages.rollback?.provider==='returned'));
      assert.ok(reviewed.some(transaction=>transaction.stages.commit?.provider==='threw'));
      await wait(true);
      api.jpa.observer.disconnect();
      await wait(false);
      checks.push('Installed Spring JPA Transaction Outcomes distinguishes committed, rolled back and failed provider calls for exact observed managers and persistence units.');
      return {...proof,nativeView:true,defaultOff:true,closedOnDisconnect:true};
    }finally{api.jpa.observer.disconnect();}
  });
}

module.exports={runSpringJpaTransactionChecks,verify};
if(require.main===module)withFixture(verify).then(result=>console.log(JSON.stringify({...result,nativeView:false}))).catch(error=>{
  console.error(error.stack);process.exitCode=1;
});
