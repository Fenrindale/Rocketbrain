'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const runtimeFile=process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG||process.env.ROCKETBRAIN_SPRING_RUNTIME_CONFIG;
const runtime=runtimeFile?JSON.parse(fs.readFileSync(runtimeFile,'utf8')):null;
const live=(name,fn)=>test(name,{skip:!runtime&&'Use spring-project.js run --engine mysql|mariadb [--naming custom] -- --test test/jpa-v06-runtime.test.js.',timeout:90000},fn);
async function get(route){const response=await fetch(runtime.baseUrl+route,{redirect:'error',signal:AbortSignal.timeout(20000)});assert.equal(response.status,200,route+' HTTP status');return response.json();}
function sourceFiles(folder){return fs.readdirSync(folder,{withFileTypes:true}).flatMap(entry=>{const file=path.join(folder,entry.name);return entry.isDirectory()?sourceFiles(file):entry.name.endsWith('.java')?[{uri:pathToFileURL(file).href,text:fs.readFileSync(file,'utf8')}]:[];});}
function modelOptions(){const file=path.join(runtime.projectPath,'src/main/resources/META-INF/orm.xml');return{physicalNaming:'standard',basePackages:['fixture.boot'],mappingFiles:[{uri:pathToFileURL(file).href,text:fs.readFileSync(file,'utf8')}],...(runtime.namingStrategy?{namingStrategy:runtime.namingStrategy}:{})};}
function writeReport(kind,value){const folder=path.resolve(__dirname,'../test-output'),file=path.join(folder,'v0.6-'+kind+'-'+runtime.dbEngine+'-'+(runtime.naming||'standard')+'.json');const config=JSON.parse(fs.readFileSync(runtime.dbConfigPath,'utf8'));const serialized=JSON.stringify({asOf:new Date().toISOString(),engine:runtime.dbEngine,naming:runtime.naming||'standard',...value},null,2);assert.ok(!serialized.includes(config.password));fs.writeFileSync(file,serialized+'\n');}

live('v0.6 actual Hibernate and Spring Data execute typed projections, dynamic Java and SpEL and reject invalid type cases',async()=>{
  const typed=await get('/probe/types'),dynamic=await get('/probe/types/dynamic'),spel=await get('/probe/types/spel'),invalid=await get('/probe/types/invalid'),spelErrors=await get('/probe/types/spel-errors');
  assert.deepEqual(typed.aggregateValues,[2,3,1.5,'Alex',2]);
  assert.deepEqual(typed.aggregateTypes,['java.lang.Long','java.lang.Long','java.lang.Double','java.lang.String','java.lang.Long']);
  assert.deepEqual(typed.numericValues,[[2,1.5,0,'Alex'],[3,2.5,2,'Mina']]);
  assert.deepEqual(typed.numericTypes,['java.lang.Long','java.lang.Double','java.lang.Long','java.lang.String']);
  assert.deepEqual(typed.dto,[{name:'Alex',total:1},{name:'Mina',total:1}]);assert.deepEqual(typed.typedId,['Alex']);assert.deepEqual(typed.collection,['Alex','Mina']);assert.deepEqual(typed.entity,['Alex','Mina']);
  for(const value of [dynamic.city,dynamic.department]){assert.deepEqual(value.constantNames,['Alex','Mina']);assert.deepEqual(value.builderNames,['Alex']);assert.deepEqual(value.chosenNames,['Alex']);assert.match(value.constantQuery,/p.department.name = :department/);assert.match(value.builderQuery,/p.address.city = :city/);assert.match(value.chosenQuery,/p.displayName = :value/);}
  assert.deepEqual(dynamic.city.finiteNames,['Alex']);assert.deepEqual(dynamic.department.finiteNames,['Alex','Mina']);assert.match(dynamic.city.finiteQuery,/p.address.city/);assert.match(dynamic.department.finiteQuery,/p.department.name/);
  assert.deepEqual(spel,{named:['Alex'],safeElvis:['Alex'],indexed:['Mina'],arithmetic:['Alex','Mina'],ternary:['Alex'],typedRepository:['Alex'],stringMethod:['Alex']});
  for(const [name,outcome]of Object.entries(invalid)){assert.notEqual(outcome,'accepted','Hibernate must reject '+name);assert.match(outcome,/Exception$/);}
  assert.equal(spelErrors.missingProperty,'SpelEvaluationException');
  writeReport('queries-observed',{typed,dynamic,spel,invalid,spelErrors,scope:'Owned fixture executes source queries; invalid mutation query is compiled only, no DML is issued.'});
});

