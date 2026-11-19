'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {mavenBuild,moveClientProof,compileReachable}=require('../src/java/move-builds');

const fixture=path.join(__dirname,'fixtures/refactoring-v24-maven');
const modules=['rb24-core','rb24-app','rb24-consumer'];
const consumer='rb24-consumer',source='rb24-app',target='rb24-core';

function changedFixture(change) {
 const base=path.resolve('test-output/v0.24-maven-contract');
 fs.mkdirSync(base,{recursive:true});
 const root=fs.mkdtempSync(path.join(base,'case-'));
 for(const directory of ['',...modules]){
  if(directory)fs.mkdirSync(path.join(root,directory));
  const file=path.join(directory,'pom.xml');
  const text=fs.readFileSync(path.join(fixture,file),'utf8');
  fs.writeFileSync(path.join(root,file),change(directory,text));
 }
 return root;
}

test('same-POM Maven profiles replace matching JAR dependencies in declaration order across every activation subset',()=>{
 const build=mavenBuild(fixture);
 assert.equal(build.dynamicContracts.scenarioCount,4);
 assert.equal(build.dynamicContracts.executedBuildCode,false);
 assert.deepEqual(build.scenarios.map(s=>s.edgeKinds.get(consumer).get(source)),['compile','runtime','compile','compile']);
 assert.deepEqual(build.scenarios[3].overrides.map(s=>s.profile),['rb24-runtime','rb24-compile']);
 const client=moveClientProof(build,source,target).reviewedClients.find(v=>v.project===consumer);
 assert.deepEqual(client.sourceExposureByScenario,[true,false,true,true]);
 assert.deepEqual(client.destinationExposureByScenario,[true,true,true,true]);
});

test('a direct profile scope override hides a compile destination even with a transitive compile path',()=>{
 const lowerScope='<dependency><groupId>org.rocketbrain.fixture.v24</groupId><artifactId>rb24-core</artifactId><version>1.0.0</version><scope>runtime</scope></dependency>';
 const root=changedFixture((module,text)=>module===consumer?text.replace('</dependencies>\n        </profile>\n    </profiles>',`${lowerScope}</dependencies>\n        </profile>\n    </profiles>`):text);
 const build=mavenBuild(root);
 assert.equal(compileReachable(build.scenarios[2],consumer,source),true);
 assert.equal(compileReachable(build.scenarios[2],consumer,target),false);
 assert.throws(()=>moveClientProof(build,source,target),/compile client rb24-consumer/);
});

test('provided dependencies expose direct compile symbols and do not propagate through another module',()=>{
 const root=changedFixture((module,text)=>{
  if(module===source)return text.replace('<scope>compile</scope>','<scope>provided</scope>');
  if(module===consumer)return text.replace(/^\s*<dependency>[^\n]*<artifactId>rb24-core<\/artifactId>[^\n]*\n/m,'\n');
  return text;
 });
 const build=mavenBuild(root);
 assert.equal(compileReachable(build,source,target),true);
 assert.equal(compileReachable(build.scenarios[0],consumer,target),false);
 assert.throws(()=>moveClientProof(build,source,target),/compile client rb24-consumer/);
});

test('restricted direct scope does not hide a possible source client from the Move proof',()=>{
 const group='org.rocketbrain.fixture.v24';
 const bridge='rb24-bridge';
 const root=changedFixture((module,text)=>{
  if(!module)return text.replace('</modules>',`<module>${bridge}</module></modules>`);
  if(module!==consumer)return text;
  const base=text.replace(/<profiles>[\s\S]*?<\/profiles>/,'').replaceAll('<scope>compile</scope>','<scope>runtime</scope>');
  const dependency=`<dependency><groupId>${group}</groupId><artifactId>${bridge}</artifactId><version>1.0.0</version></dependency>`;
  return base.replace('</dependencies>',dependency+'</dependencies>');
 });
 const folder=path.join(root,bridge);
 fs.mkdirSync(folder);
 fs.writeFileSync(path.join(folder,'pom.xml'),`<project><modelVersion>4.0.0</modelVersion><groupId>${group}</groupId><artifactId>${bridge}</artifactId><version>1.0.0</version><dependencies><dependency><groupId>${group}</groupId><artifactId>${source}</artifactId><version>1.0.0</version></dependency></dependencies></project>`);
 const build=mavenBuild(root);
 assert.equal(compileReachable(build,consumer,source),false);
 assert.throws(()=>moveClientProof(build,source,target),/compile client rb24-consumer/);
});

test('Maven exposes runtime children of a provided dependency but omits the provided grandchild',()=>{
 const group='org.rocketbrain.fixture.v24',bridge='rb24-bridge';
 const dep=(artifact,scope)=>`<dependency><groupId>${group}</groupId><artifactId>${artifact}</artifactId><version>1.0.0</version><scope>${scope}</scope></dependency>`;
 const root=changedFixture((module,text)=>{
  if(!module)return text.replace('</modules>',`<module>${bridge}</module></modules>`);
  if(module===source)return text.replace('<scope>compile</scope>','<scope>provided</scope>');
  if(module===consumer)return text.replace(/<profiles>[\s\S]*?<\/profiles>/,'').replace(/<dependencies>[\s\S]*?<\/dependencies>/,`<dependencies>${dep(bridge,'provided')}</dependencies>`);
  return text;
 });
 const folder=path.join(root,bridge);
 fs.mkdirSync(folder);
 fs.writeFileSync(path.join(folder,'pom.xml'),`<project><modelVersion>4.0.0</modelVersion><groupId>${group}</groupId><artifactId>${bridge}</artifactId><version>1.0.0</version><dependencies>${dep(source,'runtime')}</dependencies></project>`);
 const build=mavenBuild(root);
 assert.equal(compileReachable(build,consumer,source),true);
 assert.equal(compileReachable(build,consumer,target),false);
 assert.throws(()=>moveClientProof(build,source,target),/compile client rb24-consumer/);
});

test('a profile that substitutes another version of a reactor artifact fails closed',()=>{
 const root=changedFixture((module,text)=>module===consumer?text.replace(/(<id>rb24-runtime<\/id>[\s\S]*?<artifactId>rb24-app<\/artifactId><version>)1\.0\.0/,(_match,prefix)=>prefix+'9.9.9'):text);
 assert.throws(()=>mavenBuild(root),/exact reviewed reactor version/);
});
