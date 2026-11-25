'use strict';

const fs=require('node:fs');
const assert=require('node:assert/strict');
const mysql=require('mysql2/promise');
const {ObserverClient}=require('../src/jpa/observer-client');
const {readConfig}=require('./jpql-console-host');

const LEFT_MANY='select o from PerformanceOwner o left join fetch o.items where o.id >= :floor and o.id <= :ceiling order by o.id';
const INNER_MANY='select o from PerformanceOwner o join fetch o.items where o.id >= :floor and o.id <= :ceiling order by o.id';
const TO_ONE='select o from FetchSnapshotOptional o left join fetch o.owner where o.id >= ?1 order by o.id';
const BOUNDS={':floor':'19101',':ceiling':'19102'};
const FIXTURE_IDS=[19101,19102,19103];
const SOURCE_MARKER='join fetch o.items';

async function clean(db){
  await db.execute('DELETE FROM rb_fetch_snapshot_optional WHERE id IN (19101,19102)');
  await db.execute('DELETE FROM rb_perf_item WHERE owner_id IN (19101,19102,19103)');
  await db.execute('DELETE FROM rb_perf_owner WHERE id IN (19101,19102,19103)');
}

async function setup(db){
  const [[{count}]]=await db.execute('SELECT COUNT(*) AS count FROM rb_perf_owner WHERE id IN (19101,19102,19103)');
  assert.equal(Number(count),0,'Fixture already contains reserved fetch snapshot identities');
  const [[{count:other}]]=await db.execute('SELECT COUNT(*) AS count FROM rb_fetch_snapshot_optional WHERE id IN (19101,19102)');
  assert.equal(Number(other),0);
  await db.beginTransaction();
  try{
    await db.execute('INSERT INTO rb_perf_owner (id) VALUES (?),(?),(?)',FIXTURE_IDS);
    const rows=[
      ...Array.from({length:18},(_,index)=>[19101000+index,19101,index<3?null:'item '+index]),
      ...Array.from({length:513},(_,index)=>[19103000+index,19103,'overflow'])
    ];
    for(let i=0;i<rows.length;i+=100){
      const batch=rows.slice(i,i+100);
      await db.execute('INSERT INTO rb_perf_item (id,owner_id,snapshotLabel) VALUES '+batch.map(()=>'(?,?,?)').join(','),batch.flat());
    }
    await db.execute('INSERT INTO rb_fetch_snapshot_optional (id,enabled,owner_id) VALUES (19101,TRUE,19101),(19102,NULL,NULL)');
    await db.commit();
  }catch(error){await db.rollback();throw error;}
}

function statementCount(snapshot,factoryId){
  const stats=snapshot.factories.find(item=>item.id===factoryId).statistics;
  assert.equal(stats.enabled,true);
  return stats.prepareStatementCount;
}