live('v0.6 configured naming metadata agrees with the actual database without executing source naming code',async()=>{
  const {analyzeJPA,compareCatalog}=require('../src/jpa/model');const {MysqlService}=require('../src/db/mysql');
  const files=sourceFiles(path.join(runtime.projectPath,'src/main/java')),model=analyzeJPA(files,modelOptions());
  const config=JSON.parse(fs.readFileSync(runtime.dbConfigPath,'utf8')),service=new MysqlService(config);
  try{
    const catalog=await service.metadata(),comparison=compareCatalog(model,catalog),property=model.entities.find(e=>e.name==='PropertyRecord');
    const expectedTable=runtime.naming==='custom'?'v6_rb_spring_property':'rb_spring_property',expectedAlias=runtime.naming==='custom'?'c_logical_display_alias':'displayAlias';
    assert.equal(property.table.physicalName,expectedTable);
    assert.ok(property.columnMappings.some(b=>b.column?.physicalName===expectedAlias));
    assert.ok(property.columnMappings.some(b=>b.column?.physicalName==='QuotedValue'));
    const table=catalog.tables.find(t=>t.name===expectedTable);assert.ok(table);assert.ok(table.columns.some(c=>c.name.toLowerCase()===expectedAlias.toLowerCase()));assert.ok(table.columns.some(c=>c.name==='QuotedValue'));
    assert.equal(comparison.mismatches.length,0,JSON.stringify(comparison.mismatches));assert.ok(comparison.matches.length>=71);
    const distinct=new Set(comparison.matches.map(m=>m.table+'.'+m.column));
    writeReport('naming',{strategy:runtime.namingStrategy,entities:model.entities.length,comparison,distinctPhysicalColumns:distinct.size,propertyMappings:property.columnMappings,scope:'Local source metadata interpreter only. The separately running owned Hibernate fixture executes its own real naming strategies.'});
  }finally{await service.dispose();}
});

