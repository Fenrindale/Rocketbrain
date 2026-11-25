'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { prepareCoroutineProbe,readCoroutineDescriptor,fetchCoroutineSnapshot,readSnapshot }=require('../src/java/kotlin-coroutine-probe');
const { buildCoroutineFixture,launchCoroutineFixture }=require('./helpers/coroutine-fixture');

const javaConfig=process.env.ROCKETBRAIN_JAVA_TEST_CONFIG, gradleHome=process.env.ROCKETBRAIN_COROUTINE_GRADLE_HOME;

test('coroutine snapshots bind to the selected launched process and validate states and frames',async()=>{
  await assert.rejects(prepareCoroutineProbe({workspaceTrusted:true}),/Explicitly prepare/);
  await assert.rejects(readCoroutineDescriptor('https://127.0.0.1/coroutine-probe.json'),/absolute local file/);
  const descriptor={pid:17,session:'9d32d205-aeb1-4e4b-89e1-d9d3b6d2468a'};
  const value={format:'RocketbrainCoroutineSnapshot',version:1,...descriptor,capturedAt:'2026-11-25T01:02:03.04Z',
    creationEnabled:true,truncated:false,coroutines:[{name:'safe\nname',state:'SUSPENDED',creation:[],observed:[]}]};
  assert.equal(readSnapshot(value,descriptor).coroutines[0].name,'safename');
  assert.throws(()=>readSnapshot({...value,pid:18},descriptor),/Unexpected snapshot/);
  assert.throws(()=>readSnapshot({...value,coroutines:[{name:'invalid',state:'OTHER',creation:[],observed:[]}]},descriptor),/Unknown Kotlin coroutine state/);
});

test('independent Kotlin JVM startup probe reports named states and creation frames, authenticates and closes',{
  skip:!javaConfig || !gradleHome,timeout:230000
},async context=>{
  const parent=await fs.realpath(os.tmpdir()), root=await fs.mkdtemp(path.join(parent,'rb-coro-fixture-'));
  context.after(async()=>{
    const real=await fs.realpath(root);
    assert.equal(real,root);
    assert.equal(path.dirname(real),parent);
    await fs.rm(real,{recursive:true,force:true,maxRetries:8,retryDelay:250});
  });
  const {javaHome}=JSON.parse(await fs.readFile(javaConfig,'utf8'));
  const fixture=await buildCoroutineFixture(path.join(root,'project'),{javaHome,gradleHome,
    gradleUserHome:process.env.ROCKETBRAIN_COROUTINE_GRADLE_USER_HOME || path.join(root,'gradle-cache')});
  const prepared=await prepareCoroutineProbe({javaHome,debugJar:fixture.debugJar,storageRoot:path.join(root,'probe'),
    workspaceTrusted:true,allowProbeWrites:true});
  const running=launchCoroutineFixture(fixture,prepared);
  let descriptor, proof, exitCode;
  try {
    await running.ready();
    descriptor=await readCoroutineDescriptor(prepared.descriptor);
    assert.equal(descriptor.pid,running.pid);
    const bare=await fetch('http://127.0.0.1:'+descriptor.port+'/rocketbrain/coroutines');
    assert.equal(bare.status,401);
    await bare.body.cancel();
    await assert.rejects(fetchCoroutineSnapshot({...descriptor,token:'A'.repeat(43)}),/\(401\)/);
    await assert.rejects(fetchCoroutineSnapshot({...descriptor,pid:descriptor.pid+1}),/Unexpected snapshot/);
    const model=await fetchCoroutineSnapshot(descriptor);
    assert.equal(model.creationEnabled,true);
    const active=model.coroutines.find(item=>item.name==='processing-order');
    const suspended=model.coroutines.find(item=>item.name==='awaiting-invoice');
    assert.equal(active.state,'RUNNING');
    assert.equal(suspended.state,'SUSPENDED');
    const testFrames=(item,creation,observed)=>{
      assert.ok(item.creation.some(frame=>frame.file==='Main.kt' && frame.line===creation && frame.className.startsWith('coroutinesfixture.')));
      assert.ok(item.observed.some(frame=>frame.file==='Main.kt' && frame.line===observed && frame.className.startsWith('coroutinesfixture.')));
      return {name:item.name,state:item.state,creation,observed};
    };
    proof={version:prepared.version,coroutines:[testFrames(suspended,17,18),testFrames(active,20,20)],unauthenticatedRejected:true};
  } finally {exitCode=await running.stop();}
  assert.equal(exitCode,0);
  await assert.rejects(fs.stat(prepared.descriptor),{code:'ENOENT'});
  await assert.rejects(fetchCoroutineSnapshot(descriptor));
  const withoutOfficialAgent=launchCoroutineFixture(fixture,{...prepared,vmArgs:[prepared.vmArgs[0],prepared.vmArgs[2]]});
  try {
    await withoutOfficialAgent.ready();
    const unavailable=await readCoroutineDescriptor(prepared.descriptor);
    await assert.rejects(fetchCoroutineSnapshot(unavailable),/\(409\)/);
  } finally {await withoutOfficialAgent.stop();}
  await assert.rejects(fs.stat(prepared.descriptor),{code:'ENOENT'});
  if (process.env.ROCKETBRAIN_COROUTINE_RECEIPT) {
    await fs.writeFile(process.env.ROCKETBRAIN_COROUTINE_RECEIPT,JSON.stringify({...proof,descriptorRemoved:true,
      ownedShutdown:true,requiresStartupProbes:true},null,2)+'\n');
  }
});
