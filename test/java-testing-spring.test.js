'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const file=process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG,runtime=file?JSON.parse(fs.readFileSync(file,'utf8')):null;
const tools=process.env.ROCKETBRAIN_JAVA_TESTING_RUNTIME||path.resolve('test-output/java-testing-runtime/java-testing-runtime.json');
test('independent JUnit runner executes real Spring/DB tests, dynamic cases and exact JVM coverage with rollback isolation',{skip:!runtime||!fs.existsSync(tools)?'Use a provisioned Java testing runtime and spring-project.js run --engine mysql|mariadb.':false,timeout:180000},async()=>{
  const {discoverTests,runTests}=require('../src/java/testing'),config=require('./java-testing-fixture').fixtureTestingConfig(runtime);
  const selectors=[{kind:'class',value:'fixture.boot.RocketbrainSpringTest'}];
  const discovered=await discoverTests(config,{selectors});assert.equal(discovered.state,'completed',JSON.stringify(discovered.errors));
  assert.ok(discovered.tests.some(t=>t.methodName==='policy'));assert.ok(discovered.tests.some(t=>t.methodName==='dynamicPolicies'));assert.ok(discovered.tests.some(t=>t.uri?.endsWith('RocketbrainSpringTest.java')));
  const outcome=await runTests(config,{selectors,coverage:true});assert.equal(outcome.state,'completed',JSON.stringify(outcome.errors));assert.equal(outcome.summary.testsFailed,0,JSON.stringify(outcome.summary));assert.equal(outcome.summary.containersFailed,0,JSON.stringify(outcome.summary));assert.ok(outcome.summary.testsSucceeded>=7,JSON.stringify(outcome.summary));assert.ok(outcome.summary.testsSkipped>=1);assert.ok(outcome.events.some(e=>e.type==='dynamic'));
  assert.equal(outcome.coverage.state,'available',JSON.stringify(outcome.coverage.warnings));assert.equal(outcome.coverage.perTestCoverage,false);
  const policy=outcome.coverage.files.find(f=>f.uri.endsWith('/RiskPolicy.java'));assert.ok(policy);assert.ok(policy.lines.covered>0&&policy.lines.covered<policy.lines.total);assert.ok(policy.branches.covered>0&&policy.branches.covered<policy.branches.total);assert.ok(policy.methods.covered>0&&policy.methods.covered<policy.methods.total);
  const response=await fetch(runtime.baseUrl+'/probe/testing-state');assert.equal(response.status,200);const isolation=await response.json();assert.deepEqual(isolation,{people:2,departments:1,rolledBackNames:0});
  const serialized=JSON.stringify({asOf:new Date().toISOString(),engine:runtime.dbEngine,naming:runtime.naming,discovery:{state:discovered.state,tests:discovered.tests},run:{state:outcome.state,summary:outcome.summary,events:outcome.events,coverage:outcome.coverage,runDirectory:outcome.runDirectory},isolation,scope:'Actual Spring context/JPA on the owned running server; ddl-auto none and seed disabled in the test JVM; test transaction is rolled back.'},null,2);
  assert.ok(!serialized.includes(config.env.SPRING_DATASOURCE_PASSWORD));fs.writeFileSync(path.resolve('test-output/'+(process.env.ROCKETBRAIN_TEST_REPORT_PREFIX||"v0.9")+'-junit-spring-'+runtime.dbEngine+'-'+runtime.naming+'.json'),serialized+'\n');
});
