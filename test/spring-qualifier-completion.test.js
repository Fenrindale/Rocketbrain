'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');
const { analyzeJavaSources } = require('../src/java/signature-compiler');
const { qualifierHole,qualifierDraft,insertion,qualifierCandidates } = require('../src/spring/qualifier-completion');
const { qualifierFixture,qualifierClasspath,runQualifierFixture,runtimeObservation } = require('./helpers/spring-qualifier-fixture');

const javaConfig=process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;
const classpathFile=process.env.ROCKETBRAIN_SPRING_QUALIFIER_CLASSPATH;
const configFiles=['mysql','mariadb'].map(engine=>[engine,process.env['ROCKETBRAIN_SPRING_QUALIFIER_'+engine.toUpperCase()+'_CONFIG']]);
const parse=file=>fs.readFile(file,'utf8').then(JSON.parse);

test('Spring qualifier edit range preserves existing quotes and repairs a local missing quote',()=>{
  for (const [input,expected] of [
    ['@Qualifier("|")','@Qualifier("reader")'],
    ['@Qualifier(value = "re|old")','@Qualifier(value = "reader")'],
    ['@Qualifier("re|) Service field;','@Qualifier("reader") Service field;'],
    ['@org.springframework.beans.factory.annotation.Qualifier(value = |) Service field;',
      '@org.springframework.beans.factory.annotation.Qualifier(value = "reader") Service field;']
  ]) {
    const offset=input.indexOf('|'), text=input.replace('|',''), hole=qualifierHole(text,offset);
    assert.ok(hole,input);
    assert.equal(text.slice(0,hole.start)+insertion(hole,'reader')+text.slice(hole.end),expected);
    assert.match(qualifierDraft(text,hole).text,/"__rocketbrain_qualifier_probe__"\)/u);
  }
  for (const input of ['// @Qualifier("|")','String s = """\n@Qualifier("|")\n""";',
    '@Other("|")','@Qualifier(a + "|")','@Qualifier(value = "a"+ "|")','@Qualifier("re|\\"")',
    '@custom.Qualifier("|")','@Qualifier("re|\n)']) {
    assert.equal(qualifierHole(input.replace('|',''),input.indexOf('|')),null,input);
  }
});

async function workspace(t) {
  const {javaHome}=await parse(javaConfig), parent=await fs.realpath(os.tmpdir());
  const root=await fs.mkdtemp(path.join(parent,'rb-qualifier-completion-'));
  t.after(async()=>{
    assert.equal(await fs.realpath(root),root);assert.equal(path.dirname(root),parent);
    await fs.rm(root,{recursive:true,force:true,maxRetries:7,retryDelay:220});
  });
  const file=path.join(root,'QualifierDemo.java'), uri=pathToFileURL(file).href;
  return {root,javaHome,file,uri};
}

async function fixtureAnalysis({root,javaHome,uri},source,offset,classpath) {
  const hole=qualifierHole(source,offset);
  assert.ok(hole);
  const draft=qualifierDraft(source,hole), sources=[{uri,text:draft.text}];
  const report=await analyzeJavaSources({javaHome,storagePath:root,classpath,sources,
    inspection:{kind:'springQualifier',uri,start:draft.start,end:draft.end}});
  assert.deepEqual(report.errors,[]);
  return {source,hole,sources,uri,text:draft.text,attributed:report.springQualifier,scopedProperties:[]};
}

test('real Javac binds only actual Spring qualifier injection sites and compatible declarations',{
  skip:!javaConfig||!classpathFile,timeout:100000
},async t=>{
  const input=await workspace(t), fixture=qualifierFixture('fixture','QualifierDemo');
  const classpath=await qualifierClasspath(classpathFile,'mysql');
  const analyzed=await fixtureAnalysis(input,fixture.source,fixture.source.indexOf(fixture.names.draft)+13,classpath);
  assert.deepEqual([analyzed.attributed.site.type,analyzed.attributed.site.origin],[fixture.reader,'constructor']);
  assert.ok(analyzed.attributed.declarations.some(item=>item.type===fixture.actual));
  assert.ok(analyzed.attributed.declarations.some(item=>item.kind==='component'&&item.type===fixture.className+'ComponentReader'));
  assert.equal(analyzed.attributed.declarations.some(item=>item.type==='java.lang.String'),false);
  const fieldSource=fixture.source.replace('Qualifier("'+fixture.names.explicit+'") private','Qualifier("QualifierDemo") private');
  const field=await fixtureAnalysis(input,fieldSource,fieldSource.indexOf('QualifierDemo") private')+13,classpath);
  assert.equal(field.attributed.site.origin,'field');
  const factoryOffset=fixture.source.indexOf('Check(@Qualifier("')+'Check(@Qualifier("'.length;
  const initializedOffset=fixture.source.indexOf('initialize(@Qualifier("')+'initialize(@Qualifier("'.length;
  for(const [offset,origin] of [[factoryOffset,'factory-parameter'],[initializedOffset,'method-parameter']]) {
    const parameter=await fixtureAnalysis(input,fixture.source,offset,classpath);
    assert.equal(parameter.attributed.site.origin,origin);
  }
  const fake='package fixture; @interface Qualifier { String value(); } public class QualifierDemo { @Qualifier("ab") Object field; }';
  const forged=await fixtureAnalysis(input,fake,fake.indexOf('ab"')+2,classpath);
  assert.equal(forged.attributed.site,null);
  const plain=fixture.source.replace('@Autowired @Qualifier("'+fixture.names.explicit+'") private','@Qualifier("QualifierDemo") private');
  const withoutInjection=await fixtureAnalysis(input,plain,plain.indexOf('QualifierDemo") private')+13,classpath);
  assert.equal(withoutInjection.attributed.site,null);
});

