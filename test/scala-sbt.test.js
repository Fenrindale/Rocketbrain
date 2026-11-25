'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const { fileURLToPath } = require('node:url');
const { createSbtRunner,launcherCommands,observedProjects,mainClasses,projectSbt } = require('../src/java/scala-sbt');
const { semanticDocuments,indexSemanticdb,definitionAt } = require('../src/java/scala-semanticdb');

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

test('real sbt 1.13.1 multi-module Scala 3.9.0 JDK build, tests, app and overload definitions',{
  skip:!javaConfig || !launcher,timeout:360000
},async context => {
  const parent=await fs.realpath(os.tmpdir()), owned=await fs.mkdtemp(path.join(parent,'rb-sbt-fixture-'));
  const root=path.join(owned,'app');
  context.after(async () => {
    const physical=await fs.realpath(owned);
    assert.equal(physical,owned);
    assert.equal(path.dirname(physical),parent);
    await fs.rm(physical,{recursive:true,force:true,maxRetries:8,retryDelay:250});
  });
  await fs.cp(fixture,root,{recursive:true});
  const {javaHome}=JSON.parse(await fs.readFile(javaConfig,'utf8'));
  const options={root,javaHome,launcher,cache:process.env.ROCKETBRAIN_SBT_CACHE || path.join(owned,'build-cache'),
    repositoryConfig:process.env.ROCKETBRAIN_SBT_REPOSITORIES,workspaceTrusted:true,allowProjectExecution:true};
  const runner=createSbtRunner();
  context.after(() => runner.dispose());
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
  assert.throws(() => definitionAt(index,{file,text:raw+'// unsaved',position:{line:3,character:35}}),/compile and index again/i);
  const build=path.join(root,'added.sbt');
  await fs.writeFile(build,'// new sbt settings\n');
  try {assert.throws(() => definitionAt(index,{file,text:raw,position:{line:3,character:35}}),/compile and index again/i);}
  finally {await fs.unlink(build);}
  await fs.appendFile(fileURLToPath(first.uri),'// edited after compile\n');
  assert.throws(() => definitionAt(index,{file,text:raw,position:{line:3,character:35}}),/compile and index again/i);
  const proof={sbt:compiled.sbtVersion,scala:'3.9.0',projects:observedProjects(discover.output).map(item => item.id),
    tests:2,runOutput:'Scala greets Rocketbrain / Scala counted 3',documents:index.documents.size,
    overloads:[first,second].map(item => ({symbol:item.symbol,line:item.range.start.line+1})),staleRejected:true};
  if (process.env.ROCKETBRAIN_SBT_RECEIPT) await fs.writeFile(process.env.ROCKETBRAIN_SBT_RECEIPT,JSON.stringify(proof,null,2)+'\n');
});
