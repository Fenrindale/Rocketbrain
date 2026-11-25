'use strict';

const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs/promises');
const os=require('node:os');
const {pathToFileURL}=require('node:url');
const {test}=require('node:test');
const {analyzeJavaSources}=require('../src/java/signature-compiler');
const {callFlow}=require('../src/java/source-analysis-model');
const {execute}=require('../src/java/testing/provision');
const {callFlowFixture,springJdbcClasspath,runSpringCallFlow}=require('./helpers/java-call-flow-fixture');

const javaConfig=process.env.ROCKETBRAIN_JAVA_TEST_CONFIG, springCp=process.env.ROCKETBRAIN_JAVA_CALL_FLOW_CLASSPATH;
const dbConfigs=['mysql','mariadb'].map(engine=>[engine,process.env['ROCKETBRAIN_JAVA_CALL_FLOW_'+engine.toUpperCase()+'_CONFIG']]);
const read=file=>fs.readFile(file,'utf8').then(JSON.parse);

async function setup(t) {
  const {javaHome}=await read(javaConfig),parent=await fs.realpath(os.tmpdir()),root=await fs.mkdtemp(path.join(parent,'rb-java-call-flow-'));
  t.after(async()=>{
    assert.equal(await fs.realpath(root),root);assert.equal(path.dirname(root),parent);
    await fs.rm(root,{recursive:true,force:true,maxRetries:7,retryDelay:200});
  });
  const fixture=callFlowFixture('fixture','CallFlowProbe');
  const source=role=>{
    const file=path.join(root,fixture[role+'Name']+'.java');
    return {file,uri:pathToFileURL(file).href,text:fixture[role]};
  };
  const caller=source('caller'),helper=source('helper'),runner=source('runner');
  async function inspect(target,term,opts={}) {
    const offset=target.text.indexOf(term)+(opts.shift??0);
    assert.ok(offset>=0);
    const sources=[caller,helper,...(opts.classpath?[runner]:[])];
    const report=await analyzeJavaSources({javaHome,storagePath:root,sources,classpath:opts.classpath||[],
      inspection:{kind:'callFlow',uri:target.uri,offset,caller:opts.caller}});
    assert.deepEqual(report.errors,[]);
    assert.equal(report.processorsEnabled,false);
    return callFlow(report,target,sources,offset);
  }
  return {fixture,root,javaHome,caller,helper,runner,inspect};
}

test('call-flow model validates cross-file source, earlier edges and the selected frame',()=>{
  const first={uri:'file:///first.java',text:'raw'},second={uri:'file:///second.java',text:'formal'};
  const event=(id,uri,start,end,inputs,frame)=>({id,uri,start,end,inputs,frame,kind:'parameter',name:'value',method:'fixture.A#method(int)'});
  const report={callFlow:{uri:first.uri,originFrame:0,method:'fixture.A#method(int)',contexts:[],omittedContexts:0,
    events:[event(0,first.uri,0,3,[],0),event(1,second.uri,0,6,[0],1)]}};
  assert.equal(callFlow(report,first,[first,second],0).uses[0].uri,second.uri);
  report.callFlow.events[1].inputs=[1];
  assert.throws(()=>callFlow(report,first,[first,second],0),/Invalid Java call flow event/u);
  report.callFlow.events[1].inputs=[0];
  assert.throws(()=>callFlow(report,first,[first],0),/Invalid Java call flow source range/u);
  report.callFlow.originFrame=1;
  assert.throws(()=>callFlow(report,first,[first,second],0),/Place the cursor/u);
});

