'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {pathToFileURL}=require('node:url');
const {analyzeJPA,compareCatalog,definitionsAt,completionsAt}=require('../src/jpa/model');
const {MysqlService}=require('../src/db/mysql');
const runtimeFile=process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG||process.env.ROCKETBRAIN_SPRING_RUNTIME_CONFIG;
const runtime=runtimeFile?JSON.parse(fs.readFileSync(runtimeFile,'utf8')):null;
function sources(directory) {
  return fs.readdirSync(directory,{withFileTypes:true}).flatMap(entry=>{
    const file=path.join(directory,entry.name);
    return entry.isDirectory()?sources(file):entry.name.endsWith('.java')?[{uri:pathToFileURL(file).href,text:fs.readFileSync(file,'utf8')}]:[];
  });
}
async function get(endpoint) {
  const response=await fetch(runtime.baseUrl+endpoint,{redirect:'error',signal:AbortSignal.timeout(20000)});
  assert.equal(response.status,200,endpoint+' HTTP status');
  return response.json();
}
function configuration() {
  assert.equal(JSON.parse(fs.readFileSync(path.join(path.dirname(runtimeFile),'owner.json'),'utf8')).kind,'RocketbrainSpringProjectFixture-v1');
  const owner=JSON.parse(fs.readFileSync(path.join(path.dirname(runtime.dbConfigPath),'owner.json'),'utf8'));
  assert.ok(['RocketbrainDisposableOracleMysqlFixture-v1','RocketbrainDisposableMariaDbFixture-v1'].includes(owner.kind));
  return JSON.parse(fs.readFileSync(runtime.dbConfigPath,'utf8'));
}
const live=(name,fn)=>test(name,{skip:!runtime&&'Use spring-project.js run --engine mysql|mariadb -- --test test/jpa-v05-runtime.test.js.',timeout:90000},fn);
live('actual Hibernate v0.5 executes complex JPQL, custom mappings and rollback-only bulk changes',async()=>{
  const config=configuration(),service=new MysqlService(config);
  try {
    const complex=await get('/probe/advanced'),mapping=await get('/probe/advanced/mappings'),bulk=await get('/probe/advanced/bulk');
    assert.deepEqual(complex.correlatedExists,['Alex','Mina']);
    assert.deepEqual(complex.correlatedIn,['Alex','Mina']);
    assert.deepEqual(complex.shadowedScopes,['Alex','Mina']);
    assert.deepEqual(complex.grouped,[['Engineering',2,4]]);
    assert.deepEqual(complex.caseNames,['ALEX','mina']);
    assert.deepEqual(complex.dto,[{displayName:'Alex',department:'Engineering'},{displayName:'Mina',department:'Engineering'}]);
    assert.deepEqual(complex.joinOn,['Alex','Mina']);assert.equal(complex.fetchInitialized,true);
    assert.deepEqual(complex.collectionAlias,['Alex']);assert.deepEqual(complex.scalarCollectionAlias,['blue','green']);
    assert.deepEqual(complex.treat,['Runbook']);assert.deepEqual(complex.xmlNamed,['XML label']);assert.deepEqual(complex.xmlOverride,['XML overrides annotations']);
    assert.equal(complex.invalidNestedPath,'IllegalArgumentException');
    assert.equal(mapping.nestedCity,'Incheon');assert.equal(mapping.nestedPostal,'22345');assert.equal(mapping.nestedPhone,'555-0100');
    assert.equal(mapping.overriddenDepartment,'Engineering');assert.equal(mapping.convertedCode,'ABC');assert.equal(mapping.enumState,'ACTIVE');
    assert.equal(mapping.secondaryNote,'Secondary table note');assert.equal(mapping.temporalDate,'2026-11-13');
    assert.equal(mapping.lobText,'Long text fixture');assert.equal(mapping.lobHex,'00ff10');
    assert.deepEqual(mapping.tags,['blue','green']);assert.deepEqual(mapping.joinDepartments,['Engineering']);
    assert.deepEqual(mapping.compositeJoin,{country:'KR',region:'ICN',name:'Harbor'});assert.equal(mapping.idClassLabel,'Licensed fixture');
    assert.deepEqual(mapping.joined,{name:'Delivery truck',payloadKg:1200});assert.deepEqual(mapping.tablePerClass,{amount:'12.50',register:'Till-A'});
    assert.equal(mapping.xmlOnly,'XML label');
    assert.equal(bulk.updated,2);assert.equal(bulk.deleted,1);assert.equal(bulk.remainingInside,1);assert.deepEqual(bulk.afterRollbackNames,['Alex','Mina']);
    const catalog=await service.metadata(),byName=new Map(catalog.tables.map(table=>[table.name,table]));
    const expected=['rb_v5_record','rb_v5_record_extra','rb_v5_record_tags','rb_v5_record_departments','rb_v5_region','rb_v5_warehouse','rb_v5_license','rb_v5_vehicle','rb_v5_truck','rb_v5_cash_payment','rb_v5_xml_record','rb_v5_xml_override'];
    for(const name of expected)assert.ok(byName.has(name),'Hibernate created '+name);
    assert.equal(byName.has('rb_v5_wrong_annotated_table'),false);assert.equal(byName.has('rb_v5_paymentbase'),false);
    assert.deepEqual(byName.get('rb_v5_region').columns.filter(column=>column.primaryKey).map(column=>column.name).sort(),['country_code','region_code']);
    assert.deepEqual(byName.get('rb_v5_license').columns.filter(column=>column.primaryKey).map(column=>column.name).sort(),['license_code','tenant_key']);
    const warehouseFk=byName.get('rb_v5_warehouse').foreignKeys.find(fk=>fk.referencedTable==='rb_v5_region');
    assert.equal(warehouseFk.columns.length,2);
    assert.ok(byName.get('rb_v5_record_extra').foreignKeys.some(fk=>fk.referencedTable==='rb_v5_record'));
    assert.ok(byName.get('rb_v5_truck').columns.some(column=>column.name==='vehicle_id'&&column.primaryKey));
    assert.ok(byName.get('rb_v5_xml_override').columns.some(column=>column.name==='xml_override_label'));
    assert.equal(byName.get('rb_v5_xml_override').columns.some(column=>column.name==='wrong_annotated_column'),false);
    const sql=await get('/probe/sql'),metamodel=await get('/probe/metamodel');
    assert.equal(metamodel.length,15);
    assert.ok(sql.some(statement=>/rb_v5_record_extra/.test(statement)));
    assert.ok(sql.some(statement=>/rb_v5_record_tags/.test(statement)));
    assert.ok(sql.some(statement=>/rb_v5_record_departments/.test(statement)));
    assert.ok(sql.some(statement=>/rb_v5_truck/.test(statement)&&/rb_v5_vehicle/.test(statement)));
    const report={asOf:new Date().toISOString(),engine:runtime.dbEngine,complex,mapping,bulk,metamodel,sqlEvidence:sql.slice(-60),
      catalog:catalog.tables.filter(table=>table.name.startsWith('rb_v5_')),sourceScope:'Controlled fixture; reads probe DTOs and INFORMATION_SCHEMA. Bulk changes roll back inside the fixture application.'};
    const serialized=JSON.stringify(report,null,2);assert.ok(!serialized.includes(config.password));
    fs.writeFileSync(path.resolve(__dirname,'../test-output/'+(process.env.ROCKETBRAIN_TEST_REPORT_PREFIX||"v0.5")+'-jpa-observed-'+runtime.dbEngine+'.json'),serialized+'\n');
  }finally{await service.dispose();}
});
live('v0.5 static scopes, custom physical bindings and ORM XML agree with actual Hibernate',async()=>{
  const config=configuration(),service=new MysqlService(config);
  try{
    const files=sources(path.join(runtime.projectPath,'src/main/java'));
    const mappingPath=path.join(runtime.projectPath,'src/main/resources/META-INF/orm.xml');
    const mappingFiles=[{uri:pathToFileURL(mappingPath).href,text:fs.readFileSync(mappingPath,'utf8')}];
    const model=analyzeJPA(files,{basePackages:['fixture.boot'],physicalNaming:'standard',mappingFiles});
    const actual=await get('/probe/metamodel');
    for(const entity of actual){
      const declared=model.entities.find(item=>item.fqn===entity.javaType);assert.ok(declared,'Model includes '+entity.javaType);
      assert.equal(declared.name,entity.name);
      assert.deepEqual(declared.attributes.map(item=>item.name).sort(),entity.attributes.map(item=>item.name).sort(),entity.javaType+' local persistent attributes');
    }
    const xml=model.entities.find(item=>item.fqn==='fixture.boot.XmlRecord');
    assert.equal(xml.name,'XmlEntry');assert.deepEqual(xml.attributes.map(item=>item.name).sort(),['id','label']);
    const override=model.entities.find(item=>item.fqn==='fixture.boot.XmlOverrideRecord');assert.equal(override.table.physicalName,'rb_v5_xml_override');
    const advanced=model.queries.filter(query=>query.uri.endsWith('/AdvancedProbeService.java'));
    const valid=advanced.filter(query=>query.text&&!query.text.includes('missingNested'));
    assert.ok(valid.length>=15);
    const unexpected=valid.filter(query=>query.status==='invalid');
    assert.deepEqual(unexpected.map(query=>({text:query.text,status:query.status,reason:query.reason})),[]);
    assert.deepEqual(valid.filter(query=>query.status!=='known').map(query=>({text:query.text,status:query.status,reason:query.reason})),[],'Every deliberately supported valid fixture query resolves its local paths.');
    const xmlQuery=model.queries.find(query=>query.uri.endsWith('/META-INF/orm.xml')&&query.text?.includes('select x from XmlEntry'));
    assert.ok(xmlQuery);assert.equal(xmlQuery.status,'known');
    const compiled=await get('/probe/advanced');
    const textBlock=valid.find(query=>query.text===compiled.compiledTextBlockQuery);
    const concatenated=valid.find(query=>query.text===compiled.compiledConcatenatedQuery);
    assert.ok(textBlock,'JLS text-block decoder equals the actual compiler value returned by Hibernate.');
    assert.ok(concatenated,'Literal concatenation decoder equals the actual compiler value returned by Hibernate.');
    const advancedSource=files.find(file=>file.uri.endsWith('/AdvancedProbeService.java'));
    const shadowStart=advancedSource.text.indexOf('result.put("shadowedScopes"');
    const innerName=advancedSource.text.indexOf('p.name',shadowStart);
    const outerName=advancedSource.text.indexOf('p.displayName',shadowStart);
    assert.ok(definitionsAt(model,advancedSource.uri,innerName+2).some(target=>target.uri.endsWith('/Department.java')),'Inner shadowed alias resolves to Department.');
    assert.ok(definitionsAt(model,advancedSource.uri,outerName+2).some(target=>target.uri.endsWith('/Person.java')),'Outer alias retains Person after the nested subquery.');
    const nestedCompletions=completionsAt(model,advancedSource.uri,innerName+4);
    assert.ok(nestedCompletions.some(item=>item.label==='name'));
    assert.equal(nestedCompletions.some(item=>item.label==='displayName'),false);
    const textBlockStart=advancedSource.text.indexOf('var correlatedQuery=');
    const textBlockDepartment=advancedSource.text.indexOf('p.department',textBlockStart);
    assert.ok(definitionsAt(model,advancedSource.uri,textBlockDepartment+2).some(target=>target.uri.endsWith('/Person.java')));
    const concatStart=advancedSource.text.indexOf('var groupedQuery=');
    const concatDepartment=advancedSource.text.indexOf('p.department',concatStart);
    assert.ok(definitionsAt(model,advancedSource.uri,concatDepartment+2).some(target=>target.uri.endsWith('/Person.java')));
    assert.ok(model.diagnostics.some(item=>item.code==='jpa.jpql.property.missing'&&/missingNested/.test(item.message)));
    const catalog=await service.metadata(),comparison=compareCatalog(model,catalog);
    assert.equal(comparison.mismatches.length,0,JSON.stringify(comparison.mismatches));
    const requiredColumns=['home_city','home_postal','home_phone','assigned_department_id','normalized_code','record_state','secret_note','tag_value','region_country','region_code','tenant_key','license_code','vehicle_id','xml_label','xml_override_label'];
    for(const name of requiredColumns)assert.ok(comparison.matches.some(item=>item.column===name),'Static binding matches catalog column '+name);
    const sourcesWithHashes=[...files,...mappingFiles].map(file=>({uri:file.uri,sha256:crypto.createHash('sha256').update(file.text).digest('hex')}));
    const report={asOf:new Date().toISOString(),engine:runtime.dbEngine,entities:model.entities.map(entity=>({name:entity.name,fqn:entity.fqn,table:entity.table,inheritance:entity.inheritance,columnMappings:entity.columnMappings,mappingState:entity.mappingState})),
      comparison,queries:advanced.map(({uri,text,status,reason,analysis,validityVerified})=>({uri,text,status,reason,analysis,validityVerified})),
      navigation:{innerShadowedAlias:'Department.name',outerAlias:'Person.displayName',innerCompletion:'name'},xmlNamedQuery:{status:xmlQuery.status,analysis:xmlQuery.analysis,validityVerified:xmlQuery.validityVerified},
      literalSourceForms:{textBlockEqualsCompiledValue:true,concatenatedEqualsCompiledValue:true,textBlockPropertyDefinition:true,concatenatedPropertyDefinition:true},
      diagnostics:model.diagnostics,issues:model.issues,sources:sourcesWithHashes};
    const serialized=JSON.stringify(report,null,2);assert.ok(!serialized.includes(config.password));
    fs.writeFileSync(path.resolve(__dirname,'../test-output/'+(process.env.ROCKETBRAIN_TEST_REPORT_PREFIX||"v0.5")+'-jpa-static-'+runtime.dbEngine+'.json'),serialized+'\n');
  }finally{await service.dispose();}
});