live('v0.6 source query types, finite Java alternatives and symbolic SpEL agree with observed projections and provider rejections',async()=>{
  const {analyzeJPA,definitionsAt}=require('../src/jpa/model');
  const files=sourceFiles(path.join(runtime.projectPath,'src/main/java')),model=analyzeJPA(files,modelOptions());
  const observed=await get('/probe/types'),dynamic=await get('/probe/types/dynamic'),invalid=await get('/probe/types/invalid');
  const queries=model.queries.filter(q=>q.uri.endsWith('/TypeProbeService.java'));
  function query(text){const result=queries.find(q=>q.text===text);assert.ok(result,'Source query extracted: '+text);return result;}
  const aggregates=query('select count(p), sum(p.id), avg(p.id), min(p.displayName), max(p.id) from Person p');
  assert.equal(aggregates.typeAnalysis.state,'known',JSON.stringify(aggregates.typeAnalysis.coverage));assert.deepEqual(aggregates.typeAnalysis.selectionTypes.map(t=>t.javaType),observed.aggregateTypes);
  const numeric=queries.find(q=>q.text?.startsWith('select p.id + 1,'));assert.equal(numeric.typeAnalysis.state,'known');assert.deepEqual(numeric.typeAnalysis.selectionTypes.map(t=>t.javaType),observed.numericTypes);
  const dto=queries.find(q=>q.text?.startsWith('select new fixture.boot.TypedSummary(p.displayName, count(p))'));assert.equal(dto.typeAnalysis.state,'known',JSON.stringify(dto.typeAnalysis.coverage));assert.equal(dto.typeAnalysis.selectionTypes[0].javaType,'fixture.boot.TypedSummary');
  const negative={arithmetic:'select p.displayName + 1 from Person p',function:'select length(p.id) from Person p',constructor:'select new fixture.boot.TypedSummary(p.displayName, p.displayName) from Person p',entityComparison:'select p from Person p where p.department = p.id',booleanPredicate:'select p from Person p where p.displayName',subquery:'select p from Person p where p.id in (select d.name from Department d)',resultClass:'select p.displayName from Person p',binding:'select p from Person p where p.id = :id',assignment:"update Person p set p.department = 'wrong'"};
  for(const [key,text]of Object.entries(negative)){const result=query(text);assert.equal(result.typeAnalysis.state,'invalid',key+': '+JSON.stringify(result.typeAnalysis.coverage));assert.ok(result.typeAnalysis.diagnostics.some(d=>d.code.startsWith('jpa.type.')));assert.notEqual(invalid[key],'accepted');}
  const dynamicTexts=new Set([dynamic.city.constantQuery,dynamic.city.builderQuery,dynamic.city.chosenQuery,dynamic.city.finiteQuery,dynamic.department.finiteQuery]);
  const resolved=[...dynamicTexts].map(text=>query(text));for(const q of resolved){assert.equal(q.typeAnalysis.state,'known',JSON.stringify(q.typeAnalysis.coverage));assert.ok(['known','finite'].includes(q.dynamicResolution.state));}
  const alternatives=queries.filter(q=>q.dynamicResolution?.state==='finite');assert.equal(alternatives.length,2);assert.ok(alternatives.every(q=>q.dynamicResolution.alternatives===2));
  const constants=files.find(f=>f.uri.endsWith('/TypeQueryParts.java')),constantPosition=constants.text.indexOf('p.displayName');assert.ok(definitionsAt(model,constants.uri,constantPosition+4).some(target=>target.uri.endsWith('/Person.java')),'Cross-file constant query provenance navigates to Person.displayName.');
  const repositories=model.queries.filter(q=>q.uri.endsWith('/TypedPersonRepository.java'));
  assert.equal(repositories.length,7);for(const q of repositories){assert.equal(q.typeAnalysis.state,'known',q.text+': '+JSON.stringify(q.typeAnalysis.coverage));assert.equal(q.text.includes('#{'),false);}
  assert.equal(repositories.filter(q=>q.symbolicParameters?.length).length,6);
  const badSpel=model.queries.find(q=>q.uri.endsWith('/TypeProbeService.java')&&q.dynamicResolution?.reasons?.some(reason=>reason.includes('property missing')));assert.ok(badSpel);assert.equal(badSpel.typeAnalysis.state,'unknown');
  writeReport('static-types',{selectionTypes:{aggregates:aggregates.typeAnalysis.selectionTypes,numeric:numeric.typeAnalysis.selectionTypes,dto:dto.typeAnalysis.selectionTypes},negative:Object.fromEntries(Object.entries(negative).map(([key,text])=>[key,{state:query(text).typeAnalysis.state,observed:invalid[key],diagnostics:query(text).typeAnalysis.diagnostics}])),dynamic:resolved.map(q=>({text:q.text,resolution:q.dynamicResolution,types:q.typeAnalysis.state})),spel:repositories.map(q=>({text:q.text,types:q.typeAnalysis.state,parameters:q.symbolicParameters})),diagnostics:model.diagnostics.filter(d=>/TypeProbeService|TypedPersonRepository/.test(d.uri)),scope:'Each supported AST component is checked from source. Observed provider execution is a separate fixture proof; arbitrary runtime code is not evaluated by the analyzer.'});
});

module.exports={sourceFiles,modelOptions};
