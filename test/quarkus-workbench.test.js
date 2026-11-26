'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createQuarkusProject } = require('../src/java/quarkus-create');
const { inspectQuarkusProject,modelQuarkus,quarkusGradleProject } = require('../src/java/quarkus-model');
const { createQuarkusDev,fastJar } = require('../src/java/quarkus-dev');
const { createDebugProcessDiscovery } = require('../src/java/debug-processes');
const { buildSpec } = require('../src/java/workbench-tasks');

const execute = promisify(execFile);
const cachedRepository = process.env.ROCKETBRAIN_QUARKUS_MAVEN_REPO;
const javaConfig = process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;
const mavenHome = process.env.ROCKETBRAIN_MAVEN_HOME;

async function projectIn(context) {
  const parent = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'rb-quarkus-'));
  context.after(async () => {
    assert.equal(await fs.realpath(parent),parent);
    await fs.rm(parent,{recursive:true,force:true,maxRetries:8,retryDelay:250});
  });
  const write = {parent,name:'quarkus-app',workspaceTrusted:true,allowProjectWrites:true};
  await assert.rejects(createQuarkusProject({...write,allowProjectWrites:false}),/trusted workspace/);
  await assert.rejects(createQuarkusProject({...write,name:'../app'}),/artifact name/);
  const created = await createQuarkusProject(write);
  assert.equal(created.files,6);
  const pom = await fs.readFile(created.pom,'utf8');
  assert.match(pom,/<artifactId>quarkus-app<\/artifactId>/);
  await assert.rejects(createQuarkusProject(write),{code:'EEXIST'});
  assert.equal(await fs.readFile(created.pom,'utf8'),pom);
  return {root:created.root,uri:pathToFileURL(created.root).href,tool:'maven'};
}

test('Quarkus scaffold, literal configuration profiles, declaration targets, REST and Qute source', async context => {
  const project = await projectIn(context);
  const report = inspectQuarkusProject(project);
  assert.equal(report.version,'3.40.1.2');
  assert.deepEqual(report.configuration.map(({ key,type,hasDefault }) => [key,type,hasDefault]),[
    ['greeting.copies','int',true],['greeting.suffix','String',true],['greeting.text','String',false]
  ]);
  assert.deepEqual(report.configured.map(({ key,profile }) => [key,profile]),[
    ['greeting.text',''],['greeting.copies',''],['greeting.text','dev'],['greeting.text','test']
  ]);
  assert.deepEqual(report.endpoints.map(({ verb,path:route }) => verb+' '+route),['GET /greeting','GET /greeting/page']);
  assert.equal(report.templates[0].name,'greeting.html');
  assert.match(report.templates[0].uri,/\/templates\/greeting\.html$/);
  assert.match(report.configuration[1].source.uri,/\/demo\/quarkus\/GreetingResource\.java$/);
  assert.doesNotMatch(JSON.stringify(report),/dev-world|test-world/);

  const source = modelQuarkus([{uri:'file:///Demo.java',text:`
    import io.smallrye.config.ConfigMapping;
    import io.smallrye.config.WithName;
    import io.smallrye.config.WithParentName;
    import example.ConfigProperty;
    @ConfigMapping(prefix="demo") interface Demo {
      @WithName("renamed") String other();
      @WithParentName String parent();
      String automaticKey();
      java.util.List<String> nested();
    }
    class DifferentLibrary { @ConfigProperty(name="unrelated") String other; }
  `}]);
  assert.deepEqual(source.configuration.map(({key}) => key),['demo.automatic-key','demo.renamed']);
});

async function read(baseUrl,route,format='text') {
  const response = await fetch(baseUrl+route,{signal:AbortSignal.timeout(6000)});
  assert.equal(response.ok,true);
  return response[format]();
}

