'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');
const { analyzeJavaSources } = require('../src/java/signature-compiler');
const { buildInlineDraft, verifyInlineDraft } = require('../src/java/inline-method');
const { editedText } = require('../src/java/refactoring');
const { instanceInlineFixture, springJdbcClasspath, runInstanceInline } = require('./helpers/instance-inline-fixture');

const javaConfig = process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;
const classpathFile = process.env.ROCKETBRAIN_INSTANCE_INLINE_CLASSPATH;
const dbFiles = ['mysql','mariadb'].map(engine => [engine,process.env['ROCKETBRAIN_INSTANCE_INLINE_'+engine.toUpperCase()+'_CONFIG']]);
const read = async file => JSON.parse(await fs.readFile(file,'utf8'));

async function fixture(t, spring = false) {
  const { javaHome } = await read(javaConfig);
  const parent = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(parent,'rb-instance-inline-'));
  t.after(async () => {
    assert.equal(await fs.realpath(root),root);
    assert.equal(path.dirname(root),parent);
    await fs.rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:200});
  });
  const name = 'InlineChoice', namespace = 'fixture', sample = instanceInlineFixture(namespace,name,{spring});
  const file = path.join(root,name+'.java'), uri = pathToFileURL(file).href, className = namespace+'.'+name;
  async function inspect(source, start, end, {argumentCount=-1,receiverKind='static',classpath=[]} = {}) {
    const result = await analyzeJavaSources({javaHome,classpath,sources:[{uri,text:source}],storagePath:root,
      inspection:{kind:'methodInline',uri,start,end,argumentCount,receiverKind}});
    assert.deepEqual(result.errors,[]);
    return result.methodInline;
  }
  async function at(marker, after='', source=sample.source, classpath=[]) {
    const start = source.indexOf(marker,source.indexOf(after));
    assert.ok(start>=0,marker);
    return inspect(source,start,start+marker.length,{classpath});
  }
  async function plan(marker, after='', classpath=[]) {
    const proof = await at(marker,after,sample.source,classpath), draft = buildInlineDraft(sample.source,proof);
    const compiled = await inspect(draft.after,draft.start,draft.end,
      {argumentCount:proof.arguments.length,receiverKind:proof.receiver.kind,classpath});
    verifyInlineDraft(proof,draft,compiled);
    assert.equal(editedText(sample.source,[draft.edit]),draft.after);
    return {proof,draft,compiled};
  }
  async function run(source, options={}) {
    const binaryDirectory = await fs.mkdtemp(path.join(root,'run-'));
    await fs.writeFile(file,source);
    return runInstanceInline({javaHome,file,binaryDirectory,className,...options});
  }
  return {sample,inspect,at,plan,run};
}

test('Javac and the real JVM preserve instance receiver construction, field bindings and evaluation order', {
  skip:!javaConfig,timeout:125000
}, async t => {
  const {sample,inspect,at,plan,run} = await fixture(t);
  const fresh = await plan(sample.call), explicit = await plan(sample.explicit), implicit = await plan(sample.implicit,'int implicitSite');
  assert.equal(fresh.proof.receiver.kind,'new');
  assert.equal(fresh.draft.receiverName,'rbInlineReceiver2');
  assert.match(fresh.draft.after,/fixture\.InlineChoice rbInlineReceiver2 = new InlineChoice\(10\);\n\s*int rbInlineArgument1 = step\(1\);/u);
  assert.match(fresh.draft.after,/rbInlineReceiver2\.offset \+ rbInlineReceiver2\.bias/u);
  assert.deepEqual(fresh.compiled.references,fresh.proof.references.map(reference=>reference.field??reference.index));
  assert.equal(fresh.proof.references.filter(reference=>reference.field).length,2);
  assert.equal(fresh.proof.arguments.length,3);
  assert.equal(explicit.proof.receiver.kind,'this');
  assert.match(explicit.draft.after,/var value = \(int\)\(this\.offset \+ this\.bias/u);
  assert.equal(implicit.proof.receiver.kind,'this');
  assert.match((await at(sample.nullable)).error,/newly constructed same-class receiver/u);
  assert.match((await at(sample.constant)).error,/direct nonconstant instance fields/u);
  const comments = sample.call.replace('step(1)','/* attached to call */ step(1)');
  const commentedSource = sample.source.replace(sample.call,comments);
  const commented = await at(comments,'int newSite',commentedSource);
  assert.throws(()=>buildInlineDraft(commentedSource,commented),/comments between invocation operands/u);
  const options = {argumentCount:3,receiverKind:'new'};
  const wrongField = fresh.draft.after.replace('rbInlineReceiver2.offset','rbInlineReceiver2.backup');
  const changedField = await inspect(wrongField,fresh.draft.start,fresh.draft.end,options);
  assert.throws(()=>verifyInlineDraft(fresh.proof,fresh.draft,changedField),/field read/u);
  const wrongReceiver = fresh.draft.after.replace('rbInlineReceiver2 = new InlineChoice(10)','rbInlineReceiver2 = new InlineChoice(20)');
  const changedReceiver = await inspect(wrongReceiver,fresh.draft.start,fresh.draft.end,options);
  assert.throws(()=>verifyInlineDraft(fresh.proof,fresh.draft,changedReceiver),/receiver evaluation/u);
  for (const source of [sample.source,fresh.draft.after,explicit.draft.after,implicit.draft.after]) {
    assert.deepEqual(await run(source),{output:sample.output});
  }
});

test('actual Spring JDBC and both owned databases supply the argument to equivalent original and inlined programs', {
  skip:!javaConfig||!classpathFile||!dbFiles.every(([,file])=>file),timeout:130000
}, async t => {
  const {sample,plan,run} = await fixture(t,true), results=[];
  for (const [engine,dbFile] of dbFiles) {
    const classpath = await springJdbcClasspath(classpathFile,engine), config=await read(dbFile);
    const {draft} = await plan(sample.call,'int newSite',classpath);
    const options = {engine,config,classpath};
    const original=await run(sample.source,options), edited=await run(draft.after,options);
    assert.equal(original.output,sample.output);
    assert.deepEqual(edited,original);
    results.push(edited);
  }
  if (process.env.ROCKETBRAIN_INSTANCE_INLINE_RECEIPT) await fs.writeFile(process.env.ROCKETBRAIN_INSTANCE_INLINE_RECEIPT,
    JSON.stringify({jdk:'Temurin 25.0.5+8',springJdbc:'7.0.10',constructorBeforeArguments:true,argumentOrder:[1,2,3],
      fieldReadsAfterArguments:2,unusedArgumentEvaluated:true,results})+'\n');
});
