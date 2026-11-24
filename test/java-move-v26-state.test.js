'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { inspectInstanceMove, inspectStatefulResult } = require('../src/java/move-instance');
const { analyzeJavaSources } = require('../src/java/signature-compiler');

const fixturePath = path.join(__dirname, 'fixtures/refactoring-v26-state/src/main/java/fixture/statev26');
const read = name => fs.readFileSync(path.join(fixturePath, name + '.java'), 'utf8');
const uri = name => 'file:///' + name + '.java';

function fixture(receiver = 'field') {
  const field = receiver === 'field';
  const name = field ? 'FieldGraphSource' : 'ParameterGraphSource';
  const method = field ? 'routeGraph' : 'measureGraph';
  const source = read(name), target = read('GraphTarget');
  const graphs = ['GraphLeaf', 'GraphBranch', 'GraphCrown', 'GraphGrove'].map(name => ({ uri: uri(name), text: read(name) }));
  const inspect = (text = source, graphSources = graphs) =>
    inspectInstanceMove(text, uri(name), target, uri('GraphTarget'), text.indexOf(method), field ? 'primary' : 'target', { graphSources });
  const model = inspect();
  const declaration = source.slice(model.selected.all[0].start, model.selected.all.at(-1).end);
  const cut = source.replace(declaration, '');
  const sourceAfter = field ? cut.replaceAll('return routeGraph', 'return primary.routeGraph')
    : cut.replace('return measureGraph(new GraphTarget(2), ', 'return new GraphTarget(2).measureGraph(');
  const targetAfter = target.replace(/}\s*$/, declaration.replace('GraphTarget target, ', '')
    .replace(field ? 'primary.advance' : 'target.advance', 'this.advance') + '\n}\n');
  return { name, source, target, graphs, inspect, model, sourceAfter, targetAfter };
}

test('Move traces four reviewed carrier layers, constructor fanout and shared terminal allocations', () => {
  const f = fixture();
  const proof = inspectStatefulResult(f.model, f.sourceAfter, f.targetAfter);
  assert.equal(proof.nestedReferencePathsPreserved, true);
  assert.equal(proof.ownerReferenceFieldsPreserved, true);
  assert.equal(proof.stateUpdateOrderPreserved, true);
  assert.equal(proof.referenceGraph.maximumCarrierDepth, 4);
  assert.equal(proof.referenceGraph.ownerAllocationCount, 8);
  assert.deepEqual(proof.referenceGraph.carrierTypes.find(item => item.type.endsWith('.GraphCrown')).constructorFields,
    { branch: 'branch', mirrored: 'branch' });
  assert.deepEqual(proof.referenceArgumentCaptures.map(({caller,field,root,path}) => [caller,field,root,path]), [
    ['runShared','grove','primary',['crown','branch','left','head']],
    ['runShared','grove','primary',['crown','echo','right','head']],
    ['runDistinct','rightAlias','primary',undefined],
    ['runDistinct','pair','pair[1]',['tail']]
  ]);
  assert.deepEqual(proof.referenceFields.find(item => item.field === 'rightAlias'), {
    field: 'rightAlias', root: 'primary', kind: 'alias', phase: 'constructor', from: 'grove',
    path: ['crown','echo','right','head']
  });
});

test('Fresh parameter receiver stays distinct from shared leaf allocations inside constructor-created carriers', () => {
  const f = fixture('parameter');
  const proof = inspectStatefulResult(f.model, f.sourceAfter, f.targetAfter);
  assert.deepEqual(proof.receiverReference, { kind: 'fresh-caller-allocation' });
  assert.equal(proof.referenceGraph.maximumCarrierDepth, 2);
  assert.deepEqual(proof.referenceArgumentCaptures.map(({field,root,path}) => [field,root,path]), [
    ['root','root[0][0]',['left','head']], ['alias','root[0][0]',['left','head']]
  ]);
});

test('Move rejects changed compiled paths, allocations, aliases and update order', () => {
  const f = fixture();
  assert.equal(inspectStatefulResult(f.model, f.sourceAfter.replace('return primary.routeGraph(this.grove.crown()', 'return primary.routeGraph(grove.crown()'), f.targetAfter)
    .nestedReferencePathsPreserved, true);
  for (const source of [
    f.sourceAfter.replace('branch().left().head()', 'branch().left().tail()'),
    f.sourceAfter.replace('branch().left().head()', 'echo().left().head()'),
    f.sourceAfter.replace('new GraphLeaf(primary, new GraphTarget(10))', 'new GraphLeaf(new GraphTarget(2), new GraphTarget(10))'),
    f.sourceAfter.replace('this.rightAlias = this.grove.crown().echo().right().head()', 'this.rightAlias = this.pair.tail()')
  ]) assert.throws(() => inspectStatefulResult(f.model, source, f.targetAfter), /binding|constructor|ownership/);
  assert.throws(() => inspectStatefulResult(f.model, f.sourceAfter,
    f.targetAfter.replace('left.advance(1) * 10 + right.advance(2)', 'right.advance(2) * 10 + left.advance(1)')), /return expression/);
});

