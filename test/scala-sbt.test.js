'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const { fileURLToPath } = require('node:url');
const { createSbtRunner,launcherCommands,observedProjects,mainClasses,testSuites,projectSbt } = require('../src/java/scala-sbt');
const { semanticDocuments,indexSemanticdb,definitionAt,referencesAt } = require('../src/java/scala-semanticdb');
const { populateScala,scala2,scala3 } = require('./helpers/scala-fixture');

const fixture=path.join(__dirname,'fixtures','java','scala-sbt');
const javaConfig=process.env.ROCKETBRAIN_JAVA_TEST_CONFIG, launcher=process.env.ROCKETBRAIN_SBT_LAUNCHER;

test('sbt observations select finite fully qualified commands and reject fabricated IDs',async () => {
  assert.deepEqual(await projectSbt(fixture),{sbtVersion:'1.13.1'});
  assert.deepEqual(launcherCommands('compile','app'),['app / compile']);
  assert.deepEqual(launcherCommands('run','app','scalafixture.Application'),['app / Compile / runMain scalafixture.Application']);
  assert.throws(() => launcherCommands('compile','app/other'),/observed sbt project/);
  assert.throws(() => launcherCommands('run','app','Invalid main'),/discovered main class/);
  assert.deepEqual(observedProjects('[info] In file:/tmp/app\r\n[info] \t   app\r\n[info] \t * root\r\n[info] later'),[
    {id:'app',current:false},{id:'root',current:true}
  ]);
  assert.deepEqual(mainClasses('[info] * scalafixture.Application\n[info] * scalafixture.Application\n[info] * too many words'),['scalafixture.Application']);
  assert.throws(() => semanticDocuments(Buffer.from([10,20,1,2])),/Truncated/);
});

test('Scala test discovery and debugging keep the selected sbt project and suite exact', async () => {
  assert.deepEqual(launcherCommands('suites','app'),[
    'set app / Test / definedTests / aggregate := false',
    'show app / Test / definedTests'
  ]);
  assert.deepEqual(launcherCommands('debugSuite','app','scalafixture.ApplicationSuite'),[
    'show app / Test / startTestSuitesDebugSession ["scalafixture.ApplicationSuite"]',
    'shell'
  ]);
  assert.deepEqual(testSuites([
    '[info] * Test scalafixture.ApplicationSuite : subclass(false, munit.Suite)',
    '[info] * Test scalafixture.SecondSuite : annotation(false, org.junit.Test)',
    '[info] * Test scalafixture.ApplicationSuite : subclass(false, munit.Suite)',
    '[info] * Test scalafixture.IncompleteSuite',
    '[info] * Test scalafixture.Invalid;Suite : annotation(false, org.junit.Test)',
    '[warn] * Test scalafixture.UnexpectedSuite : subclass(false, munit.Suite)'
  ].join('\r\n')),['scalafixture.ApplicationSuite','scalafixture.SecondSuite']);
  assert.throws(() => launcherCommands('suites'),/observed sbt project ID for Scala test suites/);
  assert.throws(() => launcherCommands('debugSuite','app','scalafixture.*'),/supported sbt test suite name/);
  assert.throws(() => launcherCommands('debugSuite','app','A; exit'),/supported sbt test suite name/);
  const runner=createSbtRunner();
  await assert.rejects(runner.run({action:'debugSuite'}),/managed Scala debug session/);
  await assert.rejects(runner.debugSuite({workspaceTrusted:true,allowProjectExecution:false}),/trusted local workspace/);
});

