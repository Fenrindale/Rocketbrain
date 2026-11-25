'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const {test} = require('node:test');
const Build = require('../src/spring/project-build');
const {sha} = require('../src/spring/project-client');
const {SpringProjectTools} = require('../src/spring/project-tools');
const {starterCatalog} = require('./helpers/spring-maven-bom-fixture');
const {inputs,verify} = require('./helpers/spring-gradle-catalog-fixture');

const metadata = {dependencies:Object.entries(starterCatalog().catalog.dependencies).map(([id,value])=>({id,...value}))};

test('existing Gradle catalog aliases and explicit Boot platform are used in Groovy and Kotlin starter edits',()=>{
  for (const engine of ['mysql','mariadb']) {
    const source = inputs(engine), model = Build.inspect(source.build,source.buildName,source);
    assert.equal(model.management.property,'bootRelease');
    assert.equal(model.management.platformAlias,'boot-bom');
    const choices = Build.choices(model,metadata);
    assert.equal(choices.find(item=>item.id===engine).editable,true);
    assert.equal(choices.find(item=>item.id===source.other).editable,false);
    const changed = Build.change(source.build,model,metadata,{add:['jdbc',engine],remove:['actuator']});
    const inspected = Build.inspect(changed.after,source.buildName,source);
    assert.deepEqual(inspected.management,model.management);
    assert.deepEqual(inspected.deps.map(item=>[item.alias,item.configuration]),[
      ['ui-web','implementation'],['data-jdbc','implementation'],['database-'+engine,'runtimeOnly']
    ]);
    assert.ok(changed.after.includes('// Keep this comment and order.'));
    assert.throws(()=>Build.change(source.build,model,metadata,{add:[source.other]}),/one existing unversioned catalog alias/u);
  }
});

test('catalog checks refuse conflicting BOMs, unresolved aliases and custom Gradle resolution',()=>{
  const source = inputs('mysql');
  const inspect = (build=source.build,versionCatalog=source.versionCatalog,settings=source.settings)=>
    Build.inspect(build,source.buildName,{versionCatalog,settings});
  assert.throws(()=>inspect(source.build,source.versionCatalog.replace(
    'version.ref = "bootRelease" }\nui-web','version = "4.1.1" }\nui-web')),/same Boot version/u);
  assert.throws(()=>inspect(source.build.replace('alias(libs.plugins.spring.boot)','alias(libs.plugins.spring.boot) apply false')),/standalone direct/u);
  assert.throws(()=>inspect(source.build,source.versionCatalog.replace('"bootRelease"','"missingVersion"')),/locally declared/u);
  assert.throws(()=>inspect(source.build.replace('libs.ops.actuator','libs.bundles.observability')),/unresolved or unsupported/u);
  assert.throws(()=>Build.inspect(source.build,source.buildName,{versionCatalog:source.versionCatalog}),/saved root settings file/u);
  assert.throws(()=>inspect(source.build,source.versionCatalog,source.settings+'includeBuild("another")\n'),/composite projects/u);
  assert.throws(()=>inspect(source.build+'configurations.all { resolutionStrategy.force("fixture:artifact:5.0") }\n'),/Custom dependency resolution/u);
  const duplicate = inspect(source.build,source.versionCatalog.replace('[bundles]',
    'another-jdbc = { module = "org.springframework.boot:spring-boot-starter-jdbc" }\n[bundles]'));
  assert.equal(Build.choices(duplicate,metadata).find(item=>item.id==='jdbc').editable,false);
  assert.throws(()=>Build.change(source.build,duplicate,metadata,{add:['jdbc']}),/one existing unversioned catalog alias/u);
});

test('live Gradle catalog BOM starter changes compile and run Spring Boot on MySQL and MariaDB',{
  skip:process.env.ROCKETBRAIN_GRADLE_CATALOG_LIVE!=='1' && 'Use the owned Gradle and database fixtures.',
  timeout:420000
},async ()=>{
  const starters = {mysql:require('../scripts/integration-mysql').startMysqlFixture,mariadb:require('../scripts/integration-db').startFixture};
  const service = new SpringProjectTools({writeBuildFile:async change=>{
    change.guard();
    assert.equal(sha(await fs.readFile(change.path)),change.beforeSha256);
    await fs.writeFile(change.path,change.after);
    return {saved:true,nativeUndo:false};
  }});
  const results = [];
  try {
    for (const [engine,start] of Object.entries(starters)) {
      const fixture = await start();
      try {
        assert.equal(fixture.config.database,'rocketbrain_fixture');
        await fixture.withAdmin(async connection=>{
          await connection.query('CREATE TABLE rocketbrain_fixture.rb_spring_department (id INT PRIMARY KEY)');
          await connection.query('CREATE TABLE rocketbrain_fixture.rb_spring_person (id INT PRIMARY KEY)');
          await connection.query('INSERT INTO rocketbrain_fixture.rb_spring_department VALUES (1)');
          await connection.query('INSERT INTO rocketbrain_fixture.rb_spring_person VALUES (1),(2)');
        });
        results.push(await verify(service,{dbEngine:engine,dbConfigPath:fixture.configPath}));
      } finally {
        await fixture.close();
      }
    }
  } finally {
    service.dispose();
  }
  if (process.env.ROCKETBRAIN_GRADLE_CATALOG_RECEIPT) await fs.writeFile(process.env.ROCKETBRAIN_GRADLE_CATALOG_RECEIPT,
    JSON.stringify({jdk:'Temurin 25.0.5+8',results},null,2)+'\n');
});
