'use strict';

const assert=require('node:assert/strict');
const mysql=require('mysql2/promise');
const { ObserverClient }=require('../src/jpa/observer-client');
const { readConfig }=require('./jpql-console-host');

const root='select o from DirectFetchOwner o', scope=' where o.id >= :first and o.id <= :last order by o.id';
const toOne=root+' left join fetch o.leftNote join fetch o.rightNote'+scope;
const withBag=root+' join fetch o.leftBag left join fetch o.leftNote'+scope;
const bothSets=root+' left join fetch o.leftSet left join fetch o.rightSet'+scope;
const threePaths=root+' left join fetch o.leftSet left join fetch o.rightSet left join fetch o.leftNote'+scope;
const normal={':first':'22001',':last':'22002'}, overload={':first':'22003',':last':'22003'};
const allowed={label:'<known>', body:'owned'};

async function setup(db) {
  for (const table of ['rb_fetch_multi_bag_left','rb_fetch_multi_bag_right','rb_fetch_multi_member','rb_fetch_multi_owner','rb_fetch_multi_note']) {
    const [[{count}]]=await db.query('SELECT COUNT(*) AS count FROM '+table);
    assert.equal(Number(count),0,'The owned fixture must be empty before seeding');
  }
  await db.beginTransaction();
  try {
    await db.execute('INSERT INTO rb_fetch_multi_note (id,body) VALUES (22101,?),(22102,NULL)',[allowed.body]);
    await db.execute('INSERT INTO rb_fetch_multi_owner (id,left_note_id,right_note_id) VALUES (22001,22101,22102),(22002,NULL,22102),(22003,NULL,NULL)');
    await db.execute('INSERT INTO rb_fetch_multi_member (id,label,left_owner_id,right_owner_id) VALUES (22201,?,22001,NULL),(22202,NULL,22001,NULL),(22203,NULL,22001,22001),(22204,NULL,NULL,22001)',[allowed.label]);
    await db.execute('INSERT INTO rb_fetch_multi_bag_left (owner_id,member_id) VALUES (22001,22201),(22001,22201),(22001,22204)');
    await db.execute('INSERT INTO rb_fetch_multi_bag_right (owner_id,member_id) VALUES (22001,22204)');
    const product=Array.from({length:24},(_,index)=>[22301+index,22003,22003]);
    await db.execute('INSERT INTO rb_fetch_multi_member (id,left_owner_id,right_owner_id) VALUES '+product.map(()=>'(?,?,?)').join(','),product.flat());
    await db.commit();
  } catch(error) {await db.rollback();throw error;}
}

async function cleanup(db) {
  await db.execute('DELETE FROM rb_fetch_multi_bag_left WHERE owner_id = 22001');
  await db.execute('DELETE FROM rb_fetch_multi_bag_right WHERE owner_id = 22001');
  await db.execute('DELETE FROM rb_fetch_multi_member WHERE id IN (22201,22202,22203,22204) OR id BETWEEN 22301 AND 22324');
  await db.execute('DELETE FROM rb_fetch_multi_owner WHERE id IN (22001,22002,22003)');
  await db.execute('DELETE FROM rb_fetch_multi_note WHERE id IN (22101,22102)');
}

const linkedIds=(path,index)=>path.linked[index].rows.map(row=>row[0]).sort();