async function verify(client,config,db){
  const observed=await client.refresh();
  assert.equal(observed.consoleSelectEnabled,true);
  assert.equal(observed.consoleFetchSnapshotsEnabled,true);
  const factory=observed.factories.find(item=>item.entities?.some(entity=>entity.javaType==='fixture.boot.PerformanceOwner'));
  assert.ok(factory);
  const factoryId=factory.id;
  const many=await client.describeSelect(LEFT_MANY,factoryId);
  assert.equal(many.state,'described',JSON.stringify(many));
  assert.equal(many.fetchSnapshot.path,'fixture.boot.PerformanceOwner.items');
  assert.equal(many.fetchSnapshot.toMany,true);
  assert.deepEqual(many.parameters.map(item=>item.javaType),['java.lang.Long','java.lang.Long']);
  assert.deepEqual(many.fetchSnapshot.columns,[{alias:'id',javaType:'java.lang.Long'},{alias:'snapshotLabel',javaType:'java.lang.String'}]);
  assert.equal(statementCount(await client.refresh(),factoryId),statementCount(observed,factoryId));

  const read=async(query,bindings,limit)=>{
    const before=statementCount(await client.refresh(),factoryId);
    const result=await client.select(query,factoryId,bindings,limit);
    assert.equal(result.state,'executed',JSON.stringify(result));
    assert.equal(statementCount(await client.refresh(),factoryId)-before,1,'Hydration must prepare one SELECT exactly');
    assert.ok(result.databaseReadOnlyTransaction && result.rolledBack);
    assert.equal(result.boundParameterValuesRetained,false);
    return result;
  };

  const left=await read(LEFT_MANY,BOUNDS,4);
  assert.deepEqual(left.rows,[['19101'],['19102']]);
  assert.equal(left.fetchSnapshot.joinedRows,19);
  assert.equal(left.fetchSnapshot.linked[0].state,'loaded');
  assert.equal(left.fetchSnapshot.linked[0].rows.length,16);
  assert.equal(left.fetchSnapshot.linked[0].hasMore,true);
  assert.ok(left.fetchSnapshot.linked[0].rows.some(([,label])=>label===null));
  assert.deepEqual(left.fetchSnapshot.linked[1],{state:'loaded',rows:[],hasMore:false});
  const clipped=await read(LEFT_MANY,BOUNDS,1);
  assert.deepEqual(clipped.rows,[['19101']]);
  assert.equal(clipped.hasMore,true);
  assert.equal(clipped.fetchSnapshot.linked[0].rows.length,16);
  const inner=await read(INNER_MANY,BOUNDS,4);
  assert.deepEqual(inner.rows,[['19101']]);
  assert.equal(inner.fetchSnapshot.joinedRows,18);

  const one=await client.describeSelect(TO_ONE,factoryId);
  assert.equal(one.state,'described');
  assert.equal(one.fetchSnapshot.path,'fixture.boot.FetchSnapshotOptional.owner');
  assert.equal(one.fetchSnapshot.toMany,false);
  assert.deepEqual(one.parameters,[{key:'?1',javaType:'java.lang.Long'}]);
  const optional=await read(TO_ONE,{'?1':'19101'},4);
  assert.deepEqual(optional.rows,[['19101',true],['19102',null]]);
  assert.deepEqual(optional.fetchSnapshot.linked,[{state:'loaded',rows:[['19101']],hasMore:false},{state:'null',rows:[],hasMore:false}]);
  assert.deepEqual(optional.fetchSnapshot.columns,[{alias:'id',javaType:'java.lang.Long'}]);

  const exceptions=[
    ['select o from FetchSnapshotCallback o join fetch o.owner','custom_fetch_lifecycle'],
    ['select o from FetchSnapshotPolymorphic o join fetch o.owner','custom_fetch_lifecycle'],
    ['select o from PerformanceOwner o join fetch o.items i','unsupported_fetch_shape'],
    ['select o from PerformanceOwner o join fetch o.items join fetch o.items','unsupported_fetch_shape'],
    ['select o from PerformanceOwner o','scalar_projection_required']
  ];
  const before=statementCount(await client.refresh(),factoryId);
  for(const [query,code] of exceptions){
    assert.deepEqual(await client.describeSelect(query,factoryId),{state:'rejected',code});
    assert.deepEqual(await client.select(query,factoryId,{},4),{state:'rejected',code});
  }
  assert.deepEqual(await client.select(LEFT_MANY,factoryId,BOUNDS,26),{state:'rejected',code:'fetch_root_limit'});
  assert.equal(statementCount(await client.refresh(),factoryId),before);

  const overflow=await client.select(LEFT_MANY,factoryId,{':floor':'19103',':ceiling':'19103'},1);
  assert.deepEqual(overflow,{state:'rejected',code:'fetch_joined_row_limit'});
  assert.equal(statementCount(await client.refresh(),factoryId)-before,1);
  const recovered=await read(TO_ONE,{'?1':'19102'},1);
  assert.deepEqual(recovered.fetchSnapshot.linked,[{state:'null',rows:[],hasMore:false}]);
  const scalar=await read('select p.displayName from Person p order by p.id',{},4);
  assert.deepEqual(scalar.rows,[['Alex'],['Mina']]);
  assert.equal(scalar.fetchSnapshot,undefined);
  const snapshot=await client.refresh();
  assert.equal(snapshot.events.some(item=>[LEFT_MANY,INNER_MANY,TO_ONE].includes(item.query)),false);
  const [[{version,count}]]=await db.execute('SELECT VERSION() AS version, COUNT(*) AS count FROM rb_perf_item WHERE owner_id IN (19101,19102,19103)');
  assert.equal(Number(count),531);
  assert.equal(/mariadb/i.test(version),config.dbEngine==='mariadb');
  return {factoryId,report:{engine:config.dbEngine,version,providerVersion:factory.version,leftRows:left.rowCount,innerRows:inner.rowCount,
    nullableToOne:optional.fetchSnapshot.linked[1].state==='null',emptyCollection:true,limitedChildren:16,rootTruncation:true,
    physicalLimitRejected:true,onePreparedSelect:true,callbackRejectedBeforeSql:true,polymorphicLoadRejectedBeforeSql:true,
    scalarPreserved:true,fixtureRowsPreserved:true}};
}

