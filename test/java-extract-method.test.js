'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {pathToFileURL}=require('node:url');
const {test}=require('node:test');
const {analyzeJavaSources}=require('../src/java/signature-compiler');
const {buildMethodExtraction,verifyMethodExtraction}=require('../src/java/extract-method');
const {extractMethodFixture}=require('./helpers/extract-method-fixture');

const config=process.env.ROCKETBRAIN_JAVA_TEST_CONFIG,run=promisify(execFile);

test('javac attributes a generic multi-statement extraction and preserves checked exception identity and selected overload',{
  skip:!config,timeout:120000
},async t=>{
  const {javaHome}=JSON.parse(await fs.readFile(config,'utf8'));
  const parent=await fs.realpath(os.tmpdir()),root=await fs.mkdtemp(path.join(parent,'rb-extract-method-'));
  t.after(async()=>{
    const actual=await fs.realpath(root);
    assert.equal(path.dirname(actual),parent);assert.match(path.basename(actual),/^rb-extract-method-/);
    await fs.rm(actual,{recursive:true,force:true});
  });
  const file=path.join(root,'Sample.java'),uri=pathToFileURL(file).href;
  const {text,selected,unsafe}=extractMethodFixture('fixture','Sample');
  async function inspect(input,{start,end,callOffset=-1},name='decide') {
    const answer=await analyzeJavaSources({javaHome,storagePath:root,sources:[{uri,text:input}],
      inspection:{kind:'methodExtract',uri,start,end,callOffset,name}});
    assert.deepEqual(answer.errors,[]);
    return answer.methodExtract;
  }
  const selection=snippet=>{const start=text.indexOf(snippet);return {start,end:start+snippet.length};};
  const initial=await inspect(text,selection(selected));
  const draft=buildMethodExtraction(text,initial,'decide');
  assert.match(draft.text,/return Sample\.<T, E>decide\(value, suffix, allow, failure\);/);
  assert.match(draft.text,/private static <T extends CharSequence, E extends IOException> T decide\(T value, java.lang.String suffix, int allow, E failure\) throws E/);
  const after=await inspect(draft.text,draft);
  verifyMethodExtraction(initial,after);
  assert.ok(after.bindings.some(value=>value.includes('#normalize(T,java.lang.String)')));
  assert.equal(initial.statementCount,4);
  assert.deepEqual(initial.throwsTypes,['E']);
  assert.deepEqual(initial.typeNames,['T','E']);
  assert.match((await inspect(text,selection(unsafe))).error,/Captured writes/);
  assert.match((await inspect(text,selection(selected),'normalize')).error,/unused/);
  assert.match((await inspect(text,selection(selected.slice(2)))).error,/complete trailing statements/);
  assert.throws(()=>verifyMethodExtraction(initial,{...after,call:{...after.call,arguments:[...after.call.arguments].reverse()}}),/replacement call/);
  async function execute(source) {
    const java=tool=>path.join(javaHome,'bin',tool+(process.platform==='win32'?'.exe':''));
    await fs.writeFile(file,source);
    await run(java('javac'),['-proc:none','-d',root,file],{timeout:25000,windowsHide:true});
    return (await run(java('java'),['-cp',root,'fixture.Sample'],{timeout:20000,windowsHide:true})).stdout;
  }
  const beforeRun=await execute(text),afterRun=await execute(draft.text);
  assert.equal(beforeRun,'+ok+zero+:same');assert.equal(afterRun,beforeRun);
  if(process.env.ROCKETBRAIN_METHOD_EXTRACTION_RECEIPT) await fs.writeFile(process.env.ROCKETBRAIN_METHOD_EXTRACTION_RECEIPT,
    JSON.stringify({beforeRun,afterRun,statements:initial.statementCount,typeParameters:initial.typeNames,throwsTypes:initial.throwsTypes,
      captures:initial.captures.map(({name,type})=>({name,type})),bindings:initial.bindings.length,
      capturedWriteRefused:true,nameConflictRefused:true,partialSelectionRefused:true},null,2)+'\n');
});
