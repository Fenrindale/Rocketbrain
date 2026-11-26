'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {test} = require('node:test');
const {createDelegatedBuild,observe} = require('../src/java/delegated-build');
const {BuildTasks} = require('../src/java/workbench-tasks');
const {execute} = require('../src/java/testing/provision');
const {springJdbcClasspath} = require('./helpers/instance-inline-fixture');
const {createProject,adjustment,directory} = require('./helpers/java-delegated-build-fixture');

async function ownedDirectory(t) {
  const parent = await fs.realpath(os.tmpdir()), name = await fs.mkdtemp(path.join(parent,'rb-compile-review-'));
  t.after(async()=>{
    const real = await fs.realpath(name);
    assert.equal(real,name); assert.equal(path.dirname(real),parent);
    await fs.rm(real,{recursive:true,force:true,maxRetries:8,retryDelay:200});
  });
  return name;
}

test('delegated compile review is one-shot and refuses a disk change before configuration or execution',async t=>{
  const root = await ownedDirectory(t), fixture = await createProject(root,'gradle');
  const calls = [];
  const service = createDelegatedBuild({projectFor:fixture.model,assertTrusted(){},
    taskFor(_project,task){calls.push('configuration');return {id:task,name:task};},
    runTask(){calls.push('compile');return {state:'failed',exitCode:1};}});
  t.after(()=>service.dispose());
  const input = {projectUri:fixture.model().uri}, apply = id=>service.apply({id,allowProjectExecution:true});
  const stale = await service.prepare(input);
  assert.equal(stale.task,':classes');
  await assert.rejects(service.apply({id:stale.id}),/Run Delegated Compile/u);
  await fs.writeFile(fixture.source,adjustment('"invalid"'));
  await assert.rejects(apply(stale.id),/inputs changed/u);
  assert.deepEqual(calls,[]);

  const latest = await service.prepare(input);
  const result = await apply(latest.id);
  assert.equal(result.state,'failed');
  assert.equal(result.classes.state,'unverified');
  assert.deepEqual(calls,['configuration','compile']);
  await assert.rejects(apply(latest.id),/Review the delegated compile again/u);
  await assert.rejects(service.prepare({...input,retryFrom:'other'}),/current failed/u);
  await fs.writeFile(fixture.source,adjustment('8'));
  const retry = await service.prepare({...input,retryFrom:result.id});
  assert.equal(retry.retryOf,result.id);
  assert.deepEqual(retry.sincePrevious.changed,[directory+'/Adjustment.java']);
  service.invalidate();
  await assert.rejects(apply(retry.id),/Review the delegated compile again/u);
  assert.deepEqual(service.report(),[]);
});

test('a repeat reports preserved class files only when execution and unchanged inputs were observed',()=>{
  const before = new Map([['Adjustment.class',{hash:'hash1',stamp:'stamp1'}]]);
  const renders = [
    ['succeeded',false,before,'outputs-reused'],['failed',false,before,'unverified'],
    ['succeeded',true,before,'unverified'],['succeeded',false,undefined,'unobserved'],
    ['succeeded',false,new Map([['Adjustment.class',{hash:'hash1',stamp:'stamp2'}]]),'outputs-updated'],
    ['succeeded',false,new Map(),'no-classes']
  ];
  for (const [outcome,inputsChanged,after,state] of renders) {
    assert.equal(observe({before,after,outcome,inputsChanged}).state,state);
  }
});

const javaConfig = process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;
const springClasspath = process.env.ROCKETBRAIN_DELEGATED_CLASSPATH;
const gradleUserHome = process.env.ROCKETBRAIN_DELEGATED_GRADLE_USER_HOME;
const mavenHome = process.env.ROCKETBRAIN_DELEGATED_MAVEN_HOME;
const mavenRepository = process.env.ROCKETBRAIN_DELEGATED_MAVEN_REPOSITORY;

async function tools() {
  const {javaHome,gradleHome} = JSON.parse(await fs.readFile(javaConfig,'utf8'));
  for (const [home,marker] of [[gradleHome,'lib/gradle-launcher-9.1.0.jar'],[mavenHome,'bin/m2.conf']]) {
    assert.ok(path.isAbsolute(home));
    assert.ok((await fs.stat(path.join(home,marker))).isFile());
  }
  assert.equal(path.basename(mavenHome),'apache-maven-3.9.11');
  return {javaHome,gradleHome,mavenHome,java:path.join(javaHome,'bin',process.platform==='win32'?'java.exe':'java')};
}

async function jdbc(options,db,output,engine,expected) {
  const classpath = await springJdbcClasspath(springClasspath,engine);
  const config = db.config;
  assert.equal(config.host,'127.0.0.1');
  assert.equal(config.database,'rocketbrain_fixture');
  const url = 'jdbc:'+engine+'://127.0.0.1:'+config.port+'/'+config.database+
    (engine==='mysql'?'?allowPublicKeyRetrieval=true&sslMode=DISABLED':'');
  const env = {...process.env,RB_DELEGATED_JDBC_URL:url,RB_DELEGATED_JDBC_USER:config.user,RB_DELEGATED_JDBC_PASSWORD:config.password};
  for (const name of ['JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','_JAVA_OPTIONS']) delete env[name];
  const run = await execute(options.java,['-cp',[output,...classpath].join(path.delimiter),'fixture.delegated.Probe'],{env,timeoutMs:20000});
  assert.equal(run.code,0,run.output);
  const [server,value] = run.output.split('|');
  assert.match(server,engine==='mysql'?/^8\.4\./u:/^11\.4\..*MariaDB/u);
  assert.equal(Number(value),expected);
  return server;
}

