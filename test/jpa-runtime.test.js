'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {pathToFileURL}=require('node:url');
const {analyzeJPA,compareCatalog}=require('../src/jpa/model');
const {MysqlService}=require('../src/db/mysql');
const runtimeFile=process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG||process.env.ROCKETBRAIN_SPRING_RUNTIME_CONFIG;
const runtime=runtimeFile?JSON.parse(fs.readFileSync(runtimeFile,'utf8')):null;
function sources(directory) {
  return fs.readdirSync(directory,{withFileTypes:true}).flatMap(entry=>{
    const file=path.join(directory,entry.name);
    return entry.isDirectory()?sources(file):entry.name.endsWith('.java')?[{uri:pathToFileURL(file).href,text:fs.readFileSync(file,'utf8'),sha256:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}]:[];
  });
}
async function get(endpoint) {
  const response=await fetch(runtime.baseUrl+endpoint,{redirect:'error',signal:AbortSignal.timeout(15000)});
  assert.equal(response.status,200,endpoint+' HTTP status');
  return response.json();
}
test('actual Spring Boot/Hibernate JPA source model agrees with runtime metamodel, real SQL and read-only database catalog',{
  skip:!runtime&&'Use spring-project.js run --engine mysql|mariadb -- --test test/jpa-runtime.test.js.',timeout:60000
},async()=>{
  const marker=JSON.parse(fs.readFileSync(path.join(path.dirname(runtimeFile),'owner.json'),'utf8'));
  assert.equal(marker.kind,'RocketbrainSpringProjectFixture-v1');
  const dbMarker=JSON.parse(fs.readFileSync(path.join(path.dirname(runtime.dbConfigPath),'owner.json'),'utf8'));
  assert.ok(['RocketbrainDisposableOracleMysqlFixture-v1','RocketbrainDisposableMariaDbFixture-v1'].includes(dbMarker.kind));
  const config=JSON.parse(fs.readFileSync(runtime.dbConfigPath,'utf8'));
  const service=new MysqlService(config);
  try {
    const files=sources(path.join(runtime.projectPath,'src/main/java'));
    // Preserve the original v0.4 annotation-only vertical slice while v0.5
    // validates the additional custom/XML entities in a separate test.
    const baselineNames=new Set(['Address.java','AuditBase.java','Asset.java','DocumentAsset.java','Department.java','Person.java','PropertyRecord.java','PersonRepository.java','ProbeService.java']);
    const baselineFiles=files.filter(file=>baselineNames.has(path.basename(new URL(file.uri).pathname)));
    const model=analyzeJPA(baselineFiles,{basePackages:['fixture.boot'],physicalNaming:'standard'});
    const versions=await get('/probe/runtime'),probe=await get('/probe'),metamodel=await get('/probe/metamodel'),sql=await get('/probe/sql'),outside=await get('/probe/lazy-outside');
    assert.equal(versions.boot,'4.1.2');assert.equal(versions.spring,'7.0.10');assert.equal(versions.hibernate,'7.4.13.Final');
    assert.equal(versions.proxy,true);assert.equal(probe.derivedCount,1);assert.equal(probe.jpqlCount,2);
    assert.equal(probe.department,'Engineering');assert.equal(probe.lazyBefore,false);assert.equal(probe.lazyAfter,true);
    assert.equal(probe.invalidJpqlError,'IllegalArgumentException');assert.equal(outside.error,'LazyInitializationException');
    assert.equal(model.entities.length,5);
    const compared=[];
    for(const actual of metamodel.filter(actual=>model.entities.some(entity=>entity.fqn===actual.javaType))) {
      const entity=model.entities.find(item=>item.fqn===actual.javaType);
      assert.ok(entity,'Static entity exists for '+actual.javaType);
      assert.equal(entity.name,actual.name);
      assert.deepEqual(entity.attributes.map(item=>item.name).sort(),actual.attributes.map(item=>item.name).sort(),actual.javaType+' persistent attributes');
      compared.push({entity:entity.fqn,attributes:actual.attributes.map(item=>({name:item.name,kind:item.kind,javaType:item.javaType}))});
    }
    assert.equal(compared.length,5);
    assert.ok(model.diagnostics.some(item=>item.code==='jpa.jpql.property.missing'&&/missingProperty/.test(item.message)),'Invalid query property is found statically and rejected by Hibernate');
    const catalog=await service.metadata(),comparison=compareCatalog(model,catalog);
    assert.equal(comparison.mismatches.length,0,JSON.stringify(comparison.mismatches));
    assert.ok(comparison.matches.length>=20);
    assert.ok(sql.some(statement=>/rb_spring_person/.test(statement)&&/display_name/.test(statement)));
    assert.ok(sql.some(statement=>/department_id/.test(statement)));
    const drift=structuredClone(catalog);
    drift.tables.find(table=>table.name==='rb_spring_person').columns=drift.tables.find(table=>table.name==='rb_spring_person').columns.filter(column=>column.name!=='display_name');
    assert.ok(compareCatalog(model,drift).mismatches.some(item=>item.code==='jpa.catalog.column'&&item.column==='display_name'));
    assert.equal(compareCatalog(analyzeJPA(baselineFiles,{physicalNaming:'unknown'}),drift).mismatches.length,0,'Unknown naming is not promoted to a definite missing-column claim.');
    const report={asOf:new Date().toISOString(),engine:runtime.dbEngine,versions,probe,outside,metamodel:compared,comparison,
      sqlEvidence:sql.slice(-30),sources:files.map(({uri,sha256})=>({uri,sha256})),dependencies:'test-output/spring-project/dependencies.json',
      staticDiagnostics:model.diagnostics,limitations:['Controlled five-entity annotation-only baseline with explicitly configured physical naming.','The additional custom/XML entities are verified in the separate v0.5 runtime test; this baseline does not measure them.','Multiple persistence units and complete JPQL/HQL validity are not asserted. Catalog comparison reads INFORMATION_SCHEMA only; no corrective DDL is generated.']};
    const serialized=JSON.stringify(report,null,2);
    assert.ok(!serialized.includes(config.password),'Credentials are excluded from evidence.');
    fs.mkdirSync(path.resolve(__dirname,'../test-output'),{recursive:true});
    fs.writeFileSync(path.resolve(__dirname,'../test-output/'+(process.env.ROCKETBRAIN_TEST_REPORT_PREFIX||"v0.4")+'-jpa-'+runtime.dbEngine+'.json'),serialized+'\n');
  } finally {await service.dispose();}
});
