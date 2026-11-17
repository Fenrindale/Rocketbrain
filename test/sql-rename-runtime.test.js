'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {planSqlRename}=require('../src/db/sql-rename'),{MysqlService}=require('../src/db/mysql');
const configFile=process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG||process.env.ROCKETBRAIN_SPRING_RUNTIME_CONFIG;
const runtime=configFile?JSON.parse(fs.readFileSync(configFile,'utf8')):null;
const quote=name=>'`'+name.replaceAll('`','``')+'`';
async function fixtureNames(){
  if(runtime.naming==='opaque'){
    assert.ok(runtime.observerUrl&&runtime.observerTokenFile);assert.equal((await fetch(runtime.baseUrl+'/probe/provider',{signal:AbortSignal.timeout(20000)})).status,200);
    const token=fs.readFileSync(runtime.observerTokenFile,'utf8').trim(),response=await fetch(runtime.observerUrl+'/snapshot',{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(20000)});assert.equal(response.status,200);
    const factory=(await response.json()).factories.find(f=>f.entities?.some(e=>e.name==='Person'));
    const find=(entity,property)=>{const value=factory.entities.find(e=>e.name===entity).physicalMappings.find(m=>m.property===property)?.columns?.[0];assert.ok(value?.table&&value?.column);return value;};
    return {person:find('Person','id').table,department:find('Department','id').table,id:find('Person','id').column,name:find('Person','displayName').column,fk:find('Person','department').column,dpk:find('Department','id').column,dn:find('Department','name').column};
  }
  const custom=runtime.naming==='custom',col=name=>custom?'c_'+name:name;
  return {person:(custom?'v6_':'')+'rb_spring_person',department:(custom?'v6_':'')+'rb_spring_department',id:col('id'),name:col('display_name'),fk:col('department_id'),dpk:col('id'),dn:col('name')};
}
test('local SQL rename preserves read-only SELECT results on actual Spring-owned MySQL/MariaDB data',{skip:!runtime&&'Use spring-project.js run --engine mysql|mariadb -- --test test/sql-rename-runtime.test.js',timeout:90000},async()=>{
  const config=JSON.parse(fs.readFileSync(runtime.dbConfigPath,'utf8')),service=new MysqlService(config),n=await fixtureNames();
  try{
    const catalog=await service.metadata(),options={dialect:catalog.dialect,database:catalog.database,catalogComplete:true,sqlMode:catalog.sqlMode,tableNameCaseSensitive:catalog.tableNameCaseSensitive};
    const p=quote(n.person),d=quote(n.department),id=quote(n.id),name=quote(n.name),fk=quote(n.fk),dpk=quote(n.dpk),dn=quote(n.dn);
    const cases=[
      {name:'correlated-relation',sql:`SELECT p.${name} AS label FROM ${p} p WHERE EXISTS (SELECT 1 FROM ${d} d WHERE d.${dpk}=p.${fk}) ORDER BY p.${id}`,target:'p.',rename:'from'},
      {name:'nested-shadow',sql:`SELECT p.${name} AS label FROM ${p} p WHERE EXISTS (SELECT 1 FROM ${d} p WHERE p.${dn}='Engineering') ORDER BY p.${id}`,target:'p.',rename:'people_outer'},
      {name:'cte',sql:`WITH chosen AS (SELECT p.${id} AS id,p.${name} AS label FROM ${p} p) SELECT chosen.label FROM chosen ORDER BY chosen.id`,target:'chosen AS',rename:'select'},
      {name:'cte-output-list',sql:`WITH chosen(person_id,person_name) AS (SELECT p.${id},p.${name} FROM ${p} p) SELECT c.person_name FROM chosen c ORDER BY c.person_id`,target:'person_name)',rename:'사람 이름',header:'사람 이름'},
      {name:'derived-output',sql:`SELECT v.label FROM (SELECT p.${id} AS id,p.${name} AS label FROM ${p} p) v ORDER BY v.id`,target:'v.label',delta:2,rename:'renamed`label',header:'renamed`label'},
      {name:'implicit-output',sql:`SELECT v.${name} FROM (SELECT p.${id},p.${name} FROM ${p} p) v ORDER BY v.${id}`,target:`v.${name}`,delta:2,rename:'person_label',header:'person_label'},
      {name:'union-first-arm',sql:`SELECT p.${name} AS label FROM ${p} p UNION ALL SELECT d.${dn} AS other_name FROM ${d} d ORDER BY label`,target:'label FROM',rename:'order',header:'order'},
      {name:'literal-comment',sql:`SELECT p.${name} AS label FROM ${p} p WHERE p.${name}<>'p.label' /* p.label stays */ ORDER BY p.${id}`,target:'p.',rename:'person_source'}
    ],evidence=[];
    for(const item of cases){
      const before=await service.query(item.sql),plan=planSqlRename(item.sql,catalog,options,item.sql.indexOf(item.target)+(item.delta||0),item.rename),after=await service.query(plan.resultText);
      assert.deepEqual(after.rows,before.rows,item.name);assert.equal(plan.executedSql,false);assert.equal(plan.schemaMutation,false);assert.equal(plan.verification.allOriginalBindingsPreserved,true);if(item.header)assert.equal(after.columns[0],item.header);
      if(item.name==='literal-comment')assert.ok(plan.resultText.includes("'p.label' /* p.label stays */"));
      evidence.push({name:item.name,beforeSql:item.sql,afterSql:plan.resultText,beforeColumns:before.columns,afterColumns:after.columns,rows:after.rows,edits:plan.edits,verification:plan.verification});
    }
    const collision=`SELECT p.${name} AS label FROM ${p} p WHERE EXISTS (SELECT 1 FROM ${d} d WHERE d.${dpk}=p.${fk})`;
    assert.throws(()=>planSqlRename(collision,catalog,options,collision.indexOf('p.'),'d'),error=>['SQL_RENAME_CAPTURE','SQL_RENAME_REBIND'].includes(error.code));
    const duplicate=`SELECT p.${id} AS id,p.${name} AS label FROM ${p} p ORDER BY label`;
    assert.throws(()=>planSqlRename(duplicate,catalog,options,duplicate.indexOf('label FROM'),'id'),error=>error.code==='SQL_RENAME_COLLISION');
    assert.deepEqual((await service.metadata()).tables,catalog.tables,'source rename did not mutate the database schema');
    const serialized=JSON.stringify({asOf:new Date().toISOString(),engine:runtime.dbEngine,naming:runtime.naming||'standard',catalogSqlMode:catalog.sqlMode,names:n,cases:evidence,captureRejected:true,duplicateRejected:true,catalogUnchanged:true,scope:'Statement-local source edits. Explicit test SELECT execution verifies before/after rows; rename planning itself executes no SQL. Physical schema migration and cross-file usages are not implemented.'},null,2);
    assert.ok(!serialized.includes(config.password));if(runtime.observerTokenFile)assert.ok(!serialized.includes(fs.readFileSync(runtime.observerTokenFile,'utf8').trim()));
    fs.writeFileSync(path.resolve('test-output/'+(process.env.ROCKETBRAIN_TEST_REPORT_PREFIX||"v0.9")+'-sql-rename-'+runtime.dbEngine+'-'+(runtime.naming||'standard')+'.json'),serialized+'\n');
  }finally{await service.dispose();}
});
