'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {test}=require('node:test');
const {gradleNativeInputs,nativeGradleArgs,nativeGradleInit}=require('../src/java/quarkus-native-gradle');
const {quarkusProject}=require('../src/java/quarkus-model');

test('Quarkus Gradle native review binds saved source while excluding normal output and rejecting linked build layout',async t=>{
  const parent=await fs.realpath(os.tmpdir()), root=await fs.mkdtemp(path.join(parent,'rb-qng-'));
  const identity=await fs.lstat(root,{bigint:true});
  t.after(async()=>{
    const current=await fs.lstat(root,{bigint:true});
    assert.equal(await fs.realpath(root),root);
    assert.equal(path.dirname(root),parent);
    assert.deepEqual([current.dev,current.ino],[identity.dev,identity.ino]);
    await fs.rm(root,{recursive:true,force:true,maxRetries:4});
  });
  await fs.cp(path.join(__dirname,'fixtures/java/quarkus-native-gradle-linux'),root,{recursive:true});
  const project={root,tool:'gradle'};
  assert.equal(quarkusProject(project).version,'3.40.1.2');
  const original=gradleNativeInputs(project);
  await fs.mkdir(path.join(root,'build'));
  await fs.writeFile(path.join(root,'build','untouched'),'outside the review');
  assert.equal(gradleNativeInputs(project),original);
  await fs.appendFile(path.join(root,'src/main/resources/application.properties'),'\n# changed\n');
  assert.notEqual(gradleNativeInputs(project),original);
  await fs.appendFile(path.join(root,'settings.gradle'),'\nincludeBuild("../external")\n');
  assert.throws(()=>gradleNativeInputs(project),/standalone Quarkus Gradle/u);
});

test('Quarkus Gradle native build uses fixed local output and real image arguments',()=>{
  const args=nativeGradleArgs('/local module','/local module/build/owned','/local module/build/owned/init.gradle','/graalvm');
  for(const flag of ['--no-build-cache','--no-configuration-cache','--rerun-tasks','-Dquarkus.native.enabled=true',
    '-Dquarkus.native.graalvm-home=/graalvm','-Dquarkus.native.container-build=false','-Dquarkus.native.reuse-existing=false',
    '-Dquarkus.native.sources-only=false','-Dquarkus.package.jar.enabled=false'])assert.ok(args.includes(flag),flag);
  assert.deepEqual(args.slice(args.indexOf('--init-script'),args.indexOf('--init-script')+4),['--init-script',
    '/local module/build/owned/init.gradle','-Drocketbrain.quarkus.native.root=/local module',
    '-Drocketbrain.quarkus.native.output=/local module/build/owned']);
  assert.match(nativeGradleInit,/layout\.buildDirectory\.disallowChanges\(\)/u);
});