for (const version of [scala3,scala2]) test('real sbt 1.13.1 Scala '+version+' JDK build, tests, app and exact overloaded references',{
  skip:!javaConfig || !launcher || (process.env.ROCKETBRAIN_SBT_TEST_SCALA && process.env.ROCKETBRAIN_SBT_TEST_SCALA!==version),
  timeout:360000
},async context => {
  const parent=await fs.realpath(os.tmpdir()), owned=await fs.mkdtemp(path.join(parent,'rb-sbt-fixture-'));
  const root=path.join(owned,'app');
  const runner=createSbtRunner();
  context.after(async () => {
    await runner.dispose();
    const physical=await fs.realpath(owned);
    assert.equal(physical,owned);
    assert.equal(path.dirname(physical),parent);
    await fs.rm(physical,{recursive:true,force:true,maxRetries:8,retryDelay:250});
  });
  await populateScala(root,version);
  const {javaHome}=JSON.parse(await fs.readFile(javaConfig,'utf8'));
  const options={root,javaHome,launcher,cache:process.env.ROCKETBRAIN_SBT_CACHE || path.join(owned,'build-cache'),
    repositoryConfig:process.env.ROCKETBRAIN_SBT_REPOSITORIES,workspaceTrusted:true,allowProjectExecution:true};
  await assert.rejects(runner.run({...options,action:'compile',allowProjectExecution:false}),/trusted local workspace/);
  const discover=await runner.run({...options,action:'discover'});
  assert.equal(discover.state,'succeeded',discover.output);
  assert.deepEqual(observedProjects(discover.output).map(item => item.id),['app','core','root']);
  const compiled=await runner.run({...options,projectId:'app',action:'compile'});
  assert.equal(compiled.state,'succeeded',compiled.output);
  const mains=await runner.run({...options,projectId:'app',action:'mains'});
  assert.equal(mains.state,'succeeded',mains.output);
  assert.deepEqual(mainClasses(mains.output),['scalafixture.Application']);
  const tested=await runner.run({...options,projectId:'app',action:'test'});
  assert.equal(tested.state,'succeeded',tested.output);
  assert.match(tested.output,/Passed: Total 2, Failed 0, Errors 0, Passed 2/);
  const launched=await runner.run({...options,projectId:'app',action:'run',main:'scalafixture.Application'});
  assert.equal(launched.state,'succeeded',launched.output);
  assert.match(launched.output,/Scala greets Rocketbrain \/ Scala counted 3/);
  const index=indexSemanticdb(root);
  assert.equal(index.documents.size,3);
  const file=path.join(root,'app/src/main/scala/scalafixture/Application.scala');
  const raw=await fs.readFile(file,'utf8');
  const first=definitionAt(index,{file,text:raw,position:{line:3,character:35}});
  const second=definitionAt(index,{file,text:raw.replace(/\r?\n/g,'\r\n'),position:{line:4,character:32}});
  assert.notEqual(first.symbol,second.symbol);
  assert.equal(first.range.start.line,3);
  assert.equal(second.range.start.line,4);
  assert.equal(fileURLToPath(first.uri),path.join(root,'core/src/main/scala/scalafixture/Message.scala'));
  const firstUsages=referencesAt(index,{file,text:raw,position:{line:3,character:35}});
  const secondUsages=referencesAt(index,{file,text:raw,position:{line:4,character:32}});
  assert.deepEqual(firstUsages.map(item=>[item.symbol,item.range.start.line]),[[first.symbol,3]]);
  assert.deepEqual(secondUsages.map(item=>[item.symbol,item.range.start.line]),[[second.symbol,4]]);
  const declaration=fileURLToPath(first.uri), model=await fs.readFile(declaration,'utf8');
  assert.deepEqual(referencesAt(index,{file:declaration,text:model,position:first.range.start,includeDeclaration:true})
    .map(item=>path.relative(root,fileURLToPath(item.uri)).replaceAll('\\','/')),
    ['app/src/main/scala/scalafixture/Application.scala','core/src/main/scala/scalafixture/Message.scala']);
  assert.throws(() => definitionAt(index,{file,text:raw+'// unsaved',position:{line:3,character:35}}),/compile and index again/i);
  const build=path.join(root,'added.sbt');
  await fs.writeFile(build,'// new sbt settings\n');
  try {assert.throws(() => definitionAt(index,{file,text:raw,position:{line:3,character:35}}),/compile and index again/i);}
  finally {await fs.unlink(build);}
  await fs.appendFile(fileURLToPath(first.uri),'// edited after compile\n');
  assert.throws(() => definitionAt(index,{file,text:raw,position:{line:3,character:35}}),/compile and index again/i);
  assert.throws(() => referencesAt(index,{file,text:raw,position:{line:3,character:35}}),/compile and index again/i);
  const proof={sbt:compiled.sbtVersion,scala:version,projects:observedProjects(discover.output).map(item => item.id),
    tests:2,runOutput:'Scala greets Rocketbrain / Scala counted 3',documents:index.documents.size,
    overloads:[first,second].map(item => ({symbol:item.symbol,line:item.range.start.line+1})),referencesPerOverload:[1,1],staleRejected:true};
  const receipt=version===scala2?process.env.ROCKETBRAIN_SBT_SCALA2_RECEIPT:process.env.ROCKETBRAIN_SBT_RECEIPT;
  if (receipt) await fs.writeFile(receipt,JSON.stringify(proof,null,2)+'\n',{flag:'wx'});
});