test('Quarkus pins saved Gradle plugins and validates the standard fast-jar output',async context=>{
  const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'rb-quarkus-gradle-unit-'));
  context.after(async()=>{
    assert.equal(await fs.realpath(root),root);
    await fs.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  });
  const project={tool:'gradle',root,uri:pathToFileURL(root).href};
  const build=path.join(root,'build.gradle.kts');
  await fs.writeFile(build,'plugins {\n  // id("io.quarkus") version("3.30.0")\n  id("io.quarkus") version("3.40.1.2")\n}\n');
  assert.equal(quarkusGradleProject(project).version,'3.40.1.2');
  const first=quarkusGradleProject(project).buildFingerprint;
  await fs.writeFile(build,'plugins {\n  id("io.quarkus")\n}\n');
  await fs.writeFile(path.join(root,'settings.gradle'),'pluginManagement {\n  plugins {\n    id "\x24{quarkusPluginId}" version "\x24{quarkusPluginVersion}"\n  }\n}\n');
  const properties=path.join(root,'gradle.properties');
  await fs.writeFile(properties,'quarkusPluginId=io.quarkus\nquarkusPluginVersion=3.40.1.2\n');
  assert.equal(quarkusGradleProject(project).version,'3.40.1.2');
  assert.notEqual(quarkusGradleProject(project).buildFingerprint,first);
  await fs.appendFile(properties,'quarkusPluginVersion=3.38.0\n');
  assert.throws(()=>quarkusGradleProject(project),/one value/);
  await fs.writeFile(properties,'');
  await fs.writeFile(build,'def fake = """\nplugins {\n  id("io.quarkus") version "3.40.1.2"\n}\n"""\n');
  assert.throws(()=>quarkusGradleProject(project),/pinned Quarkus/);
  const output=path.join(root,'build'), runJar=path.join(output,'quarkus-app','quarkus-run.jar');
  await fs.mkdir(path.dirname(runJar),{recursive:true});
  await fs.writeFile(runJar,'test-only');
  const artifact=path.join(output,'quarkus-artifact.properties');
  await fs.writeFile(artifact,'type=jar\npath=quarkus-app/quarkus-run.jar\n');
  assert.equal(fastJar(project),runJar);
  await fs.appendFile(artifact,'path=../external.jar\n');
  assert.throws(()=>fastJar(project),/standard Quarkus fast-jar/);
});

test('scaffold runs actual Quarkus Maven tests and reloads with owned development debugging',{
  skip:!javaConfig || !mavenHome,timeout:300000
},async context => {
  const project = await projectIn(context);
  const { javaHome } = JSON.parse(await fs.readFile(javaConfig,'utf8'));
  if (cachedRepository) {
    await fs.mkdir(path.join(project.root,'.mvn'));
    await fs.writeFile(path.join(project.root,'.mvn','maven.config'),'-Dmaven.repo.local='+path.resolve(cachedRepository)+'\n');
  }
  const spec = buildSpec(project,{javaHome,mavenHome},['test']);
  const built = await execute(spec.command,spec.args,{cwd:spec.cwd,env:spec.env,windowsHide:true,timeout:160000,maxBuffer:6*1024*1024});
  assert.match(built.stdout,/Tests run: 2, Failures: 0, Errors: 0, Skipped: 0/);
  const processes = createDebugProcessDiscovery({javaHome:()=>javaHome,trusted(){}});
  const dev = createQuarkusDev({resolveDescendant:processes.resolveDescendant});
  const options = {project,javaHome,mavenHome,workspaceTrusted:true,allowProjectExecution:true};
  await assert.rejects(dev.start({...options,workspaceTrusted:false}),/trusted workspace/);
  await assert.rejects(dev.start({...options,allowProjectExecution:false}),/trusted workspace/);
  let ready, snapshot;
  try {
    ready = await dev.start({...options,debug:'development'});
    assert.equal(ready.profile,'dev');
    assert.equal(ready.debug.verified,true);
    assert.notEqual(ready.debug.port,Number(new URL(ready.baseUrl).port));
    await assert.rejects(dev.start(options),/current owned Quarkus dev session/);
    assert.equal(await read(ready.baseUrl,'/greeting'),'dev-world!;dev-world!;');
    assert.match(await read(ready.baseUrl,'/greeting/page'),/<p class="greeting">dev-world!<\/p>/);
    const health = await read(ready.baseUrl,'/q/health/ready','json');
    assert.equal(health.status,'UP');
    const properties = path.join(project.root,'src/main/resources/application.properties');
    const original = await fs.readFile(properties,'utf8');
    await fs.writeFile(properties,original.replace('%dev.greeting.text=dev-world','%dev.greeting.text=live-world'));
    const switchBy = Date.now()+30000;
    let reloaded;
    while (Date.now()<switchBy && reloaded!=='live-world!;live-world!;') {
      await new Promise(resolve => setTimeout(resolve,600));
      reloaded = await read(ready.baseUrl,'/greeting');
    }
    assert.equal(reloaded,'live-world!;live-world!;');
    assert.deepEqual(await dev.verifyDebugTarget(),ready.debug);
    snapshot = {version:ready.version,tests:2,profile:ready.profile,health:health.status,liveReload:reloaded,ownedDebugVerified:true};
  } finally {
    await dev.dispose();
  }
  await assert.rejects(fetch(ready.baseUrl+'/greeting',{signal:AbortSignal.timeout(1000)}));
  await assert.rejects(dev.verifyDebugTarget(),/unavailable/);
  if (process.env.ROCKETBRAIN_QUARKUS_RECEIPT) {
    await fs.writeFile(process.env.ROCKETBRAIN_QUARKUS_RECEIPT,JSON.stringify({...snapshot,ownedProcessStopped:true},null,2)+'\n');
  }
});
