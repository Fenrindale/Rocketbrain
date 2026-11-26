'use strict';

const assert=require('node:assert/strict');
const path=require('node:path');
const {test}=require('node:test');
const {fileKey}=require('../src/java/dependency-builds');
const {bindKotlinJsMap,linkedKotlinMap}=require('../src/java/kmp-js-source-map');

function fixture() {
  const generated=path.resolve('build/js/packages/app/kotlin');
  const source=path.resolve('src/commonMain/kotlin/Exact.kt');
  const script='var result = 1;\n//# sourceMappingURL=app.js.map\n';
  const entry=path.join(generated,'app.js');
  const mapFile=path.join(generated,'app.js.map');
  const text='val result = 1\n';
  const snapshot={files:new Map([[fileKey(source),{file:source,text}]])};
  const map={version:3,names:[],sources:[path.relative(generated,source)],sourcesContent:[text],mappings:'AAAA,E,EAAG'};
  return {source,script,entry,mapFile,snapshot,map};
}

test('Kotlin/JS source maps bind exact saved files and preserve unmapped generated intervals',()=>{
  const data=fixture(), compiled=bindKotlinJsMap(data);
  assert.equal(linkedKotlinMap(data.script,data.entry),'app.js.map');
  assert.equal(compiled.sourceCount,1);
  assert.deepEqual(compiled.generatedLines(data.source,0),[0]);
  assert.deepEqual(compiled.original(0,1),{file:data.source,line:0,column:0});
  assert.equal(compiled.original(0,2),undefined);
  assert.deepEqual(compiled.original(0,4),{file:data.source,line:0,column:3});
  assert.deepEqual(compiled.generatedLines(path.join('outside','Exact.kt'),0),[]);
});

test('Kotlin/JS source maps refuse changed bytes, duplicate originals, malformed VLQ and external links',()=>{
  const {map,...data}=fixture();
  const changed={...map,sourcesContent:['val result = 2\n']};
  assert.throws(()=>bindKotlinJsMap({...data,map:changed}),/exact saved Kotlin source/);
  const duplicate={...map,sources:[...map.sources,...map.sources],sourcesContent:[...map.sourcesContent,...map.sourcesContent]};
  assert.throws(()=>bindKotlinJsMap({...data,map:duplicate}),/unambiguous/);
  assert.throws(()=>bindKotlinJsMap({...data,map:{...map,mappings:'AAAA,g'}}),/invalid source map/);
  assert.throws(()=>linkedKotlinMap(data.script.replace('app.js.map','https://example.invalid/app.js.map'),data.entry),
    /invalid source map/);
});
