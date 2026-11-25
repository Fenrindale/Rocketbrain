'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { analyzeJavaSources } = require('../src/java/signature-compiler');
const { classDiagram,visibleClassLayout,mermaidDiagram,dataFlow } = require('../src/java/source-analysis-model');
const { diagramHtml } = require('../src/java/source-diagram-view');

const dependencySources = [{uri:'file:///source/Sample.java',text:'class Sample {}'}];
const anchor = { uri:dependencySources[0].uri,start:0,end:15 };
const node = (name,kind,relations = [],members = []) => ({
  id:'demo.' + name,name,kind,relations,members,location:anchor
});

test('class graph keeps local owner/member links and compiler-proven relation kinds, lays out and exports selected links',() => {
  const method = {name:'probe',kind:'method',signature:'probe() : java.util.List<demo.Base>',modifiers:['public'],location:anchor};
  const report = classDiagram({declarations:[
    node('Contract','INTERFACE'),
    node('Base','CLASS'),
    node('Leaf','CLASS',[{kind:'extends',target:'demo.Base',signature:'demo.Base'},
      {kind:'implements',target:'demo.Contract',signature:'demo.Contract'},
      {kind:'implements',target:'other.External',signature:'other.External'}],[method]),
    node('Unrelated','RECORD')
  ]},dependencySources);
  assert.deepEqual([report.localCount,report.externalCount],[4,1]);
  assert.equal(report.nodes.find(x => x.id === 'demo.Leaf').members[0].location.uri,anchor.uri);
  const view = visibleClassLayout(report,{focus:'demo.Leaf',external:false});
  assert.deepEqual(view.nodes.map(item => item.id),['demo.Base','demo.Contract','demo.Leaf']);
  assert.ok(view.nodes[2].y > view.nodes[0].y);
  assert.deepEqual(view.edges.map(item => item.kind),['extends','implements']);
  const output = mermaidDiagram(report,{external:false});
  assert.match(output,/classDiagram\n/);
  assert.match(output,/class Type\d+\["demo\.Leaf"\]/);
  assert.match(output,/Type\d+ --\|> Type\d+/);
  assert.match(output,/Type\d+ \.\.\|> Type\d+/);
  assert.doesNotMatch(output,/other\.External/);
});

test('diagram webview encodes workspace data and uses a dedicated nonce with no external resource route',() => {
  const report = classDiagram({declarations:[
    node('Leaf','CLASS',[],[{name:'field',kind:'field',signature:'</script><img src=a>',location:anchor}])
  ]},dependencySources);
  const html = diagramHtml(report);
  assert.match(html,/default-src 'none'; style-src 'nonce-/);
  assert.match(html,/class="node-name"|node-name/);
  assert.match(html,/\\u003c\/script\\u003e/);
  assert.doesNotMatch(html,/<\/script><img src=a>/);
  assert.match(html,/Export Mermaid/);
  assert.match(html,/id="focus"/);
});

test('source flow computes separate upstream/downstream slices and refuses cross-snapshot event locations',() => {
  const source = {uri:'file:///a.java',text:'start middle end'};
  const raw = {dataFlow:{uri:source.uri,events:[
    {id:0,kind:'parameter',name:'start',start:0,end:5,inputs:[]},
    {id:1,kind:'definition',name:'middle',start:6,end:12,inputs:[0]},
    {id:2,kind:'read',name:'end',start:13,end:16,inputs:[1]}
  ]}};
  const result = dataFlow(raw,source,8);
  assert.equal(result.origin.name,'middle');
  assert.deepEqual(result.inputs.map(event => event.name),['start']);
  assert.deepEqual(result.uses.map(event => event.name),['end']);
  assert.throws(() => dataFlow(raw,{...source,uri:'file:///b.java'},8),/Invalid Java flow/);
});

test('independent Javac attributes declarations, preserves exact binding and rejects unsupported control flow',
  {skip:!process.env.ROCKETBRAIN_JAVA_TEST_CONFIG && 'Independent Java test runtime is not configured.',timeout:30000},async () => {
    const runtime = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_JAVA_TEST_CONFIG,'utf8'));
    const storagePath = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'rb-structure-proof-'));
    const text = [
      'package sample;',
      'interface Value<T> { T value(); }',
      'class Base { public int raw; }',
      'class Sample extends Base implements Value<String> {',
      '    public String value() { return "test"; }',
      '    record Inner(int number) {}',
      '    int straight(int seed) {',
      '        int /* first */ first = seed + 4;',
      '        var second = first * 2;',
      '        first = second - 1;',
      '        return first;',
      '    }',
      '    int branch(int seed) { if (seed < 0) return 0; return seed; }',
      '}'
    ].join('\n');
    const uri = pathToFileURL(path.join(storagePath,'Sample.java')).href;
    const source = {uri,text},sources = [source];
    const query = inspection => analyzeJavaSources({javaHome:runtime.javaHome,storagePath,sources,inspection});
    try {
      const report = await query({kind:'diagram'});
      assert.deepEqual(report.errors,[]);
      assert.equal(report.processorsEnabled,false);
      assert.equal(report.classGenerationEnabled,false);
      const diagram = classDiagram(report,sources);
      assert.deepEqual(diagram.edges.filter(edge => edge.from === 'sample.Sample' && !edge.origins).map(edge => [edge.kind,edge.to]),
        [['extends','sample.Base'],['implements','sample.Value']]);
      assert.ok(diagram.edges.some(edge=>edge.from==='sample.Sample'&&edge.to==='java.lang.String'&&
        edge.kind==='uses'&&edge.origins.some(item=>item.role==='return')));
      assert.ok(diagram.edges.some(edge => edge.from === 'sample.Sample.Inner' && edge.kind === 'nestedIn'));
      assert.ok(diagram.nodes.find(node => node.id === 'sample.Sample').members.some(member => member.name === 'straight'));
      const cursor = text.indexOf('var second') + 4;
      const traced = dataFlow(await query({kind:'dataflow',uri,offset:cursor}),source,cursor);
      assert.equal(traced.origin.name,'second');
      assert.ok(traced.inputs.some(event => event.kind === 'parameter' && event.name === 'seed'));
      assert.equal(traced.inputs.find(event => event.kind === 'definition' && event.name === 'first').start,text.indexOf('first = seed'));
      assert.ok(traced.uses.some(event => event.kind === 'assignment' && event.name === 'first'));
      assert.ok(traced.uses.some(event => event.kind === 'return'));
      const unsupported = await query({kind:'dataflow',uri,offset:text.lastIndexOf('return seed')});
      assert.throws(() => dataFlow(unsupported,source,text.lastIndexOf('return seed')),/straight-line/);
      assert.deepEqual(await fs.readdir(storagePath),[]);
    } finally { await fs.rmdir(storagePath); }
  });
