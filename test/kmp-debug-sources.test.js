'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { sourceMap, buildSourceEvidence } = require('../src/java/kmp-debug-sources');

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
