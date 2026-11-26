'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const {randomBytes}=require('node:crypto');
const {owned}=require('./schema-stored-diff-host');
const {ObserverClient}=require('../src/jpa/observer-client');
const {summarizePerformance}=require('../src/jpa/fetch-performance');
const {jdbcReadback}=require('./java-source-analysis-host');

const endpoints=['lazy','join','manual'];
const route=name=>'/probe/hibernate-composite-fetch/'+name;

async function withFixture(run){
  const env=process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG;
  const runtime=JSON.parse(await fs.readFile(env,'utf8'));
  assert.equal(runtime.dbEngine,process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE);
  assert.match(runtime.baseUrl,/^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(runtime.observerUrl,/^http:\/\/127\.0\.0\.1:\d+$/);
  const token=(await fs.readFile(runtime.observerTokenFile,'utf8')).trim();
  const {actor}=await owned(runtime.dbConfigPath);
  const secrets=['tenant-α-'+randomBytes(8).toString('hex'),'tenant-β-'+randomBytes(8).toString('hex')];
  const ids=[481725139,481725140];
  const owners=[[secrets[0],ids[0]],[secrets[1],ids[0]],[secrets[1],ids[1]]];
  const children=owners.flatMap(([realm,number],index)=>[[2*index+1,realm,number],[2*index+2,realm,number]]);
  let seeded=false;
  try {
    await actor.beginTransaction();
    try {
      await actor.query('INSERT INTO rb_perf_composite_owner (owner_realm,owner_number) VALUES ?', [owners]);
      await actor.query('INSERT INTO rb_perf_composite_item (id,realm_ref,number_ref) VALUES ?', [children]);
      await actor.commit();
      seeded=true;
    }catch(error){await actor.rollback();throw error;}
    const requestMarker=randomBytes(16).toString('hex');
    async function invoke(){
      for(const name of endpoints){
        const response=await fetch(runtime.baseUrl+route(name)+'?marker='+requestMarker,{
          signal:AbortSignal.timeout(12000),redirect:'error'
        });
        assert.equal(response.status,200,name);
        assert.deepEqual(await response.json(),{owners:3,items:6});
      }
    }
    const verified=await run({runtime,token,invoke,secrets:[...secrets,...ids,token,requestMarker]});
    return {...verified,engine:runtime.dbEngine,jdbc:await jdbcReadback()};
  }finally{
    try {
      if(seeded){
        await actor.query('DELETE FROM rb_perf_composite_item WHERE id IN (?)',[children.map(row=>row[0])]);
        await actor.query('DELETE FROM rb_perf_composite_owner WHERE owner_realm IN (?)',[secrets]);
      }
    } finally {await actor.end();}
  }
}

function verifyReports(observer,report,secrets){
  assert.equal(observer.performance.available,true,JSON.stringify(observer.warnings));
  assert.equal(observer.performance.rawBindValuesRetained,false);
  assert.equal(observer.performance.observerExecutedSql,false);
  const [lazy,joined,manual]=endpoints.map(name=>report.requests.find(row=>row.route===route(name)));
  assert.ok(lazy&&joined&&manual);
  assert.deepEqual([lazy.selectCount,joined.selectCount,manual.selectCount],[4,1,4],JSON.stringify(report.requests));
  assert.deepEqual([lazy.coverage,joined.coverage,manual.coverage],Array(3).fill('complete-within-supported-hooks'),
    JSON.stringify(report.requests));
  assert.deepEqual([lazy.suspects.length,joined.suspects.length,manual.suspects.length],[1,0,0],JSON.stringify(lazy));
  const [match]=lazy.suspects;
  assert.equal(match.collectionRole,'fixture.boot.CompositeFetchOwner.items');
  assert.deepEqual(match.keyColumns.slice().sort(),['number_ref','realm_ref']);
  assert.equal(match.child.distinctOwnerKeys,3);
  assert.deepEqual(match.child.sequences,[2,3,4]);
  assert.ok(match.child.totalDurationMicros>=0);
  assert.equal(report.bindObservation,'hibernate-jdbc-setters-v1');
  const types=sql=>Array.from(sql.slice(sql.toLowerCase().indexOf(' where ')).matchAll(/\b(number_ref|realm_ref)\b/gu),
    ([,name],index)=>({index:index+1,jdbcType:name==='number_ref'?'BIGINT':'VARCHAR',source:'setter'}));
  for(const request of [lazy,manual]){
    assert.deepEqual(request.selects[0].binds,{state:'complete',placeholders:0,positions:[]});
    for(const select of request.selects.slice(1)){
      const positions=types(select.sql);
      assert.equal(positions.length,2,select.sql);
      assert.deepEqual(select.binds,{state:'complete',placeholders:2,positions},JSON.stringify(select));
    }
  }
  assert.deepEqual(joined.selects[0].binds,{state:'complete',placeholders:0,positions:[]});
  const serialized=JSON.stringify({observer:observer.performance,report});
  for(const secret of secrets) assert.ok(!serialized.includes(String(secret)),'A runtime key or request value reached the report.');
  return {request:lazy.id,counts:[4,1,4],findings:[1,0,0],distinctOwnerKeys:3,
    keyColumns:match.keyColumns,typedPositions:lazy.selects[1].binds.positions,typedSelects:6,
    bindValuesRetained:false,observerExecutedSql:false};
}

async function runHibernateCompositeFetchChecks(api,vscode,checks){
  const observer=api.jpa.observer;
  const proof=await withFixture(async fixture=>{
    try {
      await observer.connect({url:fixture.runtime.observerUrl,token:fixture.token});
      await fixture.invoke();
      const snapshot=await observer.refresh(), report=observer.performance();
      const observed=verifyReports(snapshot,report,fixture.secrets);
      const shown=await vscode.commands.executeCommand('rocketbrain.jpa.observer.inspectPerformance',observed.request);
      assert.deepEqual(shown.request.suspects[0].keyColumns,observed.keyColumns);
      assert.deepEqual(shown.request.selects[1].binds.positions,observed.typedPositions);
      assert.deepEqual(JSON.parse(vscode.window.activeTextEditor.document.getText()),JSON.parse(JSON.stringify(shown)));
      return {...observed,nativeCompositeReport:true};
    }finally{observer.disconnect();}
  });
  checks.push('Real Hibernate lazy collection loads with two key columns were separated from a fetch join and repeated manual reads. The installed report showed exact JDBC positions and types without bind values.');
  return proof;
}

module.exports={runHibernateCompositeFetchChecks};
if(require.main===module)withFixture(async fixture=>{
  const observer=new ObserverClient({url:fixture.runtime.observerUrl,token:fixture.token});
  try{
    await fixture.invoke();
    const snapshot=await observer.refresh();
    return verifyReports(snapshot,summarizePerformance(snapshot.performance),fixture.secrets);
  }finally{observer.dispose();}
}).then(result=>console.log(JSON.stringify(result)),error=>{console.error(error.stack);process.exitCode=1;});
