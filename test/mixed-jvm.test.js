'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { test } = require('node:test');
const { packageName,collectProjects } = require('../src/java/workbench-model');
const { BuildTasks } = require('../src/java/workbench-tasks');
const { analyzeMixedClasses,assertMixedCurrent,snapshotMixedSources } = require('../src/java/mixed-jvm-index');
const { definitionForCompiledReference } = require('../src/java/mixed-jvm-symbols');
const { copyMixedProject,mixedFile,EXPECTED } = require('./helpers/mixed-jvm-fixture');

const configuration = process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;
const run = promisify(execFile);
const temporary = async prefix => fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),prefix));

test('mixed workbench includes Kotlin packages even when JDT reports only Java roots',async t => {
  assert.equal(packageName('// package false\npackage mixed.fixture\nclass KotlinGateway','kotlin'),'mixed.fixture');
  assert.equal(packageName('package mixed.fixture; class JavaHelper {}'),'mixed.fixture');
  assert.equal(packageName('package mixed.\nclass Broken','kotlin'),null);
  const root = await temporary('rb-mixed-model-');
  t.after(() => fs.rm(root,{recursive:true,force:true}));
  await copyMixedProject(root,'gradle');
  const projectUri = pathToFileURL(root).href;
  const request = async command => {
    if (command === 'java.project.getAll') return [projectUri];
    if (command === 'java.project.getSettings') return {'org.eclipse.jdt.ls.core.sourcePaths':[path.join(root,'src/main/java')]};
    return {classpaths:[],modulepaths:[]};
  };
  const view = await collectProjects({folders:[projectUri],request});
  const [project] = view.projects;
  assert.deepEqual(project.languages,['java','kotlin']);
  const kotlin = project.sourceRoots.flatMap(item => item.packages).find(item => item.files.some(file => file.language === 'kotlin'));
  assert.equal(kotlin.name,'mixed.fixture');
  assert.equal(kotlin.files[0].name,'KotlinGateway.kt');
  assert.equal(view.sourceFiles,3);
});

test('bundled mixed class reader matches auditable JDK source',async () => {
  assert.equal(require('../src/java/mixed-jvm-classfile-source.json'),
    await fs.readFile(path.resolve(__dirname,'../runtime/java-mixed/MixedClassInspector.java'),'utf8'));
});

