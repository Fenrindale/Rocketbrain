'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const build=require('../src/spring/project-build');
const fixture=require('./helpers/spring-maven-bom-fixture');

const catalog={dependencies:Object.entries(fixture.starterCatalog().catalog.dependencies).map(([id,value])=>({id,...value}))};
const block=(text,name)=>new RegExp('<'+name+'>[\\s\\S]*?<\\/'+name+'>').exec(text)?.[0];
const direct=/<dependencies>\s*<!-- Preserve the existing web dependency\. -->[\s\S]*?<\/dependencies>/;
const inspect=text=>build.inspect(text,'pom.xml');

test('Maven edits literal and local-property Boot imports without changing management, plugins, or comments',()=>{
  for(const [engine,other] of [['mysql','mariadb'],['mariadb','mysql']]){
    const original=fixture.pomFor(engine),model=inspect(original);
    assert.equal(model.bootVersion,fixture.boot);
    assert.equal(model.management.kind,'boot-bom-import');
    assert.equal(model.management.property,engine==='mysql'?'spring-boot.version':null);
    assert.equal(model.management.expression,engine==='mysql'?'${spring-boot.version}':fixture.boot);
    const choices=build.choices(model,catalog);
    assert.equal(choices.find(item=>item.id===engine).editable,true);
    assert.equal(choices.find(item=>item.id===other).editable,false);
    assert.throws(()=>build.change(original,model,catalog,{add:[other]}),/local Maven management override/);
    const modified=build.change(original,model,catalog,{add:['jdbc',engine],remove:['actuator']}).after;
    assert.equal(original.replace(direct,'<direct/>'),modified.replace(direct,'<direct/>'));
    for(const name of ['properties','dependencyManagement','build'])assert.equal(block(original,name),block(modified,name));
    assert.match(modified,/Preserve the existing web dependency/);
    const changed=inspect(modified);
    assert.deepEqual(changed.management,model.management);
    assert.deepEqual(changed.deps.map(item=>[item.artifactId,item.scope]),[
      ['spring-boot-starter-webmvc','compile'],['spring-boot-starter-jdbc','compile'],[fixture.drivers[engine].artifact,'runtime']
    ]);
  }
});

test('Maven leaves direct overridden modules alone and treats coordinate aliases as one module',()=>{
  const driver=fixture.drivers.mysql;
  const original=fixture.pomFor('mariadb').replace('<!-- Preserve the existing web dependency. -->',
    '<dependency><groupId>'+driver.group+'</groupId><artifactId>'+driver.artifact+'</artifactId></dependency>');
  const model=inspect(original);
  const choice=build.choices(model,catalog).find(item=>item.id==='mysql');
  assert.equal(choice.selected,true);
  assert.equal(choice.editable,false);
  assert.equal(choice.localManagementVersion,driver.version);
  assert.throws(()=>build.change(original,model,catalog,{remove:['mysql']}),/local Maven management override/);
  const alias={...catalog.dependencies.find(item=>item.id==='jdbc'),id:'jdbc-alias'};
  assert.throws(()=>build.change(original,model,{dependencies:[...catalog.dependencies,alias]},{add:['jdbc','jdbc-alias']}),/each module once/);
});

test('Maven creates or expands an empty direct dependency block while preserving its management block',()=>{
  for(const initial of ['', '<dependencies />', '<dependencies></dependencies>']){
    const text=fixture.pomFor('mysql').replace(direct,initial);
    const model=inspect(text);
    assert.deepEqual(model.deps,[]);
    const changed=build.change(text,model,catalog,{add:['jdbc','mysql']}).after;
    assert.equal(block(changed,'dependencyManagement'),block(text,'dependencyManagement'));
    assert.deepEqual(inspect(changed).deps.map(item=>[item.artifactId,item.scope]),[
      ['spring-boot-starter-jdbc','compile'],['mysql-connector-j','runtime']
    ]);
  }
});

test('Maven refuses ambiguous management, external interpolation and project models beyond the review',()=>{
  const original=fixture.pomFor('mysql');
  const boot=/<dependency>\s*<groupId>org\.springframework\.boot<\/groupId>\s*<artifactId>spring-boot-dependencies<\/artifactId>[\s\S]*?<\/dependency>/.exec(original)[0];
  const version='<spring-boot.version>'+fixture.boot+'</spring-boot.version>';
  const cases=[
    [original.replace(boot,boot+boot),/Duplicate Maven management/],
    [original.replace(boot,boot+boot.replace('org.springframework.boot','example').replace('spring-boot-dependencies','another-bom')),/Additional BOM imports/],
    [original.replace('<type>pom</type>',''),/requires pom type and import scope/],
    [original.replace('<scope>import</scope>','<scope>compile</scope>'),/requires pom type and import scope/],
    [original.replace(version,''),/uniquely declared literal property/],
    [original.replace(version,version+version),/Duplicate build configuration/],
    [original.replace(version,'<spring-boot.version>${other}</spring-boot.version>'),/uniquely declared literal property/],
    [original.replaceAll('spring-boot.version','env.VERSION'),/uniquely declared literal property/],
    [original.replace('</project>','<profiles><profile><id>implicit</id><activation><activeByDefault>true</activeByDefault></activation></profile></profiles></project>'),/literal Maven profiles/],
    [original.replace('</project>','<modules/></project>'),/application POM within the Maven reactor/],
    [original.replace('</project>','<parent><groupId>example</groupId><artifactId>external</artifactId><version>1.0.0</version></parent></project>'),/parentless POM/],
    [original.replace('</project>','<parent><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-parent</artifactId><version>4.1.2</version></parent></project>'),/layered on a Spring Boot parent/]
  ];
  for(const [text,message] of cases)assert.throws(()=>inspect(text),message);
});
