'use strict';

const assert=require('node:assert/strict');
const test=require('node:test');
const Build=require('../src/spring/project-build');
const B=require('./helpers/spring-maven-bom-fixture');
const {ancestorInputs}=require('./spring-maven-parent-host');

function reviewed(engine='mysql'){
  const text=ancestorInputs(engine);
  const context={mavenParents:[
    {name:'../pom.xml',text:text.layer},{name:'../../pom.xml',text:text.grand}
  ]};
  const {catalog}=B.starterCatalog();
  const dependencies=Object.entries(catalog.dependencies).map(([id,item])=>({id,...item}));
  return {text,context,catalog:{dependencies}};
}

test('Spring starter review follows the declared local parent BOM and protects inherited modules',()=>{
  for(const engine of ['mysql','mariadb']){
    const {text,context,catalog}=reviewed(engine);
    const model=Build.inspect(text.leaf,'pom.xml',context);
    assert.equal(model.management.kind,'inherited-boot-bom');
    assert.equal(model.bootVersion,B.boot);
    assert.equal(model.management.chain.length,2);
    const inherited=Build.choices(model,catalog).find(row=>row.artifactId==='spring-boot-starter-webmvc');
    assert.equal(inherited.inherited,true);
    assert.equal(inherited.editable,false);
    assert.throws(()=>Build.change(text.leaf,model,catalog,{remove:[inherited.id]}),/direct declaration/);
    const change=Build.change(text.leaf,model,catalog,{add:['jdbc',engine],remove:['actuator']});
    assert.equal(change.bootVersion,B.boot);
    assert.match(change.after,/spring-boot-starter-jdbc/);
    assert.doesNotMatch(change.after,/spring-boot-starter-webmvc|spring-boot-starter-actuator/);
  }
});

test('a mismatched identity, duplicate management or shadowed version property prevents parent editing',()=>{
  const {text,context}=reviewed();
  assert.throws(()=>Build.inspect(text.leaf,'pom.xml',{mavenParents:[
    context.mavenParents[0],{...context.mavenParents[1],text:text.grand.replace('rocketbrain-company-platform','same-file-wrong-artifact')}
  ]}),/Maven parent identity/);
  assert.throws(()=>Build.inspect(text.leaf.replace('</project>','<properties><spring-boot.version>4.0.0</spring-boot.version></properties></project>'),
    'pom.xml',context),/redefines the inherited Boot BOM version/);
  assert.throws(()=>Build.inspect(text.leaf.replace('</project>','<dependencyManagement/><\/project>'),'pom.xml',context),
    /Layered child dependency management/);
  assert.throws(()=>Build.inspect(text.leaf,'pom.xml',{mavenParents:[
    {...context.mavenParents[0],text:text.layer.replace('</project>','<profiles/><\/project>')},context.mavenParents[1]
  ]}),/profile scope/);
});