test('actual delegated Maven and Gradle compile preserve or update class files, recover, and run Spring JDBC on owned databases',{
  skip:!(process.env.ROCKETBRAIN_DELEGATED_LIVE==='1' && javaConfig && springClasspath && gradleUserHome && mavenHome && mavenRepository)
    && 'Configure both pinned build systems and DB fixtures.',
  timeout:460000
},async t=>{
  const owned = await ownedDirectory(t), runtime = await tools();
  const starters = {mysql:require('../scripts/integration-mysql').startMysqlFixture,mariadb:require('../scripts/integration-db').startFixture};
  const results = [];
  for (const [engine,tool] of [['mysql','gradle'],['mariadb','maven']]) {
    const root = path.join(owned,tool), fixture = await createProject(root,tool);
    let lastLog;
    const buildTasks = new BuildTasks({storagePath:path.join(owned,'tasks-'+tool),tools:()=>runtime,
      runner:{async execute(spec,{cancellation}={}) {
        const args = [...spec.args,...(tool==='gradle'?['--offline']:['--offline','-Dmaven.repo.local='+mavenRepository])];
        const result = await execute(spec.command,args,{cwd:spec.cwd,env:{...spec.env,GRADLE_USER_HOME:gradleUserHome},cancellation,timeoutMs:100000});
        lastLog = result.output;
        return {...result,terminationConfirmed:!result.timedOut};
      }}});
    let model, task;
    const service = createDelegatedBuild({projectFor:fixture.model,assertTrusted(){},
      async taskFor(project,name) {
        if (!task || project.buildFingerprint!==model) {
          task = (await buildTasks.discover(project,{allowProjectExecution:true})).find(item=>item.name===name);
          model = project.buildFingerprint;
        }
        return task;
      },runTask:(project,task)=>buildTasks.run(project,task.id,{allowProjectExecution:true})});
    const db = await starters[engine]();
    try {
      const projectUri = fixture.model().uri;
      const apply = id=>service.apply({id,allowProjectExecution:true});
      const run = async retryFrom=>apply((await service.prepare({projectUri,retryFrom})).id);
      const first = await run();
      assert.equal(first.state,'succeeded',lastLog?.slice(-6000));
      assert.equal(first.classes.state,'outputs-produced');
      const classPath = path.join(root,first.outputRoot);
      const server = await jdbc(runtime,db,classPath,engine,23);
      const repeat = await run();
      assert.equal(repeat.state,'succeeded',lastLog?.slice(-6000));
      assert.equal(repeat.classes.state,'outputs-reused');
      const actualReuse = tool==='gradle'?/> Task :compileJava UP-TO-DATE/u:/Nothing to compile.*up.to.date/iu;
      assert.match(lastLog,actualReuse);
      const stale = await service.prepare({projectUri});
      await fs.writeFile(fixture.source,adjustment('4'));
      await assert.rejects(apply(stale.id),/inputs changed/u);
      const changed = await run();
      assert.equal(changed.state,'succeeded',lastLog?.slice(-6000));
      assert.equal(changed.classes.state,'outputs-updated');
      assert.ok(changed.classes.changed.some(file=>file.endsWith('/Adjustment.class')));
      if (tool==='gradle') assert.ok(!changed.classes.changed.some(file=>file.endsWith('/Unrelated.class')));
      await jdbc(runtime,db,classPath,engine,25);
      await fs.writeFile(fixture.source,adjustment('"bad"'));
      const failed = await run();
      assert.equal(failed.state,'failed',lastLog?.slice(-6000));
      assert.equal(failed.classes.state,'unverified');
      assert.match(lastLog,/incompatible types|String cannot be converted to int/iu);
      await fs.writeFile(fixture.source,adjustment('7'));
      const recovery = await run(failed.id);
      assert.equal(recovery.state,'succeeded',lastLog?.slice(-6000));
      assert.equal(recovery.retryOf,failed.id);
      await jdbc(runtime,db,classPath,engine,28);
      results.push({engine,tool,server,task:first.task,first:first.classes.state,repeat:repeat.classes.state,
        compileToolConfirmedReuse:true,recompiledClasses:changed.classes.changed.map(file=>path.basename(file)),failure:failed.state,
        failureOutputsUnverified:true,recovered:recovery.state,explicitRetry:true,staleRefused:true,jdbcResults:[23,25,28]});
    } finally { service.dispose(); await buildTasks.dispose(); await db.close(); }
  }
  if (process.env.ROCKETBRAIN_DELEGATED_RECEIPT) await fs.writeFile(process.env.ROCKETBRAIN_DELEGATED_RECEIPT,
    JSON.stringify({gradle:'9.1.0',maven:'3.9.11',jdk:'Temurin 25.0.5+8',springJdbc:'7.0.10',results},null,2)+'\n');
});
