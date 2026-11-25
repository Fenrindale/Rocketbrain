'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');
const { analyzeJavaSources } = require('../src/java/signature-compiler');
const { completionHole,substitute,readCompletion,verifyCompletion } = require('../src/java/expected-completion');
const { expectedCompletionFixture,springJdbcClasspath,executeExpectedFixture } = require('./helpers/expected-completion-fixture');

const javaConfig=process.env.ROCKETBRAIN_JAVA_TEST_CONFIG,classpathFile=process.env.ROCKETBRAIN_EXPECTED_COMPLETION_CLASSPATH;
const dbFiles=['mysql','mariadb'].map(engine=>[engine,process.env['ROCKETBRAIN_EXPECTED_COMPLETION_'+engine.toUpperCase()+'_CONFIG']]);
const read=async file=>JSON.parse(await fs.readFile(file,'utf8'));

test('Java completion targets one bounded token and checks the same overload and declaration on insertion',()=>{
  const text='Value<String> result = suitable;';
  const hole=completionHole(text,text.indexOf('suitable')+3);
  assert.equal(hole.prefix,'sui');
  assert.equal(substitute(text,hole,'null'),'Value<String> result = null;');
  assert.throws(()=>completionHole('return holder.',14),/standalone unfinished/u);
  assert.throws(()=>completionHole('return '+ 'a'.repeat(400),207),/standalone unfinished/u);
  assert.throws(()=>completionHole(String.raw`// x \u000a return`,5),/Unicode escapes/u);
  const candidate={name:'choice',type:'Value<String>',kind:'PARAMETER',declarationStart:12};
  const receipt={expectedType:candidate.type,context:'lambda',call:'Sample#select(java.util.List)'};
  assert.throws(()=>verifyCompletion(receipt,candidate,{...receipt,call:'Sample#select(java.util.Collection)',selected:candidate}),/enclosing overload/u);
  assert.throws(()=>verifyCompletion(receipt,candidate,{...receipt,selected:{...candidate,declarationStart:42}}),/declaration/u);
});

async function configure(t,spring=false) {
  const {javaHome}=await read(javaConfig),namespace='fixture',name='ValueCompletion';
  const parent=await fs.realpath(os.tmpdir()),root=await fs.mkdtemp(path.join(parent,'rb-expected-completion-'));
  t.after(async()=>{
    assert.equal(await fs.realpath(root),root);
    assert.equal(path.dirname(root),parent);
    await fs.rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:200});
  });
  const sample=expectedCompletionFixture(namespace,name,{spring});
  const file=path.join(root,name+'.java'),uri=pathToFileURL(file).href;
  const analyze=(source,start,end,stage,classpath)=>analyzeJavaSources({javaHome,classpath,storagePath:root,sources:[{uri,text:source}],
    inspection:{kind:'expectedCompletion',uri,start,end,stage}});
  async function inspect(marker,original,prefix,classpath=[]) {
    const position=sample.source.indexOf(marker)+marker.lastIndexOf(original);
    assert.ok(position>=0);
    const draft=sample.source.slice(0,position)+prefix+sample.source.slice(position+original.length);
    const hole=completionHole(draft,position+prefix.length);
    const probe=await analyze(substitute(draft,hole,'null'),hole.start,hole.start+4,'plan',classpath);
    assert.deepEqual(probe.errors,[]);
    const report=readCompletion(probe.expectedCompletion,hole);
    const candidate=report.candidates.find(item=>item.name===original);
    assert.ok(candidate,JSON.stringify(report));
    const fixed=substitute(draft,hole,candidate.name);
    const checked=await analyze(fixed,hole.start,hole.start+candidate.name.length,'verify',classpath);
    assert.deepEqual(checked.errors,[]);
    verifyCompletion(report,candidate,checked.expectedCompletion);
    return {report,candidate,fixed};
  }
  async function run(text,options={}) {
    const binaryDirectory=await fs.mkdtemp(path.join(root,'classes-'));
    await fs.writeFile(file,text);
    return executeExpectedFixture({javaHome,file,binaryDirectory,className:namespace+'.'+name,...options});
  }
  return {sample,inspect,run,analyze};
}

test('Javac selects compatible generic locals in an unfinished Stream lambda and preserves the selected Java overload',{
  skip:!javaConfig,timeout:115000
},async t=>{
  const {sample,inspect,run,analyze}=await configure(t);
  const stream=await inspect(sample.marker,sample.value,sample.prefix);
  assert.equal(stream.report.expectedType,sample.type);
  assert.equal(stream.report.context,'lambda');
  assert.match(stream.report.call,/java\.util\.stream\.Stream#map/u);
  assert.deepEqual(stream.report.candidates.map(item=>item.name),['ticketReady']);
  assert.equal(stream.candidate.kind,'LOCAL_VARIABLE');
  const empty=await inspect(sample.marker,sample.value,'');
  assert.deepEqual(empty.report.candidates.map(item=>item.name),['ticketReady']);
  const overload=await inspect('return choose(rows,row -> stable);','stable','sta');
  assert.match(overload.report.call,/#choose\(java\.util\.List<T>,java\.util\.function\.Function<T,R>\)/u);
  assert.equal(overload.candidate.kind,'PARAMETER');
  for (const [marker,context] of [['Number> result = scores','initializer'],['{ return scores; }','return']]) {
    const result=await inspect(marker,'scores','score');
    assert.equal(result.report.context,context);
    assert.equal(result.report.expectedType,'java.util.List<? extends java.lang.Number>');
    assert.deepEqual(result.report.candidates.map(item=>item.name),['scores']);
  }
  const unsupported='class ValueCompletion { void m(int number) { var inferred = null; } }';
  const pos=unsupported.indexOf('null');
  const unknown=await analyze(unsupported,pos,pos+4,'plan',[]);
  assert.ok(unknown.errors.length>0);
  assert.deepEqual(await run(stream.fixed),{output:sample.output});
});

test('actual Spring JDBC reads both owned database engines in the Java program completed by its generic expected type',{
  skip:!javaConfig||!classpathFile||!dbFiles.every(([,file])=>file),timeout:120000
},async t=>{
  const {sample,inspect,run}=await configure(t,true),results=[];
  for (const [engine,configFile] of dbFiles) {
    const classpath=await springJdbcClasspath(classpathFile,engine),config=await read(configFile);
    const result=await inspect(sample.marker,sample.value,sample.prefix,classpath);
    assert.equal(result.report.expectedType,sample.type);
    assert.equal(result.candidate.name,'ticketReady');
    const observed=await run(result.fixed,{engine,config,classpath});
    assert.equal(observed.output,sample.output);
    results.push(observed);
  }
  if (process.env.ROCKETBRAIN_EXPECTED_COMPLETION_RECEIPT) await fs.writeFile(process.env.ROCKETBRAIN_EXPECTED_COMPLETION_RECEIPT,
    JSON.stringify({jdk:'Temurin 25.0.5+8',springJdbc:'7.0.10',expectedType:sample.type,selected:sample.value,results})+'\n');
});