test('real Javac traces overloads across exact caller frames and refuses recursive, external and virtual calls',{
  skip:!javaConfig,timeout:120000
},async t=>{
  const {fixture,caller,helper,inspect}=await setup(t);
  const forward=await inspect(caller,'int raw)',{shift:4});
  assert.deepEqual([forward.origin.kind,forward.origin.name],['parameter','raw']);
  assert.ok(forward.uses.some(event=>event.kind==='parameter'&&event.uri===helper.uri&&event.method===fixture.scaleKey));
  assert.ok(forward.uses.some(event=>event.kind==='call-result'&&event.name===fixture.scaleKey));
  assert.ok(forward.uses.some(event=>event.kind==='return'&&event.method===fixture.firstKey));
  assert.ok(!forward.uses.some(event=>event.name==='ignored'));
  assert.equal(forward.uses.filter(event=>event.uri===helper.uri&&event.kind==='parameter').length,1);
  const backward=await inspect(caller,'var output',{shift:4});
  assert.ok(backward.inputs.some(event=>event.kind==='definition'&&event.name==='shifted'&&event.uri===helper.uri));
  const inside=await inspect(helper,'int value)',{shift:4});
  assert.equal(inside.contexts.length,3);
  assert.equal(inside.inputs.length,0);
  const alternate=inside.contexts.find(context=>context.method===fixture.alternateKey);
  const context=await inspect(helper,'int value)',{shift:4,caller:alternate});
  assert.ok(context.inputs.some(event=>event.kind==='parameter'&&event.name==='incoming'&&event.uri===caller.uri));
  assert.ok(!context.inputs.some(event=>event.name==='raw'));
  assert.ok(context.uses.some(event=>event.kind==='return'&&event.method===fixture.alternateKey));
  const repeated=inside.contexts.filter(item=>item.method===fixture.firstKey).at(-1);
  const separate=await inspect(helper,'int value)',{shift:4,caller:repeated});
  assert.ok(separate.inputs.some(event=>event.kind==='literal'&&event.name==='99'));
  assert.ok(!separate.uses.some(event=>event.method===fixture.firstKey&&event.kind==='return'));
  const instance=await inspect(caller,'var converted',{shift:4});
  assert.ok(instance.inputs.some(event=>event.kind==='call-result'&&event.name.endsWith('#privateDouble(int)')));
  const literal=await inspect(helper,'return true');
  assert.ok(literal.inputs.some(event=>event.kind==='true-value'));
  assert.ok(!literal.inputs.some(event=>event.kind==='false-value'||event.name==='null'));
  for(const [marker,message] of [['int recursive',/Recursive calls/u],['int external',/body in the selected Java project/u],
    ['int virtual',/known dispatch/u]]) await assert.rejects(inspect(helper,marker),message);
});

test('actual Spring JDBC and Javac trace possible null and value returns on both owned database engines',{
  skip:!javaConfig||!springCp||!dbConfigs.every(([,file])=>file),timeout:130000
},async t=>{
  const {fixture,root,javaHome,caller,helper,runner,inspect}=await setup(t),results=[];
  for(const source of [caller,helper,runner])await fs.writeFile(source.file,source.text);
  const compiler=path.join(javaHome,'bin',process.platform==='win32'?'javac.exe':'javac');
  for(const [engine,file] of dbConfigs) {
    const classpath=await springJdbcClasspath(springCp,engine),config=await read(file);
    const report=await inspect(caller,'var selected',{shift:4,classpath});
    assert.ok(report.inputs.some(event=>event.kind==='true-value'&&event.uri===helper.uri));
    assert.ok(report.inputs.some(event=>event.kind==='false-value'&&event.uri===helper.uri));
    assert.ok(report.inputs.some(event=>event.kind==='literal'&&event.name==='null'&&event.uri===helper.uri));
    assert.ok(report.inputs.some(event=>event.kind==='choice'));
    const binaryDirectory=await fs.mkdtemp(path.join(root,'classes-'));
    const result=await execute(compiler,['-proc:none','-d',binaryDirectory,caller.file,helper.file],{timeoutMs:25000});
    assert.equal(result.code,0,result.output);
    const actual=await runSpringCallFlow({javaHome,file:runner.file,binaryDirectory,className:fixture.runnerClass,
      classpath:[...classpath,binaryDirectory],engine,config});
    assert.equal(actual.output,'90:present:true');
    results.push({...actual,possibleNullAndValue:true,crossFile:true});
  }
  if(process.env.ROCKETBRAIN_JAVA_CALL_FLOW_RECEIPT)await fs.writeFile(process.env.ROCKETBRAIN_JAVA_CALL_FLOW_RECEIPT,
    JSON.stringify({jdk:'Temurin 25.0.5+8',springJdbc:'7.0.10',results})+'\n');
});
