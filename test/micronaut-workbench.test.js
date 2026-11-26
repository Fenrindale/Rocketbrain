'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { buildSpec } = require('../src/java/workbench-tasks');
const { modelMicronaut,inspectMicronautProject } = require('../src/java/micronaut-model');
const { createMicronautRuntime,packagedJar } = require('../src/java/micronaut-runtime');
const { scriptLibraries } = require('../src/java/micronaut-distribution');

const execute=promisify(execFile), fixture=path.join(__dirname,'fixtures','java','micronaut');
const javaConfig=process.env.ROCKETBRAIN_JAVA_TEST_CONFIG, mavenHome=process.env.ROCKETBRAIN_MAVEN_HOME;

test('Micronaut source inspection recovers settings, environments, routes and bounded wiring',() => {
  const report=inspectMicronautProject({root:fixture,uri:pathToFileURL(fixture).href,tool:'maven'});
  assert.equal(report.platformVersion,'5.2.8');
  assert.equal(report.jarName,'micronaut-greeting-1.0.0.jar');
  assert.deepEqual(report.settings.map(item => [item.key,item.type]),[
    ['greeting.message','String'],['greeting.repeat-count','int'],['greeting.suffix','String']
  ]);
  assert.deepEqual(report.routes.map(item => [item.verb,item.path]),[['GET','/greeting'],['GET','/greeting/length']]);
  assert.deepEqual(report.configured.filter(item => item.key==='greeting.message').map(item => item.environment).sort(),['','dev','test']);
  assert.equal(report.bindings[0].from,'micronautfixture.GreetingController');
  assert.equal(report.bindings[0].type,'micronautfixture.GreetingConfiguration');
  assert.equal(report.bindings[0].state,'source-type');
  assert.match(report.bindings[0].targets[0].uri,/GreetingConfiguration\.java$/);
  assert.doesNotMatch(JSON.stringify(report),/test-world|dev-world/);
});

test('Micronaut recognizes real imported property annotations and nested scalar YAML sources',() => {
  const java=[{uri:'file:///test.java',text:`
    import other.Value;
    import io.micronaut.context.annotation.Property;
    import io.micronaut.context.annotation.ConfigurationProperties;
    import io.micronaut.http.annotation.Controller;
    import io.micronaut.http.annotation.Get;
    @ConfigurationProperties("source") public class Demo {
      public void setValue(String value) {}
      public void setValue(int value) {}
      @Property(name="source.port") int port;
      @Value("\${ignored}") int ignored;
    }
    @Controller("/mapped") class Route {
      @Get(uris={"one", "two"}) String ambiguous() {return "";}
      @Get(uri="one") String single() {return "";}
    }
  `}];
  const config=[{name:'application-dev.yml',uri:'file:///application-dev.yml',text:'source:\r\n  port: 25\r\n'}];
  const evidence=modelMicronaut(java,config);
  assert.deepEqual(evidence.settings.map(item => item.key),['source.port']);
  assert.deepEqual(evidence.routes.map(item => item.path),['/mapped/one']);
  assert.deepEqual(evidence.configured.map(item => [item.key,item.environment,item.range.start]),[
    ['source.port','dev',{line:1,character:2}]
  ]);
});

test('Micronaut Gradle resolves explicit application plugin, environment source and literal Kotlin DSL entry',async context=>{
  const root=path.join(__dirname,'fixtures/java/micronaut-gradle'), project={root,uri:pathToFileURL(root).href,tool:'gradle'};
  const actual=inspectMicronautProject(project);
  assert.deepEqual([actual.pluginVersion,actual.platformVersion,actual.distribution,actual.mainClass],
    ['5.0.2','5.2.8','micronaut-gradle','micronautgradlefixture.Application']);
  assert.deepEqual(actual.routes.map(item=>item.path),['/rocketbrain/hello','/rocketbrain/jdbc']);
  assert.deepEqual(actual.settings.map(item=>item.key),['fixture.message']);
  const parent=await fs.realpath(os.tmpdir()), owned=await fs.mkdtemp(path.join(parent,'rb-mn-model-'));
  context.after(async()=>{
    const actual=await fs.realpath(owned);
    assert.equal(path.relative(parent,path.dirname(actual)),'');
    assert.match(path.basename(actual),/^rb-mn-model-/u);
    await fs.rm(actual,{recursive:true,force:true});
  });
  const kts={root:owned,uri:pathToFileURL(owned).href,tool:'gradle'}, build=path.join(owned,'build.gradle.kts');
  const text='// convention stub\nplugins { id("io.micronaut.application") version "5.0.2" }\napplication { mainClass.set("demo.Entry") }';
  await fs.writeFile(build,text);
  await fs.writeFile(path.join(owned,'settings.gradle.kts'),'rootProject.name = "demo-ktor"');
  assert.deepEqual([inspectMicronautProject(kts).distribution,inspectMicronautProject(kts).mainClass],['demo-ktor','demo.Entry']);
  await fs.writeFile(build,text.replace('version "5.0.2"','version "5.0.2" apply false'));
  assert.throws(()=>inspectMicronautProject(kts),/literal version/u);
  await fs.writeFile(build,text.replace('"demo.Entry"','flag'));
  assert.throws(()=>inspectMicronautProject(kts),/literal mainClass/u);
});

