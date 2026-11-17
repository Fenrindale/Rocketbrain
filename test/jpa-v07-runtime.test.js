'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{pathToFileURL}=require('node:url');
const configFile=process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG||process.env.ROCKETBRAIN_SPRING_RUNTIME_CONFIG;
const runtime=configFile?JSON.parse(fs.readFileSync(configFile,'utf8')):null;
const enabled=Boolean(runtime?.observerUrl&&runtime?.observerTokenFile);
const live=(name,fn)=>test(name,{skip:!enabled&&'Use spring-project.js run --observer --engine mysql|mariadb [--naming opaque] -- --test test/jpa-v07-runtime.test.js.',timeout:90000},fn);
let providerResult;
async function app(route){const r=await fetch(runtime.baseUrl+route,{redirect:'error',signal:AbortSignal.timeout(20000)});assert.equal(r.status,200,route+' status');return r.json();}
async function observer(route,body){
  const token=fs.readFileSync(runtime.observerTokenFile,'utf8').trim();
  const response=await fetch(runtime.observerUrl+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(20000)});
  assert.equal(response.status,200,'observer '+route+' status');return response.json();
}
async function executed(){return providerResult||(providerResult=app('/probe/provider'));}
function choose(snapshot){const factory=snapshot.factories?.find(f=>f.entities?.some(e=>e.name==='Person'));assert.ok(factory,'captured live Person factory');assert.equal(factory.provider,'hibernate');assert.equal(factory.version,'7.4.13.Final');return factory;}
function record(kind,value){
  const file=path.resolve(__dirname,'../test-output/'+(process.env.ROCKETBRAIN_TEST_REPORT_PREFIX||'v0.7')+'-'+kind+'-'+runtime.dbEngine+'-'+(runtime.naming||'standard')+'.json');
  const serialized=JSON.stringify({asOf:new Date().toISOString(),engine:runtime.dbEngine,naming:runtime.naming||'standard',...value},null,2);
  const token=fs.readFileSync(runtime.observerTokenFile,'utf8').trim();assert.ok(!serialized.includes(token),'no authentication token in evidence');
  const db=JSON.parse(fs.readFileSync(runtime.dbConfigPath,'utf8'));assert.ok(!serialized.includes(db.password),'no database password in evidence');fs.writeFileSync(file,serialized+'\n');
}
function javaTypes(result){return result.selectionTypes.map(t=>t.javaType);}
function normalize(name){return typeof name==='string'?name.replace(/^[`"\[]|[`"\]]$/g,''):name;}
function javaFiles(folder){return fs.readdirSync(folder,{withFileTypes:true}).flatMap(e=>{const file=path.join(folder,e.name);return e.isDirectory()?javaFiles(file):e.name.endsWith('.java')?[{uri:pathToFileURL(file).href,text:fs.readFileSync(file,'utf8')}]:[];});}

live('generic live Hibernate observer validates provider HQL and observes arbitrary application-generated queries without executing probe SQL',async()=>{
  const actual=await executed();
  assert.deepEqual(actual.arrayValues,['Alex','Mina']);assert.deepEqual(actual.opaqueValues,['ALEX','MINA']);assert.deepEqual(actual.windowValues,[['Alex',1],['Mina',3]]);
  assert.deepEqual(actual.cteValues,['Alex','Mina']);assert.deepEqual(actual.derivedValues,['Alex','Mina']);for(const name of ['Alex','Mina','Engineering'])assert.ok(actual.unionValues.includes(name));
  const beforeSnapshot=await observer('/snapshot'),before=choose(beforeSnapshot);
  assert.equal(before.statistics?.enabled,true,'fixture statistics must be explicitly enabled; disabled zero counters prove nothing');
  assert.ok(before.statistics.prepareStatementCount>0);assert.ok(before.statistics.queryExecutionCount>0);
  const probes={
    opaque:actual.opaqueQuery,window:actual.windowQuery,cte:actual.cteQuery,union:actual.unionQuery,derived:actual.derivedQuery,
    parameters:'select p.displayName, p.id from Person p where p.id = :id',
    array:'select p.displayName from Person p where p.id in :ids',
    missing:'select p.department.missingObserved from Person p',
    wrongType:'select p.displayName + 1 from Person p',
    bulk:'update Person p set p.displayName = :name where p.id = :id'
  },results={};
  for(const [name,query]of Object.entries(probes))results[name]=await observer('/validate',{query,factoryId:before.id});
  for(const name of ['opaque','window','cte','union','derived','parameters','array','bulk'])assert.equal(results[name].state,'known',name+' '+JSON.stringify(results[name].diagnostics));
  assert.deepEqual(javaTypes(results.opaque),['java.lang.String']);assert.deepEqual(javaTypes(results.window),['java.lang.String','java.lang.Long']);
  for(const name of ['cte','union','derived'])assert.deepEqual(javaTypes(results[name]),['java.lang.String']);
  assert.deepEqual(javaTypes(results.parameters),['java.lang.String','java.lang.Long']);assert.ok(results.parameters.parameters.some(p=>p.name==='id'&&p.javaType==='java.lang.Long'));
  assert.deepEqual(javaTypes(results.array),['java.lang.String']);assert.ok(results.array.parameters.some(p=>p.name==='ids'&&p.javaType==='java.lang.Long'&&p.multiValued===true));
  assert.equal(results.bulk.statementKind,'update');assert.ok(results.bulk.parameters.some(p=>p.name==='name'&&p.javaType==='java.lang.String'));assert.ok(results.bulk.parameters.some(p=>p.name==='id'&&p.javaType==='java.lang.Long'));
  assert.equal(results.missing.state,'invalid');assert.equal(results.wrongType.state,'invalid');
  for(const value of Object.values(results)){assert.equal(value.sqlExecuted,false);assert.equal(value.queryExecuted,false);}
  const afterSnapshot=await observer('/snapshot'),after=choose(afterSnapshot);
  assert.equal(after.statistics.prepareStatementCount,before.statistics.prepareStatementCount,'semantic probes prepare no SQL statements');
  assert.equal(after.statistics.queryExecutionCount,before.statistics.queryExecutionCount,'semantic probes execute no queries');
  const observed=(beforeSnapshot.events||[]).filter(e=>e.query===actual.opaqueQuery&&e.operation==='hql-translate'&&e.state==='translated'&&e.origin==='application');
  assert.ok(observed.length,'instrumentation observes the HQL actually produced by opaque Java/SpEL application code');assert.ok(observed.some(e=>e.metadata?.selectionTypes?.[0]?.javaType==='java.lang.String'));
  const manualEvents=(afterSnapshot.events||[]).filter(e=>e.origin==='explicit-semantic-validation'&&e.operation==='hql-translate');
  for(const query of Object.values(probes))assert.ok(manualEvents.some(e=>e.query===query),'manual semantic probe has separate explicit-validation origin');
  assert.ok(manualEvents.some(e=>e.query===actual.opaqueQuery),'same HQL from application and validation keeps distinct provenance');
  const fn=before.functions.find(f=>f.name==='rb_upper');assert.ok(fn,'custom FunctionContributor registry entry');assert.match(fn.signature||'',/rb_upper/);assert.equal(fn.returns.state,'unknown','display signature does not prove a context-independent return FQN');
  record('runtime-provider',{factoryId:before.id,provider:before.provider,version:before.version,actual,probes:results,function:fn,observedOpaque:observed.map(e=>({operation:e.operation,state:e.state,origin:e.origin,metadata:e.metadata})),manualProbeEvents:manualEvents.map(e=>({operation:e.operation,state:e.state,origin:e.origin,query:e.query,metadata:e.metadata})),sqlCounterBefore:before.statistics,sqlCounterAfter:after.statistics,scope:'Application-origin translation observations and explicit-validation probes have distinct provenance. Application query results are independent evidence; runtime Java/SpEL execution remains application-owned.'});
});

live('generic provider metamodel physical names agree with the real read-only catalog, including opaque naming',async()=>{
  await executed();const snapshot=await observer('/snapshot'),factory=choose(snapshot);
  const {MysqlService}=require('../src/db/mysql'),service=new MysqlService(JSON.parse(fs.readFileSync(runtime.dbConfigPath,'utf8')));
  try{
    const catalog=await service.metadata(),known=[],mismatches=[];
    assert.equal(factory.entities.length,15);
    const add=(entity,property,table,column)=>{if(!table||!column)return;table=normalize(table);column=normalize(column);const observed=catalog.tables.find(t=>normalize(t.name)===table);const item={entity,property,table,column};if(!observed||!observed.columns.some(c=>c.name.toLowerCase()===column.toLowerCase()))mismatches.push(item);else known.push(item);};
    for(const entity of factory.entities){if(entity.abstract&&entity.inheritance==='TABLE_PER_CLASS')continue;for(const key of entity.tableKeys||[])for(const column of key.columns||[])add(entity.name,'<table-key>',key.table,column);for(const mapping of entity.physicalMappings||[]){for(const c of mapping.columns||[])if(!c.formula)add(entity.name,mapping.property,c.table,c.column);if(mapping.collectionTable){for(const c of [...(mapping.ownerColumns||[]),...(mapping.elementColumns||[])])add(entity.name,mapping.property,mapping.collectionTable,c);}}}
    assert.equal(mismatches.length,0,JSON.stringify(mismatches));const distinct=new Set(known.map(m=>m.table+'.'+m.column));assert.ok(distinct.size>=63,'real identifier/secondary/JOINED/collection physical mapping slice');
    const source=javaFiles(path.join(runtime.projectPath,'src/main/java')),xml=path.join(runtime.projectPath,'src/main/resources/META-INF/orm.xml');
    const {analyzeJPA,compareCatalog}=require('../src/jpa/model'),model=analyzeJPA(source,{physicalNaming:'standard',basePackages:['fixture.boot'],mappingFiles:[{uri:pathToFileURL(xml).href,text:fs.readFileSync(xml,'utf8')}],...(runtime.namingStrategy?{namingStrategy:runtime.namingStrategy}:{})});
    const staticComparison=compareCatalog(model,catalog);
    if(runtime.naming==='opaque'){assert.ok(model.entities.some(e=>e.table.certainty==='unknown'));assert.equal(staticComparison.mismatches.length,0);assert.ok(staticComparison.unknowns.length>0);assert.ok(known.every(m=>m.table.startsWith('rt_')));}
    record('runtime-mapping',{provider:factory.provider,version:factory.version,entities:factory.entities,physicalBindings:known.length,distinctPhysicalColumns:distinct.size,mismatches,staticComparison,scope:'Live provider physical metadata compared to visible catalog using a separate read-only connection. Opaque Java naming is observed at runtime; static unknowns remain unknown.'});
  }finally{await service.dispose();}
});
