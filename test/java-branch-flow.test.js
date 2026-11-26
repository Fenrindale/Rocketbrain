'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {test}=require('node:test');
const {analyzeJavaSources}=require('../src/java/signature-compiler');
const {callFlow}=require('../src/java/source-analysis-model');
const {execute}=require('../src/java/testing/provision');
const {branchFlowFixture,springJdbcClasspath,runBranchSpring}=require('./helpers/java-branch-flow-fixture');

const javaConfig=process.env.ROCKETBRAIN_JAVA_TEST_CONFIG, cp=process.env.ROCKETBRAIN_BRANCH_FLOW_CLASSPATH;
const dbs=['mysql','mariadb'].map(engine=>[engine,process.env['ROCKETBRAIN_BRANCH_FLOW_'+engine.toUpperCase()+'_CONFIG']]);
const read=file=>fs.readFile(file,'utf8').then(JSON.parse);
const literals=report=>report.inputs.filter(event=>event.kind==='literal').map(event=>event.name);
const branches=report=>report.inputs.filter(event=>event.kind==='branch').map(event=>event.name);

async function setup(t) {
  const {javaHome}=await read(javaConfig),parent=await fs.realpath(os.tmpdir()),root=await fs.mkdtemp(path.join(parent,'rb-branch-flow-'));
  t.after(async()=>{
    assert.equal(await fs.realpath(root),root);assert.equal(path.dirname(root),parent);
    await fs.rm(root,{recursive:true,force:true,maxRetries:7,retryDelay:220});
  });
  const fixture=branchFlowFixture('fixture','BranchProbe');
  const source=role=>{
    const file=path.join(root,fixture[role+'Name']+'.java');
    return {file,uri:pathToFileURL(file).href,text:fixture[role]};
  };
  const caller=source('caller'),helper=source('helper'),runner=source('runner');
  async function trace(target,marker,shift=0,{callerContext,classpath}={}) {
    const base=target.text.indexOf(marker); assert.ok(base>=0,marker);
    const offset=base+shift, sources=[caller,helper,...(classpath?[runner]:[])];
    const report=await analyzeJavaSources({javaHome,storagePath:root,sources,classpath:classpath||[],
      inspection:{kind:'callFlow',uri:target.uri,offset,caller:callerContext}});
    assert.deepEqual(report.errors,[]);assert.equal(report.processorsEnabled,false);
    return callFlow(report,target,sources,offset);
  }
  return {javaHome,root,fixture,caller,helper,runner,trace};
}