test('standard Micronaut Gradle launcher projection preserves order and rejects unsafe classpath overrides',()=>{
  const one=String.raw`%APP_HOME%\lib\app.jar`, two=String.raw`%APP_HOME%\lib\dep-1.0.jar`;
  const build=assignments=>'set DEFAULT_JVM_OPTS=\r\nset CLASSPATH='+assignments+
    '\r\nendlocal & "%JAVA_EXE%" %DEFAULT_JVM_OPTS% %JAVA_OPTS% -classpath "%CLASSPATH%" demo.Entry %* & call :exitWithErrorLevel';
  const launch=build(one+';'+two);
  assert.deepEqual(scriptLibraries(launch,'demo.Entry'),['app.jar','dep-1.0.jar']);
  for(const invalid of [build(one+';'+one),build(one+';'+String.raw`%APP_HOME%\lib\..\outside.jar`),
    build(one+';%TK%'),launch.replace('demo.Entry','demo.Other'),launch.replace('DEFAULT_JVM_OPTS=','DEFAULT_JVM_OPTS=-Xmx1g'),
    launch+'\r\nset CLASSPATH='+two]){
    assert.throws(()=>scriptLibraries(invalid,'demo.Entry'),/Micronaut/u);
  }
});

async function request(base,route,kind='text') {
  const response=await fetch(base+route,{signal:AbortSignal.timeout(6000)});
  assert.equal(response.status,200);
  return response[kind]();
}

test('real MicronautTest HTTP checks and packaged dev/test environment run under the owned JVM',{
  skip:!mavenHome || !javaConfig,timeout:210000
},async context => {
  const parent=await fs.realpath(os.tmpdir()), root=await fs.mkdtemp(path.join(parent,'rb-mn-fixture-'));
  context.after(async () => {
    const owned=await fs.realpath(root);
    assert.equal(owned,root);
    assert.equal(path.dirname(owned),parent);
    await fs.rm(owned,{recursive:true,force:true,maxRetries:8,retryDelay:250});
  });
  await fs.cp(fixture,root,{recursive:true});
  const project={name:'Micronaut',root,uri:pathToFileURL(root).href,tool:'maven'};
  await assert.rejects(packagedJar(project),/Package the Micronaut Maven application/);
  const {javaHome}=JSON.parse(await fs.readFile(javaConfig,'utf8'));
  if (process.env.ROCKETBRAIN_MICRONAUT_MAVEN_REPO) {
    await fs.mkdir(path.join(root,'.mvn'));
    await fs.writeFile(path.join(root,'.mvn/maven.config'),'-Dmaven.repo.local='+path.resolve(process.env.ROCKETBRAIN_MICRONAUT_MAVEN_REPO)+'\n');
  }
  const spec=buildSpec(project,{javaHome,mavenHome},['package']);
  const built=await execute(spec.command,spec.args,{cwd:spec.cwd,env:spec.env,windowsHide:true,timeout:160000,maxBuffer:5*1024*1024});
  assert.match(built.stdout,/Tests run: 2, Failures: 0, Errors: 0, Skipped: 0/);
  assert.match(built.stdout,/BUILD SUCCESS/);
  const compiled=await fs.readdir(path.join(root,'target/classes/micronautfixture'));
  for (const name of ['$GreetingConfiguration$Definition.class','$GreetingController$Definition.class']) {
    assert.ok(compiled.includes(name));
  }
  const runtime=createMicronautRuntime();
  const options={project,javaHome,workspaceTrusted:true,allowProjectExecution:true};
  await assert.rejects(runtime.start({...options,workspaceTrusted:false}),/trusted workspace/);
  await assert.rejects(runtime.start({...options,environment:'dev,test'}),/literal Micronaut environment/);
  const controller=new AbortController();
  controller.abort();
  await assert.rejects(runtime.start({...options,cancellation:controller.signal}),/cancelled/);
  let ready, testRun, receipt;
  try {
    ready=await runtime.start({...options,environment:'dev'});
    assert.match(ready.baseUrl,/^http:\/\/127\.0\.0\.1:\d+$/);
    assert.match(ready.sha256,/^[0-9a-f]{64}$/);
    assert.equal(runtime.getState().runId,ready.runId);
    const devResponse=await request(ready.baseUrl,'/greeting');
    assert.equal(devResponse,'dev-world!;dev-world!;');
    assert.equal(await request(ready.baseUrl,'/greeting/length'),'9');
    const health=await request(ready.baseUrl,'/health','json');
    assert.equal(health.status,'UP');
    await assert.rejects(runtime.start(options),/current owned Micronaut application/);
    assert.equal((await runtime.stop()).state,'stopped');
    await assert.rejects(fetch(ready.baseUrl+'/greeting',{signal:AbortSignal.timeout(1000)}));
    testRun=await runtime.start({...options,environment:'test'});
    const testResponse=await request(testRun.baseUrl,'/greeting');
    assert.equal(testResponse,'test-world?;test-world?;');
    assert.equal(testRun.sha256,ready.sha256);
    receipt={platform:inspectMicronautProject(project).platformVersion,artifact:ready.artifact,tests:2,
      devResponse,testResponse,health:health.status,sha256:ready.sha256,compiledBeans:2};
  } finally {await runtime.dispose();}
  await assert.rejects(fetch(testRun.baseUrl+'/greeting',{signal:AbortSignal.timeout(1000)}));
  if (process.env.ROCKETBRAIN_MICRONAUT_RECEIPT) {
    await fs.writeFile(process.env.ROCKETBRAIN_MICRONAUT_RECEIPT,JSON.stringify({...receipt,ownedShutdown:true},null,2)+'\n');
  }
});