test('Gradle and Maven compile/test actual Java and Kotlin and resolve compiled bidirectional source references',
  {skip:!configuration && 'Independent Gradle, Maven and JDK runtime is not configured.',timeout:300000},async t => {
    const config = JSON.parse(await fs.readFile(configuration,'utf8'));
    const {javaHome,gradleHome} = config;
    const mavenHome = process.env.ROCKETBRAIN_MAVEN_HOME || config.mavenHome || path.resolve(path.dirname(configuration),
      '../research/implementation/runtimes/v0.18-maven-cache/extracted/apache-maven-3.9.11');
    const root = await temporary('rb-mixed-runtime-');
    const storagePath = path.join(root,'inspection'), gradleCache = path.join(root,'gradle-home'), mavenCache = path.join(root,'maven-home');
    const logs = new Map();
    const runner = {async execute(spec) {
      const env = {...spec.env,GRADLE_USER_HOME:gradleCache};
      const args = spec.tool === 'maven' ? [...spec.args,'-Dmaven.repo.local='+mavenCache] : [
        ...(process.platform === 'win32' ? ['-Dfile.encoding=COMPAT'] : []),...spec.args
      ];
      const result = await run(spec.command,args,{cwd:spec.cwd,env,windowsHide:true,timeout:125000,maxBuffer:2*1024*1024});
      logs.set(spec.label,result.stdout);
      return {code:0,terminationConfirmed:true};
    }};
    const tasks = new BuildTasks({runner,storagePath,tools:() => ({javaHome,gradleHome,mavenHome})});
    t.after(async () => {
      await tasks.dispose();
      await fs.rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:300});
    });
    const evidence = [];
    for (const tool of ['gradle','maven']) {
      const folder = await copyMixedProject(path.join(root,tool),tool), uri = pathToFileURL(folder).href;
      const snapshot = (await collectProjects({folders:[uri],request:async command => {
        if (command === 'java.project.getAll') return [uri];
        if (command === 'java.project.getSettings') return {'org.eclipse.jdt.ls.core.sourcePaths':[path.join(folder,'src/main/java')]};
        return {classpaths:[],modulepaths:[]};
      }})).projects[0];
      const taskList = await tasks.discover(snapshot,{allowProjectExecution:true});
      const testTask = taskList.find(item => [':test','test'].includes(item.name));
      assert.ok(testTask);
      const saved = snapshotMixedSources(snapshot);
      const result = await tasks.run(snapshot,testTask.id,{allowProjectExecution:true});
      assert.equal(result.state,'succeeded');
      const junit = tool === 'gradle' ? 'build/test-results/test' : 'target/surefire-reports';
      assert.match(await fs.readFile(path.join(folder,junit,'TEST-mixed.fixture.JavaApplicationTest.xml'),'utf8'),/tests="1"/);
      const indexed = await analyzeMixedClasses({project:snapshot,sources:saved,javaHome,storagePath});
      const targets = [];
      for (const expected of EXPECTED) {
        const file = mixedFile(folder,expected.source), source = await fs.readFile(file,'utf8');
        const marker = source.indexOf(expected.marker);
        assert.ok(marker >= 0);
        const observed = definitionForCompiledReference(indexed,{file,offset:marker+expected.advance});
        assert.equal(observed.file,mixedFile(folder,expected.target));
        assert.equal(observed.member,expected.member);
        assert.equal(observed.descriptor,expected.descriptor);
        assert.equal(observed.kind,expected.kind);
        assert.equal((await fs.readFile(observed.file,'utf8')).slice(observed.range.start,observed.range.end),expected.anchor);
        targets.push({from:expected.source,to:expected.target,kind:expected.kind,member:expected.member,descriptor:expected.descriptor});
      }
      const duplicate = saved.files.find(file => file.file.endsWith('JavaApplication.java'));
      const synthetic = {...indexed,sources:{...saved,files:saved.files.map(file => file === duplicate ? {
        ...file,text:file.text.replace('gateway.transform(number)','gateway.transform(number) + gateway.transform(number)')
      } : file)}};
      assert.throws(() => definitionForCompiledReference(synthetic,{file:duplicate.file,offset:duplicate.text.indexOf('transform(number)')+1}),/one matching compiled call/);
      const stale = mixedFile(folder,'KotlinGateway.kt');
      await fs.appendFile(stale,'// changed after build\n');
      assert.throws(() => assertMixedCurrent(indexed),/source, build or output files changed/);
      const original = saved.files.find(file => file.file === stale).text;
      await fs.writeFile(stale,original);
      assertMixedCurrent(indexed);
      const classRoot = path.join(folder,tool === 'gradle' ? 'build/classes/java/main' : 'target/classes');
      const artifact = path.join(classRoot,'mixed/fixture/JavaHelper.class');
      const originalClass = await fs.readFile(artifact);
      await fs.appendFile(artifact,Buffer.from([0]));
      assert.throws(() => assertMixedCurrent(indexed),/source, build or output files changed/);
      await fs.writeFile(artifact,originalClass);
      let application = null;
      if (tool === 'gradle') {
        const task = taskList.find(item => [':run','run'].includes(item.name));
        assert.ok(task);
        assert.equal((await tasks.run(snapshot,task.id,{allowProjectExecution:true})).state,'succeeded');
        assert.match(logs.get(snapshot.name+' · '+task.name),/mixed-14-3:kotlin/);
        application='mixed-14-3:kotlin';
      }
      evidence.push({tool,junit:1,classes:indexed.classes.length,targets,staleSourceRejected:true,staleClassRejected:true,application});
    }
    if (process.env.ROCKETBRAIN_MIXED_JVM_RECEIPT) await fs.writeFile(process.env.ROCKETBRAIN_MIXED_JVM_RECEIPT,JSON.stringify(evidence,null,2)+'\n');
  });
