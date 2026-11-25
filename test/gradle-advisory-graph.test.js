'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {parseGradleAdvisoryGraph}=require('../src/java/gradle-advisory-graph');

const configuration='runtimeClasspath';
const graph={format:'RocketbrainGradleAdvisoryGraph-v1',project:{name:'app',version:'1.0'},configuration,unresolved:1,
  nodes:[{kind:'project',label:'project :app',children:[1,2]},
    {kind:'project',label:'project :lib',children:[3]},
    {kind:'module',group:'fixture.demo',artifact:'external',version:'2.0',children:[3]},
    {kind:'module',group:'fixture.demo',artifact:'shared',version:'3.0',children:[1]}]};

test('Gradle dependencies retain direct and transitive selected paths through project and external nodes',()=>{
  const result=parseGradleAdvisoryGraph(JSON.stringify(graph),configuration);
  assert.equal(result.unresolved,1);
  assert.deepEqual(result.packages.map(({name,version,direct,paths})=>({name,version,direct,paths})),[
    {name:'fixture.demo:external',version:'2.0',direct:true,paths:[['project :app','fixture.demo:external@2.0']]},
    {name:'fixture.demo:shared',version:'3.0',direct:false,paths:[['project :app','project :lib','fixture.demo:shared@3.0'],
      ['project :app','fixture.demo:external@2.0','fixture.demo:shared@3.0']]}
  ]);
});

test('truncated or foreign Gradle reports cannot contribute packages to an advisory lookup',()=>{
  const invalid=structuredClone(graph);
  invalid.nodes[2].children=[4];
  assert.throws(()=>parseGradleAdvisoryGraph(JSON.stringify(invalid),configuration),/dependency edges/);
  invalid.nodes[2].children=[];
  invalid.nodes[2].group='file:///private/path';
  assert.throws(()=>parseGradleAdvisoryGraph(JSON.stringify(invalid),configuration),/external package coordinate/);
  assert.throws(()=>parseGradleAdvisoryGraph(JSON.stringify(graph),'compileClasspath'),/configuration/);
});
