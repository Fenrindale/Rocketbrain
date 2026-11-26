'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { sourceMap, buildSourceEvidence } = require('../src/java/kmp-debug-sources');
const { JavaDebugAdapter } = require('../src/java/debug-adapter');

const kotlinSmap=[
  'SMAP','Main.kt','Kotlin','*S Kotlin','*F','+ 1 Main.kt','fixture/MainKt',
  '+ 2 Main.kt','other/MainKt','*L','1#1,6:1','1#2:9','*E',''
].join('\n');

test('Kotlin SMAP attributes only primary, unambiguous executable source ranges',()=>{
  assert.equal(sourceMap(kotlinSmap,'Main.kt'),undefined);
  const mapping=sourceMap(kotlinSmap.replace('+ 2 Main.kt','+ 2 Other.kt'),'Main.kt');
  assert.equal(mapping.stratum,'Kotlin');
  assert.equal(mapping.path,'fixture/MainKt');
  assert.equal(mapping.line(6),6);
  assert.equal(mapping.line(7),undefined);
  assert.equal(mapping.line(9),undefined);
  assert.equal(sourceMap('','Main.kt').line(9),9);
});

test('Kotlin source-line evidence pairs package and filename, and discards ambiguous methods or repeated sources',()=>{
  const fixture=path.resolve('fixture/commonMain/fixture/Main.kt');
  const twin=path.resolve('fixture/jvmMain/fixture/Main.kt');
  const other=path.resolve('fixture/commonMain/different/Main.kt');
  const source=(file,namespace)=>({file,text:'package '+namespace+'\n\nfun first() {\n    println(1)\n}\n',sha256:'a'.repeat(64)});
  const files=new Map([[fixture,source(fixture,'fixture')],[other,source(other,'different')]]);
  const method={method:'first',signature:'()V',code:'b'.repeat(64),entries:[[0,4],[1,4]]};
  const binary=(owner,methods)=>({owner,source:'Main.kt',mapping:sourceMap('','Main.kt'),debugSha256:'',methods});
  const owner='fixture/ChangedFacade';
  const mapped=buildSourceEvidence({files},[binary(owner,[method]),binary('different/MainKt',[method])]);
  assert.equal(mapped.files.find(file=>file.file===fixture).lines[4].owner,'fixture.ChangedFacade');
  assert.equal(mapped.files.find(file=>file.file===fixture).lines[4].bci,0);
  assert.equal(mapped.files.find(file=>file.file===other).lines[4].owner,'different.MainKt');
  const ambiguous=buildSourceEvidence({files},[binary(owner,[method,{...method,method:'second'}])]);
  assert.deepEqual(ambiguous.files[0].lines,{});
  files.set(twin,source(twin,'fixture'));
  assert.deepEqual(buildSourceEvidence({files},[binary(owner,[method])]).files,[]);
});

test('Groovy line evidence binds the conventional named class and exact executable method',()=>{
  const file=path.resolve('src/main/groovy/example/Probe.groovy');
  const files=new Map([[file,{file,text:'package example\nclass Probe {\n  int read() { 42 }\n}\n',sha256:'a'.repeat(64)}]]);
  const binary={owner:'example/Probe',source:'Probe.groovy',mapping:sourceMap('','Probe.groovy'),debugSha256:'',
    methods:[{method:'read',signature:'()I',code:'b'.repeat(64),entries:[[0,3]]}]};
  const {format,files:mapped}=buildSourceEvidence({files},[binary,
    {...binary,owner:'example/Probe$_read_closure1'}, {...binary,owner:'other/Probe'}],'groovy');
  assert.equal(format,'RocketbrainGroovySourceLines1');
  assert.deepEqual(mapped.map(item=>[item.file,item.lines[3].owner,item.lines[3].stratum]),
    [[file,'example.Probe','Java']]);
  assert.deepEqual(buildSourceEvidence({files},[binary,binary],'groovy').files,[]);
});

test('Source-line evidence reaches only the verified IPv4-loopback attach, with dirty source marked',()=>{
  const file=path.resolve('src/main/groovy/Probe.groovy');
  const observed=[];
  const adapter=Object.assign(Object.create(JavaDebugAdapter.prototype),{
    sourceLines:{format:'RocketbrainGroovySourceLines1',files:[]}, sourceLinePort:41052,
    vscode:{workspace:{textDocuments:[{isDirty:true,uri:{scheme:'file',fsPath:file}}]}},
    observeRequest:message=>observed.push(message),socket:{write(){}}
  });
  adapter.handleMessage({type:'request',command:'attach',arguments:{
    hostName:'127.0.0.1',port:41052,rocketbrainKotlinSourceLines:{forged:true},rocketbrainGroovySourceLines:{forged:true}
  }});
  assert.equal(observed[0].arguments.rocketbrainKotlinSourceLines,undefined);
  assert.equal(observed[0].arguments.rocketbrainGroovySourceLines.format,'RocketbrainGroovySourceLines1');
  adapter.handleMessage({type:'request',command:'setBreakpoints',arguments:{source:{path:file}}});
  assert.equal(observed[1].arguments.sourceModified,true);
  adapter.handleMessage({type:'request',command:'attach',arguments:{
    hostName:'127.0.0.1',port:41053,rocketbrainGroovySourceLines:{forged:true}
  }});
  assert.equal(observed[2].arguments.rocketbrainGroovySourceLines,undefined);
});