test('Javac tracks finite assignments, early returns and boolean or null filtering through independent call frames',{
  skip:!javaConfig,timeout:175000
},async t=>{
  const {fixture,caller,helper,trace}=await setup(t);
  const dynamic=await trace(caller,'var outcome',4);
  assert.ok(dynamic.inputs.some(event=>event.kind==='branch-merge'&&event.name==='Join result'));
  assert.deepEqual(new Set(branches(dynamic)),new Set(['True branch','False branch']));
  const writes=dynamic.inputs.filter(event=>event.kind==='assignment'&&event.name==='result');
  assert.equal(writes.length,2);
  assert.ok(writes.every(event=>event.uri===helper.uri&&event.method===fixture.routeKey));
  const local=await trace(helper,'if (enabled)');
  assert.equal(local.origin.kind,'condition');
  assert.match(local.origin.name,/may be true or false/u);
  assert.equal(helper.text.slice(local.origin.start,local.origin.end),'if (enabled)');
  assert.ok(local.uses.some(event=>event.kind==='return'));

  const known=await trace(caller,'var knownOn',4);
  assert.ok(branches(known).includes('True branch'));
  assert.ok(!branches(known).includes('False branch')&&!literals(known).includes('"disabled"'));
  const propagated=await trace(caller,'var propagatedOn',4);
  assert.ok(propagated.inputs.some(event=>event.kind==='call-result'&&event.name.endsWith('#constant()')));
  assert.ok(!literals(propagated).includes('"disabled"'));

  const inside=await trace(helper,'boolean enabled',8);
  const occurrences=inside.contexts.filter(item=>item.method===fixture.repeatedKey);
  assert.equal(occurrences.length,2);
  const [one,two]=await Promise.all(occurrences.map(callerContext=>trace(helper,'boolean enabled',8,{callerContext})));
  assert.ok(one.inputs.some(event=>event.kind==='literal'&&event.name==='true'));
  assert.ok(two.inputs.some(event=>event.kind==='literal'&&event.name==='false'));
  assert.ok(!one.uses.some(event=>event.name==='False branch')&&!two.uses.some(event=>event.name==='True branch'));
  assert.ok(one.uses.some(event=>event.kind==='return'&&event.method===fixture.repeatedKey));
  assert.ok(!two.uses.some(event=>event.kind==='return'&&event.method===fixture.repeatedKey));

  const knownNull=await trace(caller,'var knownNull',4);
  assert.ok(literals(knownNull).includes('null')&&literals(knownNull).includes('"missing"'));
  assert.ok(!branches(knownNull).includes('False branch'));
  const narrowed=await trace(caller,'var selected',4);
  assert.ok(narrowed.inputs.some(event=>event.kind==='narrowed'&&event.name==='value is non-null'));
  assert.ok(narrowed.inputs.some(event=>event.kind==='return-merge'));
  assert.ok(!literals(narrowed).includes('"impossible"'));
  const comparison=await trace(caller,'var knownHigh',4);
  assert.ok(literals(comparison).includes('10')&&!literals(comparison).includes('8'));
  const optional=await trace(helper,'return count');
  assert.ok(optional.inputs.some(event=>event.kind==='parameter'&&event.name==='fallback'));
  assert.ok(literals(optional).includes('17'));
  assert.deepEqual(new Set(branches(optional)),new Set(['True branch','False branch']));
  const identity=await trace(caller,'var identity',4);
  assert.ok(literals(identity).includes('"same object"')&&literals(identity).includes('"different objects"'));
  const short=await trace(caller,'var shortValue',4);
  assert.ok(literals(short).includes('21')&&!literals(short).includes('19'));
  const unmodified=await trace(helper,'return flag');
  assert.ok(unmodified.inputs.some(event=>event.kind==='parameter'&&event.name==='flag'));
  assert.ok(!unmodified.inputs.some(event=>event.kind==='branch-merge'||event.kind==='condition'));
  await assert.rejects(trace(helper,'for (int i'),/Loops and other statements/u);
});

test('actual Spring JDBC executes the analyzed branch, null and early-return paths on both owned databases',{
  skip:!javaConfig||!cp||!dbs.every(([,file])=>file),timeout:155000
},async t=>{
  const {javaHome,root,fixture,caller,helper,runner,trace}=await setup(t),results=[];
  for(const source of [caller,helper,runner])await fs.writeFile(source.file,source.text);
  for(const [engine,file] of dbs) {
    const classpath=await springJdbcClasspath(cp,engine);
    const paths=await trace(caller,'var selected',4,{classpath});
    assert.ok(paths.inputs.some(event=>event.kind==='return-merge'));
    assert.ok(literals(paths).includes('"fallback"')&&!literals(paths).includes('"impossible"'));
    const binaryDirectory=await fs.mkdtemp(path.join(root,'classes-'));
    const compiler=path.join(javaHome,'bin',process.platform==='win32'?'javac.exe':'javac');
    const built=await execute(compiler,['-proc:none','-d',binaryDirectory,caller.file,helper.file],{timeoutMs:25000});
    assert.equal(built.code,0,built.output);
    const actual=await runBranchSpring({javaHome,file:runner.file,binaryDirectory,className:fixture.runnerClass,
      classpath:[...classpath,binaryDirectory],engine,config:await read(file)});
    assert.equal(actual.output,'active:disabled:missing:fallback:present:10');
    results.push({...actual,branchJoin:true,guardedEarlyReturn:true,impossibleArmExcluded:true});
  }
  if(process.env.ROCKETBRAIN_BRANCH_FLOW_RECEIPT)await fs.writeFile(process.env.ROCKETBRAIN_BRANCH_FLOW_RECEIPT,
    JSON.stringify({jdk:'Temurin 25.0.5+8',springJdbc:'7.0.10',results})+'\n');
});
