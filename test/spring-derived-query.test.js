'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { test } = require('node:test');
const { analyzeJPA,definitionsAt } = require('../src/jpa/model');
const { execute } = require('../src/java/testing/provision');
const { derivedFixture,runtimeSource } = require('./helpers/spring-derived-query-fixture');

function analyze(fixture) {
  const files = fixture.files.map(file => ({...file,uri:'file:///spring-derived/'+file.name+'.java'}));
  return {model:analyzeJPA(files),files};
}
function positionAt(text,offset) {
  const lines = text.slice(0,offset).split('\n');
  return {line:lines.length-1,character:lines.at(-1).length};
}
function findMethod(model,name) { return model.queries.find(query => query.text === name); }
function shape(query) {
  return query.derivedAnalysis.predicateGroups.map(group => group.map(part =>
    [part.path,part.operator,part.arity,part.ignoreCase].join(':')).join(',')).join(';');
}

test('compound Spring Data paths, predicates, ordering, navigation and bindable arity are source-linked',() => {
  const fixture = derivedFixture('fixture.derived','Probe','rb_derived');
  const {model,files} = analyze(fixture), {names} = fixture;
  const method = findMethod(model,names.compound);
  assert.equal(method.status,'known');
  assert.equal(shape(method),'name:STARTING_WITH:1:ALWAYS,score:BETWEEN:2:NEVER;location.city:SIMPLE_PROPERTY:1:NEVER,active:TRUE:0:NEVER');
  assert.deepEqual(method.derivedAnalysis.order,[{path:'score',direction:'DESC'},{path:'name',direction:'ASC'}]);
  assert.deepEqual(method.derivedAnalysis.parameters,{expected:4,bindable:['prefix','floor','ceiling','city'].map(name=>({name})),special:[]});
  const paging = findMethod(model,names.page);
  assert.equal(paging.status,'known');
  assert.deepEqual(paging.derivedAnalysis.parameters,{expected:2,bindable:[{name:'city'},{name:'floor'}],
    special:[{name:'page',kind:'Pageable'}]});
  assert.ok(shape(paging).startsWith('location.city:'));
  assert.equal(findMethod(model,names.orderOnly).derivedAnalysis.parameters.expected,0);
  assert.equal(findMethod(model,names.in).derivedAnalysis.predicateGroups[0][0].operator,'IN');
  assert.equal(findMethod(model,names.allCase).derivedAnalysis.predicateGroups[0][1].ignoreCase,'WHEN_POSSIBLE');

  const repository = files.find(file => file.name === fixture.repository);
  const definitions = (method,needle) => {
    const offset = repository.text.indexOf(method)+method.indexOf(needle);
    return definitionsAt(model,repository.uri,positionAt(repository.text,offset));
  };
  assert.ok(definitions(names.compound,'CityAnd')[0].uri.endsWith('/'+fixture.location+'.java'));
  assert.ok(definitions(names.compound,'NameAsc')[0].uri.endsWith('/'+fixture.entity+'.java'));
  assert.ok(definitions(names.page,'CityAnd')[0].uri.endsWith('/'+fixture.location+'.java'));
  assert.deepEqual(definitions(names.compound,'StartingWith'),[],'the operator is outside the property range');
  assert.deepEqual(definitions(names.ambiguous,'PostalCode'),[]);
  assert.match(findMethod(model,names.ambiguous).reason,/competing prefixes/u);
  assert.match(findMethod(model,names.mask).reason,/unresolved/u);
  assert.equal(findMethod(model,names.unsupported).status,'unknown');
  assert.equal(findMethod(model,names.missing).status,'invalid');
  assert.equal(findMethod(model,names.extra).status,'unknown');
  assert.equal(findMethod(model,names.reserved),undefined);
  assert.equal(findMethod(model,'findByScore'),undefined);
  assert.deepEqual(model.diagnostics.filter(item=>item.code==='jpa.derived.arguments').map(item=>item.severity),['warning','information']);
});

test('repository imports and type scope distinguish source shadows and competing property spellings',() => {
  const fixture = derivedFixture('fixture.derived','Probe','rb_derived');
  const repo = fixture.files.find(file=>file.name===fixture.repository);
  repo.text = repo.text.replace('import org.springframework.data.jpa.repository.JpaRepository;',
    'import org.springframework.data.jpa.repository.*;');
  fixture.files.push({name:'JpaRepository',text:'package fixture.derived; interface JpaRepository<Entity,Key> {}'});
  const {model} = analyze(fixture);
  assert.equal(findMethod(model,fixture.names.compound),undefined);
  assert.equal(findMethod(model,fixture.names.missing).status,'invalid','qualified actual Spring Data imports remain recognized');
  assert.equal(findMethod(model,fixture.names.extra),undefined);
});

const runtimeConfig = process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;
const classpathFile = process.env.ROCKETBRAIN_DERIVED_QUERY_CLASSPATH;
const configPaths = {mysql:process.env.ROCKETBRAIN_DERIVED_QUERY_MYSQL_CONFIG,mariadb:process.env.ROCKETBRAIN_DERIVED_QUERY_MARIADB_CONFIG};

