'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {test}=require('node:test');
const {analyzeJavaSources}=require('../src/java/signature-compiler');
const {buildInlineDraft,verifyInlineDraft}=require('../src/java/inline-method');
const {editedText}=require('../src/java/refactoring');
const {execute}=require('../src/java/testing/provision');
const {inlineFixture}=require('./helpers/inline-method-fixture');

const runtime=process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;

test('real Javac inlines one exact method call while preserving side-effect order, argument bindings and Java runtime values',{
  skip:!runtime,timeout:200000
},async t=>{
  const config=JSON.parse(await fs.readFile(runtime,'utf8'));
  const javaHome=config.javaHome||config.settings?.['rocketbrain.java.javaHome'];
  const parent=await fs.realpath(os.tmpdir()),owned=await fs.mkdtemp(path.join(parent,'rb-methodinline-'));
  t.after(async()=>{
    const real=await fs.realpath(owned);
    assert.equal(real,owned); assert.equal(path.dirname(real),parent); assert.match(path.basename(real),/^rb-methodinline-/);
    await fs.rm(real,{recursive:true,force:true,maxRetries:8,retryDelay:250});
  });
  const name='InlineFixture',namespace='fixtures.inline',fixture=inlineFixture(namespace,name),source=fixture.source;
  const file=path.join(owned,name+'.java'),uri=pathToFileURL(file).href;
  const inspect=async(text,start,end,argumentCount=-1)=>{
    const report=await analyzeJavaSources({javaHome,sources:[{uri,text}],storagePath:owned,
      inspection:{kind:'methodInline',uri,start,end,argumentCount}});
    assert.deepEqual(report.errors,[]);
    return report.methodInline;
  };
  const at=(marker,from=0)=>{
    const start=source.indexOf(marker,from);
    assert.ok(start>=0,marker);
    return {start,end:start+marker.length};
  };
  async function inline(marker,after) {
    const {start,end}=at(marker,after),proof=await inspect(source,start,end),draft=buildInlineDraft(source,proof);
    const compiled=await inspect(draft.after,draft.start,draft.end,proof.arguments.length);
    verifyInlineDraft(proof,draft,compiled);
    assert.equal(editedText(source,[draft.edit]),draft.after);
    return {proof,draft,compiled};
  }
  const ordered=await inline(fixture.call), local=await inline(fixture.call,source.indexOf('int local()'));
  const bytes=await inline('narrow()',source.indexOf('byte byteValue()'));
  const strings=await inline('combine("interned")');
  assert.deepEqual(ordered.draft.temporaries,['rbInlineArgument2','rbInlineArgument3','rbInlineArgument4']);
  assert.deepEqual(ordered.compiled.references,[1,0,0]);
  assert.equal(ordered.proof.arguments.length,3);
  assert.deepEqual(ordered.draft.after.match(/rbInlineArgument[2-4] = take\([1-3]\)/g),[
    'rbInlineArgument2 = take(1)','rbInlineArgument3 = take(2)','rbInlineArgument4 = take(3)']);
  assert.match(ordered.draft.after,/private static int score\(int first, int second, int ignored\)/);
  assert.match(ordered.draft.after,/return score\("other"\);/);
  assert.equal(ordered.draft.after.split(fixture.call).length,3);
  assert.equal(local.compiled.siteType,'int');
  assert.equal(bytes.compiled.type,'byte');
  assert.equal(strings.compiled.type,'java.lang.String');
  const changed=structuredClone(ordered.compiled); changed.references.reverse();
  assert.throws(()=>verifyInlineDraft(ordered.proof,ordered.draft,changed),/changed a Java argument binding/);
  const guarded=source.replace('byte byteValue() { return narrow(); }','byte byteValue() { final byte result = narrow(); return result; }');
  const guardedStart=guarded.indexOf('narrow()',guarded.indexOf('byte byteValue()'));
  const guardedProof=await inspect(guarded,guardedStart,guardedStart+'narrow()'.length);
  const guardedDraft=buildInlineDraft(guarded,guardedProof);
  const guardedCheck=await inspect(guardedDraft.after,guardedDraft.start,guardedDraft.end,0);
  assert.match(guardedCheck.error,/compile-time constant/);
  const caret=source.indexOf(fixture.call)+2;
  assert.equal((await inspect(source,caret,caret)).method,'score');
  for (const [marker,from,reason] of [[fixture.call,source.indexOf('int nested()'),/whole return expression/],
    ['score(take(4), take(5), take(6))',0,/whole return expression/],['receiver.instanceOnly(7)',0,/newly constructed/],
    ['locked(9)',0,/unsynchronized private/],['score("other")',0,/supported Java operators/],['mutate(5)',0,/supported Java operators/]]) {
    const {start,end}=at(marker,from);
    assert.match((await inspect(source,start,end)).error,reason);
  }
  const binary=tool=>path.join(javaHome,'bin',tool+(process.platform==='win32'?'.exe':''));
  for (const [index,text] of [source,ordered.draft.after,local.draft.after,bytes.draft.after,strings.draft.after].entries()) {
    const dir=path.join(owned,'run-'+index),input=path.join(dir,name+'.java');
    await fs.mkdir(dir); await fs.writeFile(input,text,{flag:'wx'});
    const compile=await execute(binary('javac'),['-encoding','UTF-8','-d',dir,input]);
    assert.equal(compile.code,0,compile.output);
    const run=await execute(binary('java'),['-cp',dir,namespace+'.'+name]);
    assert.equal(run.code,0,run.output);
    assert.equal(run.output,fixture.expectedOutput);
  }
  if(process.env.ROCKETBRAIN_INLINE_METHOD_RECEIPT)await fs.writeFile(process.env.ROCKETBRAIN_INLINE_METHOD_RECEIPT,
    JSON.stringify({jdk:25,exactSelectedOverload:true,orderedArguments:[1,2,3],references:[1,0,0],unusedArgumentEvaluated:true,
      nonconstantStringIdentity:true,primitiveReturnConversion:true,localVarTypePreserved:true,compiledAndRan:5,output:fixture.expectedOutput,
      unsafeContextsRefused:7},null,2)+'\n');
});
