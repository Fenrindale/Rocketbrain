'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { decodeKmpModel } = require('../src/java/kmp-gradle');
const { selectKmpJvmTarget, startKmpJvmDebug } = require('../src/java/kmp-jvm-debug');

test('Kotlin debugging admits the exact observed JVM run task and its source roots', async () => {
  const root=path.join(__dirname,'fixtures','java','kotlin-multiplatform');
  const directory=set=>path.join(root,'src',set,'kotlin');
  const model=decodeKmpModel(root,{format:'RocketbrainKmpModel1',modules:[{
    path:':',directory:root,
    sourceSets:['commonMain','jvmMain','jsMain'].map(name=>({name,directories:[directory(name)],dependsOn:[]})),
    targets:[
      {name:'desktop',platform:'jvm',main:['commonMain','jvmMain'],compileTask:':compileKotlinDesktop',testTask:null,runTask:':desktopRun'},
      {name:'js',platform:'js',main:['commonMain','jsMain'],compileTask:':compileKotlinJs',testTask:null,runTask:':jsNodeDevelopmentRun'},
      {name:'jvmLibrary',platform:'jvm',main:['commonMain','jvmMain'],compileTask:':compileKotlinJvmLibrary',testTask:null,runTask:null}
    ]
  }]});
  const selection=selectKmpJvmTarget(model,':','desktop');
  assert.equal(selection.target.runTask,':desktopRun');
  assert.deepEqual(selection.sourcePaths,[directory('commonMain'),directory('jvmMain')]);
  for (const [module,target] of [[':','js'],[':','jvmLibrary'],[':elsewhere','desktop']]) {
    assert.throws(()=>selectKmpJvmTarget(model,module,target),/observed Kotlin JVM application/);
  }
  assert.throws(()=>selectKmpJvmTarget({...model,digests:[]},':','desktop'),/Gradle settings changed/);
  await assert.rejects(startKmpJvmDebug({model,workspaceTrusted:true,allowProjectExecution:false}),/trusted workspace/);
});
