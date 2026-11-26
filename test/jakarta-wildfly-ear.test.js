'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {test}=require('node:test');
const {zip,temporary}=require('./helpers/spring-project-tools-fixture');
const {inspectEar,parseApplication}=require('../src/java/jakarta-ear');
const {mavenEarProject,listEarArtifacts,listWarArtifacts}=require('../src/java/jakarta-war');

const descriptor='<application xmlns="https://jakarta.ee/xml/ns/jakartaee" version="11">' +
  '<module><web><web-uri>inventory.war</web-uri><context-root>/stock-view</context-root></web></module>' +
  '<module><ejb>inventory-beans.jar</ejb></module><library-directory>lib</library-directory></application>';
const xml=value=>Buffer.from(value);
const war=zip([{name:'WEB-INF/web.xml',data:'<web-app/>'}]);
const beans=zip([{name:'META-INF/MANIFEST.MF',data:'Manifest-Version: 1.0\n'}]);

test('EAR descriptor binds only the declared web and EJB modules and a literal safe context',()=>{
  assert.deepEqual(parseApplication(xml(descriptor)),{
    descriptorVersion:'11',context:'stock-view',war:'inventory.war',ejb:'inventory-beans.jar'
  });
  for(const revised of [
    descriptor.replace('/stock-view','/another/path'),
    descriptor.replace('inventory.war','subdir/inventory.war'),
    descriptor.replace('inventory-beans.jar','inventory.jar'),
    descriptor.replace('</module><module>','<alt-dd>elsewhere.xml</alt-dd></module><module>'),
    descriptor.replace('jakarta.ee/xml/ns/jakartaee','not-the-jakarta-namespace'),
    '<!DOCTYPE application>'+descriptor
  ])assert.throws(()=>parseApplication(xml(revised)),/bounded Maven EAR/u);
});

test('physical Maven EAR review reconciles archived byte signatures and refuses unsafe or alternative layout',async ()=>{
  await fs.mkdir(path.join(__dirname,'../test-output'),{recursive:true});
  const owned=temporary();
  try{
    const root=owned.root, target=path.join(root,'target'), file=path.join(target,'fixture.ear');
    await fs.mkdir(target);
    await fs.writeFile(path.join(root,'pom.xml'),'<project><packaging>ear</packaging><artifactId>owned</artifactId></project>');
    const project={root,tool:'maven'};
    const entries=[
      {name:'META-INF/application.xml',data:descriptor},
      {name:'inventory.war',data:war},
      {name:'inventory-beans.jar',data:beans},
      {name:'lib/contract.jar',data:beans},
      {name:'META-INF/MANIFEST.MF',data:'Manifest-Version: 1.0\nClass-Path: lib/contract.jar\n'}
    ];
    await fs.writeFile(file,zip(entries));
    assert.ok(mavenEarProject(project).buildFingerprint);
    assert.equal(listEarArtifacts(project)[0].name,'fixture.ear');
    assert.throws(()=>listWarArtifacts(project),/declare WAR packaging/u);
    const reviewed=await inspectEar(file);
    assert.deepEqual([reviewed.context,reviewed.web.bytes,reviewed.ejb.bytes,reviewed.libraries],
      ['stock-view',war.length,beans.length,['lib/contract.jar']]);
    for(const rejected of [
      entries.filter(item=>item.name!=='inventory-beans.jar'),
      [...entries,{name:'unreviewed.war',data:war}],
      [...entries,{name:'META-INF/jboss-app.xml',data:'<jboss-app/>'}],
      [...entries,{name:'INVENTORY.war',data:war}],
      entries.map(item=>item.name==='inventory.war'?{...item,data:zip([{name:'WEB-INF/jboss-web.xml',data:'<jboss-web/>'}])}:item),
      entries.map(item=>item.name==='inventory-beans.jar'?{...item,badCrc:true}:item),
      entries.map(item=>item.name==='lib/contract.jar'?{...item,data:'not a JAR'}:item),
      entries.map(item=>item.name==='META-INF/MANIFEST.MF'?{...item,data:'Manifest-Version: 1.0\nClass-Path: ../outside.jar\n'}:item),
      entries.map(item=>item.name==='META-INF/MANIFEST.MF'?{...item,data:'Manifest-Version: 1.0\nClass-Path: lib/absent.jar\n'}:item)
    ]){
      await fs.writeFile(file,zip(rejected));
      await assert.rejects(inspectEar(file),/bounded Maven EAR/u);
    }
  }finally{owned.close();}
});