test('Instance Move refuses inaccessible or unresolved carrier paths, nullable nodes, foreign types and shadowed owners', () => {
  const f = fixture();
  for (const source of [
    f.source.replace('new GraphLeaf(primary, new GraphTarget(10))', 'new GraphLeaf(primary, null)'),
    f.source.replace('new GraphGrove(new GraphCrown(branch))', 'new GraphGrove(grove.crown())'),
    f.source.replace('this.grove.crown().branch().left().head()', 'this.grove.crown().branch().left(1).head()'),
    f.source.replace('this.grove.crown().branch().left().head()', 'this.grove.crown().branch().left()'),
    f.source.replace('runShared(int delta)', 'runShared(int grove)').replace('this.grove.crown()', 'grove.crown()')
      .replace('right().head(), delta, this.bias)', 'right().head(), grove, this.bias)')
  ]) assert.throws(() => f.inspect(source), /fields|reference|alias path/);
  assert.throws(() => f.inspect(f.source, f.graphs.filter(item => item.uri !== uri('GraphLeaf'))), /same-package source declarations/);
  assert.throws(() => f.inspect(f.source, [...f.graphs, { ...f.graphs[0], uri: 'file:///duplicate/GraphLeaf.java' }]), /ambiguous/);
});

test('Opaque getters, mutable fields, constructor effects, and carrier cycles or excess depth are refused', () => {
  const f = fixture();
  const change = update => f.graphs.map(item => item.uri === uri('GraphLeaf') ? { ...item, text: update(item.text) } : item);
  assert.throws(() => f.inspect(f.source, change(text => text.replace('return this.primary;', 'return new GraphTarget(2);'))), /accessors/);
  assert.throws(() => f.inspect(f.source, change(text => text.replace('private final GraphTarget primary;', 'private GraphTarget primary;'))), /private final/);
  assert.throws(() => f.inspect(f.source, change(text => text.replace('this.primary = primary;', 'this.primary = decide(primary);'))), /assignments/);
  const cycle = change(text => text.replace('private final GraphTarget primary;', 'private final GraphTarget primary; private final GraphGrove cycle;')
    .replace('GraphTarget alternate)', 'GraphTarget alternate, GraphGrove cycle)')
    .replace('this.primary = primary;', 'this.primary = primary; this.cycle = cycle;'));
  assert.throws(() => f.inspect(f.source, cycle), /Cyclic reference carriers/);
  const canopy = { uri: uri('GraphCanopy'), text: 'package fixture.statev26; public final class GraphCanopy {'
    + 'private final GraphGrove leaf; public GraphCanopy(GraphGrove leaf) { this.leaf = leaf; }'
    + 'public GraphGrove leaf() { return leaf; }}' };
  assert.throws(() => f.inspect(f.source.replace('private final GraphTarget rightAlias;',
    'private final GraphCanopy canopy = new GraphCanopy(grove); private final GraphTarget rightAlias;'), [...f.graphs, canopy]), /nesting limit/);
});

test('Ordinary Javac accepts a changed deep alias path that the Instance Move proof refuses', {
  skip: !process.env.ROCKETBRAIN_JAVA_MOVE_V26_COMPILER_TEST, timeout: 120000
}, async () => {
  const java = JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_JAVA_TEST_CONFIG || 'test-output/v0.4-java-host-runtime.json'));
  const folder = path.resolve('test-output/v0.26-reference-compiler-' + randomUUID());
  const f = fixture();
  const edited = f.sourceAfter.replace('branch().left().head()', 'branch().left().tail()');
  for (const [name, source, target] of [['before',f.source,f.target], ['after',f.sourceAfter,f.targetAfter], ['wrong-path',edited,f.targetAfter]]) {
    const sources = [[f.name,source], ['GraphTarget',target], ...f.graphs.map(item => [path.basename(item.uri,'.java'),item.text])]
      .map(([file,text]) => ({uri:pathToFileURL(path.join(folder,file+'.java')).href,text}));
    const report = await analyzeJavaSources({ javaHome:java.javaHome, classpath:[], sources, storagePath:path.join(folder,name) });
    assert.deepEqual(report.errors, []);
    assert.equal(report.processorsEnabled, false);
    assert.equal(report.classGenerationEnabled, false);
    report.validateClasspath();
  }
  assert.throws(() => inspectStatefulResult(f.model, edited, f.targetAfter), /binding/);
});
