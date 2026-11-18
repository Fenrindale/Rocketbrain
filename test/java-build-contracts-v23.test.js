'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {normalizeGradleContracts}=require('../src/java/move-build-contracts');
const {gradleBuild,mavenBuild,moveClientProof}=require('../src/java/move-builds');

const gradleRoot=path.resolve(__dirname,'fixtures/refactoring-v23-build');
const dependency=target=>`<dependencies><dependency><groupId>fixture</groupId><artifactId>${target}</artifactId><version>1</version></dependency></dependencies>`;
const profile=(id,activation,deps)=>`<profile><id>${id}</id><activation>${activation}</activation>${deps}</profile>`;
const property='<property><name>extraPath</name><value>enabled</value></property>';

function mavenFixture(client,source=dependency('core'),rootExtra='') {
 const base=path.resolve('test-output/v0.23-maven-contract');
 fs.mkdirSync(base,{recursive:true});
 const root=fs.mkdtempSync(path.join(base,'case-'));
 const identity='<groupId>fixture</groupId><artifactId>reactor</artifactId><version>1</version>';
 const modules=['app','core','client'];
 const pom=body=>`<project><modelVersion>4.0.0</modelVersion>${body}</project>`;
 fs.writeFileSync(path.join(root,'pom.xml'),pom(`${identity}<packaging>pom</packaging><modules>${modules.map(name=>`<module>${name}</module>`).join('')}</modules>${rootExtra}`));
 for(const [name,body] of [['app',source],['core',''],['client',client]]){
  fs.mkdirSync(path.join(root,name));
  fs.writeFileSync(path.join(root,name,'pom.xml'),pom(`<parent>${identity}</parent><artifactId>${name}</artifactId>${body}`));
 }
 return root;
}

test('compound Gradle predicates preserve three distinct routes and every compile client can reach the destination',()=>{
 const build=gradleBuild(gradleRoot);
 assert.equal(build.scenarios.length,3);
 assert.deepEqual(build.scenarios.map(scenario=>scenario.graph.get('v23-app')),[['v23-bridge'],['v23-core'],['v23-alternate']]);
 assert.deepEqual(build.dynamicContracts.contracts[0].predicates.map(condition=>condition.atoms.map(atom=>atom.property)),[['route','skipBridge'],['route']]);
 assert.equal(moveClientProof(build,'v23-app','v23-core').scenarioCount,3);
});

test('Gradle condition parser refuses effects, unknown providers and an incomplete else-if chain',()=>{
 const atom="providers.gradleProperty('route').getOrElse('bridge') == 'bridge'";
 const use="implementation project(':core')";
 for(const candidate of [`if (${atom} || System.getenv('UNREVIEWED')) { ${use} } else { ${use} }`,
  `if (${atom}) { ${use} } else if (${atom}) { ${use} }`,
  `if (${atom} && providers.gradleProperty('route').isPresent()) { ${use} } else { ${use} }`]){
  assert.throws(()=>normalizeGradleContracts(`dependencies {${candidate}}`),/Gradle|exhaustive/);
 }
});

test('Maven considers profile-only source consumers even when they are absent from the imported active classpath',()=>{
 const optional=`<profiles>${profile('extra',property,dependency('app'))}</profiles>`;
 const build=mavenBuild(mavenFixture(dependency('core')+optional));
 assert.equal(build.scenarios.length,2);
 assert.equal(build.dynamicContracts.executedBuildCode,false);
 const client=moveClientProof(build,'app','core').reviewedClients.find(item=>item.project==='client');
 assert.deepEqual(client.sourceExposureByScenario,[false,true]);
 assert.deepEqual(client.destinationExposureByScenario,[true,true]);
 assert.throws(()=>moveClientProof(mavenBuild(mavenFixture(optional)),'app','core'),/compile client client/);
});

test('Maven refuses inherited profiles, activation effects and dependency overrides',()=>{
 const optional=`<profiles>${profile('extra',property,dependency('app'))}</profiles>`;
 assert.throws(()=>mavenBuild(mavenFixture('',dependency('core'),optional)),/inherited/);
 assert.throws(()=>mavenBuild(mavenFixture(`<profiles>${profile('extra','<file><exists>some-file</exists></file>',dependency('app'))}</profiles>`)),/unreviewed/);
 assert.throws(()=>mavenBuild(mavenFixture(dependency('app')+optional)),/overrides/);
});