test('actual Spring Data PartTree and repository proxies match source analysis on MySQL and MariaDB',{
  skip:!(runtimeConfig && classpathFile && configPaths.mysql && configPaths.mariadb) && 'Configure the actual Spring Data and both owned JDBC fixtures.',
  timeout:200000
},async t=>{
  const {javaHome} = JSON.parse(await fs.readFile(runtimeConfig,'utf8'));
  const classpath = (await fs.readFile(classpathFile,'utf8')).trim().split(path.delimiter).filter(file=>/\.jar$/iu.test(file));
  for (const required of ['spring-data-commons-4.1.2.jar','spring-data-jpa-4.1.2.jar','hibernate-core-7.4.13.Final.jar',
    'mysql-connector-j-9.7.0.jar','mariadb-java-client-3.5.10.jar']) {
    assert.ok(classpath.some(file=>path.basename(file)===required),required);
  }
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'rb-data-derived-'));
  t.after(() => fs.rm(root,{force:true,recursive:true}));
  const executeOptions = {env:Object.fromEntries(Object.entries(process.env).filter(([key])=>
    !/^(?:CLASSPATH|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS|JDK_JAVAC_OPTIONS)$/iu.test(key))),timeoutMs:65000};
  const tool = name=>path.join(javaHome,'bin',name+(process.platform==='win32'?'.exe':''));
  const fixture = derivedFixture('fixture.derived','Probe','rb_derived_'+randomBytes(6).toString('hex'));
  const fixtureFiles = [...fixture.files,{name:'DerivedRuntime',text:runtimeSource(fixture)}];
  const javaFiles = await Promise.all(fixtureFiles.map(async item=>{
    const file = path.join(root,item.name+'.java'); await fs.writeFile(file,item.text); return file;
  }));
  const output = path.join(root,'classes');
  await fs.mkdir(output);
  const compiled = await execute(tool('javac'),['-proc:none','-parameters','-encoding','UTF-8',
    '-classpath',classpath.join(path.delimiter),'-d',output,...javaFiles],executeOptions);
  assert.equal(compiled.code,0,compiled.output);
  assert.ok((await fs.stat(path.join(output,'fixture/derived/DerivedRuntime.class'))).isFile());
  const args = ['-cp',[output,...classpath].join(path.delimiter),'fixture.derived.DerivedRuntime'];
  const {model} = analyze(fixture), compound = findMethod(model,fixture.names.compound);
  const results = [];
  for (const [engine,file] of Object.entries(configPaths)) {
    const config = JSON.parse(await fs.readFile(file,'utf8'));
    assert.equal(config.host,'127.0.0.1');
    assert.ok(Number.isInteger(config.port) && config.port > 0 && config.port < 65536);
    assert.match(config.database,/^[a-z_]+$/u);
    const execution = await execute(tool('java'),args,{...executeOptions,env:{...executeOptions.env,
      RB_DERIVED_JDBC_URL:'jdbc:'+engine+'://127.0.0.1:'+config.port+'/'+config.database+
        (engine==='mysql'?'?allowPublicKeyRetrieval=true&sslMode=DISABLED':''),
      RB_DERIVED_JDBC_USER:config.user,RB_DERIVED_JDBC_PASSWORD:config.password}});
    assert.equal(execution.code,0,execution.output);
    const receipt = Object.fromEntries(execution.output.split(/\r?\n/u).filter(line=>line.startsWith('RB_DERIVED|'))
      .map(line=>line.split('|').slice(1)));
    assert.match(receipt.server,engine==='mysql'?/^8\.4\./u:/^11\.4\..*MariaDB/u);
    assert.equal(receipt.parts,shape(compound));
    assert.equal(receipt.order,compound.derivedAnalysis.order.map(item=>item.path+':'+item.direction).join(','));
    assert.equal(receipt.limit,'3');
    assert.equal(receipt.implicit,'location.city');
    assert.equal(receipt.greedy,'locationPostal.code');
    assert.equal(receipt.compound,'Bob:70,Aaron:35,Alicia:35');
    assert.equal(receipt.page,'Aaron:35');
    assert.equal(receipt.explicit,'Alice:42,Alicia:35,Albert:17');
    assert.equal(receipt.greedyRows,'Bob:70');
    assert.equal(receipt.orderOnly,'Carla:80,Bob:70,Alice:42,Aaron:35,Alicia:35,Albert:17');
    assert.equal(receipt.in,'Bob:70,Aaron:35,Alicia:35');
    assert.equal(receipt.allCase,'Alicia:35');
    assert.equal(receipt.missing,'true');
    assert.equal(receipt.surplus,'Albert:17');
    results.push({engine,...receipt,ambiguityConservative:true,sourceArity:compound.derivedAnalysis.parameters.expected});
  }
  const receipt = process.env.ROCKETBRAIN_DERIVED_QUERY_RECEIPT;
  if (receipt) await fs.writeFile(receipt,JSON.stringify({jdk:'Temurin 25.0.5+8',springData:'4.1.2',hibernate:'7.4.13.Final',results},null,2)+'\n');
});
