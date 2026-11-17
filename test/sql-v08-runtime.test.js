'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {analyzeSql,completionsAt,definitionsAt}=require('../src/db/sql-analysis');
const {MysqlService}=require('../src/db/mysql');
const configFile=process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG||process.env.ROCKETBRAIN_SPRING_RUNTIME_CONFIG;
const runtime=configFile?JSON.parse(fs.readFileSync(configFile,'utf8')):null;
const live=(name,fn)=>test(name,{skip:!runtime&&'Use spring-project.js run --engine mysql|mariadb -- --test test/sql-v08-runtime.test.js.',timeout:90000},fn);
const quote=name=>'`'+name.replaceAll('`','``')+'`';
async function fixtureNames(){
  if(runtime.naming==='opaque'){
    assert.ok(runtime.observerUrl&&runtime.observerTokenFile,'opaque SQL fixture needs explicit provider observation');
    const app=await fetch(runtime.baseUrl+'/probe/provider',{signal:AbortSignal.timeout(20000)});assert.equal(app.status,200);
    const token=fs.readFileSync(runtime.observerTokenFile,'utf8').trim(),response=await fetch(runtime.observerUrl+'/snapshot',{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(20000)});assert.equal(response.status,200);
    const factory=(await response.json()).factories.find(f=>f.entities?.some(e=>e.name==='Person'));assert.ok(factory);
    const find=(entity,property)=>{const e=factory.entities.find(e=>e.name===entity),c=e.physicalMappings.find(m=>m.property===property)?.columns?.[0];assert.ok(c?.table&&c?.column,entity+'.'+property);return c;};
    const person=find('Person','displayName'),department=find('Department','name');
    return {person:person.table,department:department.table,id:find('Person','id').column,name:person.column,departmentId:find('Person','department').column,departmentPk:find('Department','id').column,departmentName:department.column};
  }
  const custom=runtime.naming==='custom',col=name=>custom?'c_'+name:name;
  return {person:(custom?'v6_':'')+'rb_spring_person',department:(custom?'v6_':'')+'rb_spring_department',id:col('id'),name:col('display_name'),departmentId:col('department_id'),departmentPk:col('id'),departmentName:col('name')};
}
function record(value){const file=path.resolve('test-output/'+(process.env.ROCKETBRAIN_TEST_REPORT_PREFIX||"v0.8")+'-sql-runtime-'+runtime.dbEngine+'-'+(runtime.naming||'standard')+'.json'),serialized=JSON.stringify({asOf:new Date().toISOString(),engine:runtime.dbEngine,naming:runtime.naming||'standard',...value},null,2);const config=JSON.parse(fs.readFileSync(runtime.dbConfigPath));assert.ok(!serialized.includes(config.password));if(runtime.observerTokenFile)assert.ok(!serialized.includes(fs.readFileSync(runtime.observerTokenFile,'utf8').trim()));fs.writeFileSync(file,serialized+'\n');}
live('complex SQL binder agrees with real Spring data for CTE/derived/correlated/UNION queries and server name errors',async()=>{
  const config=JSON.parse(fs.readFileSync(runtime.dbConfigPath,'utf8')),service=new MysqlService(config),n=await fixtureNames();
  try{
    const catalog=await service.metadata(),options={dialect:runtime.dbEngine==='mariadb'?'mariadb':'mysql',database:catalog.database,catalogComplete:true,sqlMode:[],tableNameCaseSensitive:true};
    const p=quote(n.person),d=quote(n.department),id=quote(n.id),name=quote(n.name),fk=quote(n.departmentId),dpk=quote(n.departmentPk),dn=quote(n.departmentName);
    const statements={
      cte:`WITH labels AS (SELECT p.${id} AS id,p.${name} AS label FROM ${p} p), chosen(person_id,person_label) AS (SELECT l.id,l.label FROM labels l) SELECT c.person_label FROM chosen c ORDER BY c.person_id`,
      derived:`SELECT v.label FROM (SELECT p.${id} AS id,p.${name} AS label FROM ${p} p) v ORDER BY v.id`,
      correlated:`SELECT p.${name} AS label FROM ${p} p WHERE EXISTS (SELECT 1 FROM ${d} d WHERE d.${dpk}=p.${fk} AND d.${dn}='Engineering') ORDER BY p.${id}`,
      shadowed:`SELECT p.${name} AS label FROM ${p} p WHERE EXISTS (SELECT 1 FROM ${d} p WHERE p.${dn}='Engineering') ORDER BY p.${id}`,
      union:`SELECT p.${name} AS label FROM ${p} p UNION ALL SELECT d.${dn} AS other_name FROM ${d} d ORDER BY label`,
      arithmetic:`SELECT p.${id}+1 AS next_id,LOWER(p.${name}) AS lower_name FROM ${p} p ORDER BY p.${id}`,
      aggregate:`SELECT COUNT(*) AS total,SUM(p.${id}) AS total_id,MIN(p.${name}) AS minimum_name FROM ${p} p`,
      emptyAggregate:`SELECT MAX(p.${id}) AS maximum_id,COUNT(*) AS total FROM ${p} p WHERE p.${id}<0`,
      quotedAlias:`SELECT p.${name} AS \`from\` FROM ${p} p ORDER BY \`from\``,
      literalDelimiters:"SELECT 'FROM' AS keyword,',' AS comma,'(' AS paren,';' AS delimiter",
      recursive:'WITH RECURSIVE nums(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM nums WHERE n<3) SELECT n FROM nums ORDER BY n',
      coercion:`SELECT p.${name}+1 AS coerced FROM ${p} p ORDER BY p.${id}`,
      missing:`SELECT p.missing_static_column FROM ${p} p`,
      ambiguous:`SELECT ${id} FROM ${p} p JOIN ${d} d ON p.${fk}=d.${dpk}`,
      unionArity:`SELECT p.${id},p.${name} FROM ${p} p UNION SELECT d.${dpk} FROM ${d} d`,
      functionArity:`SELECT LOWER(p.${id},p.${name}) FROM ${p} p`
    },models={},results={},errors={};
    for(const [name,sql]of Object.entries(statements)){
      const model=analyzeSql(sql,catalog,options);models[name]={state:model.state,projections:model.projections,diagnostics:model.diagnostics,coverage:model.coverage,validityVerified:model.validityVerified,executedSql:model.executedSql};
      if(['missing','ambiguous','unionArity','functionArity'].includes(name)){
        assert.equal(model.state,'invalid',name+' '+JSON.stringify(model));await assert.rejects(()=>service.query(sql),error=>{errors[name]=error.code;return ['ER_BAD_FIELD_ERROR','ER_NON_UNIQ_ERROR','ER_WRONG_NUMBER_OF_COLUMNS_IN_SELECT','ER_WRONG_PARAMCOUNT_TO_NATIVE_FCT'].includes(error.code);});
      }else{assert.equal(model.state,['recursive','coercion'].includes(name)?'unknown':'known',name+' '+JSON.stringify(model));results[name]=await service.query(sql);}
    }
    for(const name of ['cte','derived','correlated','shadowed'])assert.deepEqual(results[name].rows,[['Alex'],['Mina']]);
    assert.deepEqual(results.union.rows,[['Alex'],['Engineering'],['Mina']]);assert.deepEqual(results.arithmetic.rows.map(r=>[Number(r[0]),r[1]]),[[2,'alex'],[3,'mina']]);
    assert.deepEqual(results.aggregate.rows.map(r=>[Number(r[0]),Number(r[1]),r[2]]),[[2,3,'Alex']]);assert.deepEqual(results.recursive.rows.map(r=>Number(r[0])),[1,2,3]);assert.deepEqual(results.coercion.rows.map(r=>Number(r[0])),[1,1]);
    assert.equal(models.emptyAggregate.projections[0].type.nullable,true);assert.equal(models.emptyAggregate.projections[1].type.nullable,false);assert.deepEqual(results.emptyAggregate.rows.map(r=>[r[0],Number(r[1])]),[[null,0]]);
    assert.deepEqual(results.quotedAlias.rows,[['Alex'],['Mina']]);assert.deepEqual(results.literalDelimiters.rows,[['FROM',',','(',';']]);
    const cteModel=analyzeSql(statements.cte,catalog,options),lastRef=statements.cte.lastIndexOf('c.person_label')+3;assert.ok(definitionsAt(cteModel,lastRef).length);
    const incomplete=statements.derived.replace('v.label','v.la'),completion=completionsAt(analyzeSql(incomplete,catalog,options),incomplete.indexOf('v.la')+4);assert.deepEqual(completion.map(i=>i.label),['label']);
    record({providerDatabase:runtime.dbEngine,names:n,models,rows:Object.fromEntries(Object.entries(results).map(([name,r])=>[name,r.rows])),errors,localDefinitionsVerified:true,derivedCompletionVerified:true,scope:'Independent bounded static SELECT analysis against actual Spring-owned entity data. Analysis invokes no SQL; explicit test execution runs read-only SELECTs separately. Recursive growth and implicit coercion remain unknown.'});
  }finally{await service.dispose();}
});