async function withFixture(operation){
  const {config,database,token}=readConfig();
  const db=await mysql.createConnection(database),client=new ObserverClient({url:config.observerUrl,token,timeoutMs:15000});
  let seeded=false;
  try{
    await setup(db);seeded=true;
    return await operation({config,token,client,db});
  }finally{
    client.dispose();
    try{if(seeded)await clean(db);}finally{await db.end();}
  }
}

async function runJpqlFetchSnapshotChecks(api,vscode,checks){
  return withFixture(async({config,token,client,db})=>{
    const {factoryId,report}=await verify(client,config,db);
    const prepared=await vscode.commands.executeCommand('rocketbrain.jpa.observer.prepare');
    assert.equal(prepared?.consoleFetchSnapshotsEnabled,false);
    assert.equal(JSON.parse(fs.readFileSync(prepared.configFile,'utf8')).consoleFetchSnapshots,false);
    try{
      await api.jpa.observer.connect({url:config.observerUrl,token,timeoutMs:15000});
      const result=await vscode.commands.executeCommand('rocketbrain.jpa.console.run',{approved:true,query:LEFT_MANY,factoryId,values:BOUNDS,limit:2});
      assert.equal(result?.view,'rocketbrain.jpql.result');
      assert.equal(result.fetchSnapshot.path,'fixture.boot.PerformanceOwner.items');
      assert.equal(result.fetchSnapshot.linked[0].hasMore,true);
      const opened=()=>vscode.window.tabGroups.all.some(group=>group.tabs.some(tab=>tab.label==='JPQL Results'));
      const deadline=Date.now()+3000;
      while(!opened()&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,50));
      assert.ok(opened());

      const files=await vscode.workspace.findFiles('**/fixture/boot/FetchProbe.java','**/{build,target,test-output}/**',8);
      assert.equal(files.length,1,'Native source test requires one Spring fixture workspace copy');
      const document=await vscode.workspace.openTextDocument(files[0]), text=document.getText();
      const marker=text.indexOf(SOURCE_MARKER);
      assert.notEqual(marker,-1);
      await api.jpa.refresh();
      const definitions=await vscode.commands.executeCommand('vscode.executeDefinitionProvider',document.uri,
        document.positionAt(marker+SOURCE_MARKER.length-2));
      assert.ok(definitions.some(item=>{
        const target=item.uri||item.targetUri, range=item.range||item.targetSelectionRange;
        return target.toString()===document.uri.toString() && document.getText(range)==='items';
      }));
      checks.push('The installed JPQL console previews an initialized FETCH JOIN association from one read-only SELECT and navigates its path to the mapped source field.');
      return {...report,nativeView:true,nativeSourceNavigation:true};
    }finally{api.jpa.observer.disconnect();}
  });
}

module.exports={runJpqlFetchSnapshotChecks};
if(require.main===module)withFixture(async({config,client,db})=>({...((await verify(client,config,db)).report),nativeView:false}))
  .then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error.stack);process.exitCode=1;});