async function verify({config,db,client}) {
  const snapshot=await client.refresh();
  assert.equal(snapshot.agentVersion,require('../scripts/jpa-observer-build').VERSION);
  assert.equal(snapshot.consoleFetchSnapshotsEnabled,true);
  const factory=snapshot.factories.find(f=>f.entities.some(e=>e.javaType==='fixture.multifetch.DirectFetchOwner'));
  assert.ok(factory);
  const count=async()=>{
    const stats=(await client.refresh()).factories.find(f=>f.id===factory.id).statistics;
    assert.equal(stats.enabled,true);
    return stats.prepareStatementCount;
  };
  const read=async(query,values=normal,limit=10)=>{
    const before=await count();
    const result=await client.select(query,factory.id,values,limit);
    assert.equal(result.state,'executed',JSON.stringify(result));
    assert.equal(result.databaseReadOnlyTransaction,true);
    assert.equal(result.rolledBack,true);
    assert.equal(result.boundParameterValuesRetained,false);
    assert.equal(await count()-before,1,'The multi-fetch must prepare exactly one JDBC SELECT');
    return result;
  };
  const before=await count();
  const described=await client.describeSelect(threePaths,factory.id);
  assert.equal(described.state,'described',JSON.stringify(described));
  assert.equal(described.fetchSnapshot,undefined);
  assert.deepEqual(described.fetchSnapshots.associations.map(item=>[item.path,item.collection??null]),[
    ['fixture.multifetch.DirectFetchOwner.leftSet','SET'],['fixture.multifetch.DirectFetchOwner.rightSet','SET'],
    ['fixture.multifetch.DirectFetchOwner.leftNote',null]
  ]);
  assert.ok(described.fetchSnapshots.associations.every(item=>item.linked===undefined));
  assert.equal(await count(),before);

  const refs=await read(toOne);
  assert.deepEqual(refs.rows,[['22001'],['22002']]);
  assert.equal(refs.fetchSnapshots.joinedRows,2);
  const [leftNote,rightNote]=refs.fetchSnapshots.associations;
  assert.deepEqual(leftNote.linked.map(item=>item.rows),[[['22101',allowed.body]],[]]);
  assert.equal(leftNote.linked[1].state,'null');
  assert.deepEqual(rightNote.linked.map(item=>item.rows),[[['22102',null]],[['22102',null]]]);

  const bag=await read(withBag);
  assert.deepEqual(bag.rows,[['22001']]);
  assert.equal(bag.fetchSnapshots.joinedRows,3);
  assert.equal(bag.fetchSnapshots.associations[0].collection,'BAG');
  assert.deepEqual(linkedIds(bag.fetchSnapshots.associations[0],0),['22201','22201','22204']);

  const pair=await read(bothSets);
  assert.equal(pair.fetchSnapshots.joinedRows,7);
  const [left,right]=pair.fetchSnapshots.associations;
  assert.deepEqual(linkedIds(left,0),['22201','22202','22203']);
  assert.deepEqual(linkedIds(right,0),['22203','22204']);
  assert.deepEqual(left.linked[1],{state:'loaded',rows:[],hasMore:false});
  assert.deepEqual(right.linked[1],{state:'loaded',rows:[],hasMore:false});
  const triple=await read(threePaths,normal,1);
  assert.deepEqual(triple.rows,[['22001']]);
  assert.equal(triple.hasMore,true);
  assert.equal(triple.fetchSnapshots.associations.length,3);
  assert.deepEqual(linkedIds(triple.fetchSnapshots.associations[0],0),['22201','22202','22203']);

  const negative=await count();
  for(const joins of ['join fetch o.leftBag join fetch o.rightBag','join fetch o.leftBag join fetch o.leftSet']) {
    const query=root+' '+joins+scope;
    const rejected={state:'rejected',code:'fetch_parallel_collections'};
    assert.deepEqual(await client.describeSelect(query,factory.id),rejected);
    assert.deepEqual(await client.select(query,factory.id,normal,10),rejected);
  }
  for(const joins of ['join fetch o.leftSet join fetch o.leftSet','join fetch o.leftSet s join fetch s.leftOwner',
    'join fetch o.leftSet join fetch o.rightSet join fetch o.leftNote join fetch o.rightNote'])
    assert.deepEqual(await client.select(root+' '+joins+scope,factory.id,normal,10),{state:'rejected',code:'unsupported_fetch_shape'});
  assert.equal(await count(),negative);
  assert.deepEqual(await client.select(bothSets,factory.id,overload,1),{state:'rejected',code:'fetch_joined_row_limit'});
  assert.equal(await count(),negative+1);
  const empty=await read(bothSets,{':first':'22099',':last':'22099'});
  assert.deepEqual(empty.rows,[]);
  assert.equal(empty.fetchSnapshots.joinedRows,0);
  assert.ok(empty.fetchSnapshots.associations.every(item=>item.linked.length===0));
  const existing=await read(root+' left join fetch o.leftNote'+scope);
  assert.equal(existing.fetchSnapshot.path,'fixture.multifetch.DirectFetchOwner.leftNote');
  assert.equal(existing.fetchSnapshots,undefined);
  const legacyBag=await read(root+' join fetch o.leftBag'+scope);
  assert.equal(legacyBag.fetchSnapshot.collection,undefined);
  assert.deepEqual(linkedIds(legacyBag.fetchSnapshot,0),['22201','22201','22204']);
  assert.deepEqual((await read('select p.displayName from Person p order by p.id',{})).rows,[['Alex'],['Mina']]);

  const [[{version,bags}]]=await db.query('SELECT VERSION() AS version,(SELECT COUNT(*) FROM rb_fetch_multi_bag_left WHERE owner_id = 22001) AS bags');
  assert.equal(/mariadb/i.test(version),config.dbEngine==='mariadb');
  assert.equal(Number(bags),3);
  return {factoryId:factory.id,report:{engine:config.dbEngine,version,provider:factory.version,nullableToOnePaths:2,trueBagMultiplicity:true,
    parallelSetRows:pair.fetchSnapshots.joinedRows,uniqueSetIdentity:true,threePaths:true,rootTruncation:true,cartesianLimitRefused:true,
    invalidCombinationsRejectedBeforeSql:true,onePreparedSelect:true,readOnlyRollback:true,singlePathPreserved:true,scalarPreserved:true,fixtureRowsPreserved:true}};
}

async function withFixture(action) {
  const {config,token,database}=readConfig();
  const db=await mysql.createConnection(database),client=new ObserverClient({url:config.observerUrl,token,timeoutMs:15000});
  let seeded=false;
  try {await setup(db);seeded=true;return await action({config,token,db,client});}
  finally {client.dispose();try{if(seeded)await cleanup(db);}finally{await db.end();}}
}

async function runJpaMultiFetchChecks(api,vscode,checks) {
  return withFixture(async fixture=>{
    const {factoryId,report}=await verify(fixture);
    try {
      await api.jpa.observer.connect({url:fixture.config.observerUrl,token:fixture.token,timeoutMs:15000});
      const selection=await vscode.commands.executeCommand('rocketbrain.jpa.console.run',{query:threePaths,approved:true,factoryId,values:normal,limit:2});
      assert.equal(selection?.view,'rocketbrain.jpql.result');
      assert.equal(selection.fetchSnapshots.associations.length,3);
      assert.deepEqual(linkedIds(selection.fetchSnapshots.associations[0],0),['22201','22202','22203']);
      const tab=()=>vscode.window.tabGroups.all.some(group=>group.tabs.some(item=>item.label==='JPQL Results'));
      const deadline=Date.now()+5000;
      while(!tab()&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,50));
      assert.ok(tab());
      checks.push('The installed JPQL console reviews three direct fetch paths, presents two independent Set previews with unique identities, and excludes unsafe parallel bag combinations.');
      return {...report,nativeMultiFetch:true};
    } finally {api.jpa.observer.disconnect();}
  });
}

module.exports={runJpaMultiFetchChecks};
if(require.main===module)withFixture(async fixture=>({...((await verify(fixture)).report),nativeMultiFetch:false}))
  .then(report=>console.log(JSON.stringify(report))).catch(error=>{console.error(error.stack);process.exitCode=1;});