test('real Spring resolves completed constructor and field injection on MySQL and MariaDB',{
  skip:!javaConfig||!classpathFile||!configFiles.every(([,file])=>file),timeout:140000
},async t=>{
  const input=await workspace(t),fixture=qualifierFixture('fixture','QualifierDemo'),reports=[];
  const prefix='QualifierDemo', offset=fixture.source.indexOf(fixture.names.draft)+prefix.length;
  for (const [engine,configFile] of configFiles) {
    const classpath=await qualifierClasspath(classpathFile,engine);
    const analyzed=await fixtureAnalysis(input,fixture.source,offset,classpath);
    const options={activeProfiles:[engine]};
    const match=runtime=>qualifierCandidates({...analyzed,options,runtime});
    const declared=match(null), values=declared.map(item=>item.value);
    const selected=engine==='mysql'?fixture.names.mysql:fixture.names.maria;
    for(const name of [selected,fixture.names.explicit,fixture.names.component]) assert.ok(values.includes(name),name+' '+values.join(','));
    if(engine==='mysql') assert.ok(values.includes(fixture.names.alias));
    for(const name of [fixture.names.observed,fixture.names.wrong,fixture.names.hidden,fixture.names.repeated,
      engine==='mysql'?fixture.names.maria:fixture.names.mysql]) assert.ok(!values.includes(name),name);
    const config=await parse(configFile);
    async function executeChoice(choice) {
      const completed=fixture.source.slice(0,analyzed.hole.start)+insertion(analyzed.hole,choice.value)+fixture.source.slice(analyzed.hole.end);
      await fs.writeFile(input.file,completed);
      const binaryDirectory=await fs.mkdtemp(path.join(input.root,'classes-'));
      return runQualifierFixture({javaHome:input.javaHome,file:input.file,binaryDirectory,
        className:fixture.className,classpath,config,engine});
    }
    const actual=await executeChoice(declared.find(item=>item.value===selected));
    const [result,profile,type]=actual.output.split(';');
    assert.equal(result,'84');assert.equal(profile,engine);assert.equal(type,fixture.actual);
    const runtime=runtimeObservation(fixture.names.observed,type,profile);
    const conditional=match(runtime).find(item=>item.value===fixture.names.observed);
    assert.equal(conditional?.evidence,'observed');
    const applied=await executeChoice(conditional);
    assert.deepEqual(applied,{...actual,output:'85;'+profile+';'+type});
    assert.equal(match(runtimeObservation(fixture.names.observed,type,'other')).some(item=>item.value===fixture.names.observed),false);
    assert.equal(match(runtimeObservation(fixture.names.observed,'java.lang.String',profile)).some(item=>item.value===fixture.names.observed),false);
    runtime.contexts.push(runtime.contexts[0]);
    assert.equal(match(runtime).some(item=>item.value===fixture.names.observed),false);
    reports.push({engine,server:actual.server,profile,selected,actualReadback:Number(result),observedActuatorType:type,observedReadback:85,
      declarations:values.length,incompatibleAndAmbiguousOmitted:true});
  }
  if(process.env.ROCKETBRAIN_SPRING_QUALIFIER_RECEIPT) await fs.writeFile(process.env.ROCKETBRAIN_SPRING_QUALIFIER_RECEIPT,
    JSON.stringify({spring:'7.0.10',actuator:'4.1.2',jdk:'Temurin 25.0.5+8',results:reports})+'\n');
});
