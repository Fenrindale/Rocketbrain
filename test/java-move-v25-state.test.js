'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { inspectInstanceMove, inspectStatefulResult } = require('../src/java/move-instance');
const { analyzeJavaSources } = require('../src/java/signature-compiler');

const fixturePath = path.join(__dirname, 'fixtures/refactoring-v25-state/src/main/java/fixture/statev25');
function fixture(receiver = 'field') {
  const field = receiver === 'field';
  const sourceName = field ? 'FieldSource' : 'ParameterSource';
  const targetName = field ? 'FieldTarget' : 'ParameterTarget';
  const selected = field ? 'routeReferences' : 'measureReferences';
  const source = fs.readFileSync(path.join(fixturePath, sourceName + '.java'), 'utf8');
  const target = fs.readFileSync(path.join(fixturePath, targetName + '.java'), 'utf8');
  const sourceUri = 'file:///' + sourceName + '.java';
  const targetUri = 'file:///' + targetName + '.java';
  const inspect = (a = source, b = target) =>
    inspectInstanceMove(a, sourceUri, b, targetUri, a.indexOf(selected), field ? 'primary' : 'target');
  const model = inspect();
  const method = source.slice(model.selected.all[0].start, model.selected.all.at(-1).end);
  const sourceWithoutMethod = source.replace(method, '');
  const sourceAfter = field ? sourceWithoutMethod.replaceAll('return ' + selected, 'return primary.' + selected) :
    sourceWithoutMethod.replace('return ' + selected + '(new ParameterTarget(2), ', 'return new ParameterTarget(2).' + selected + '(');
  const targetAfter = target.replace(/}\s*$/, method
    .replace('ParameterTarget target, ', '')
    .replace(field ? 'primary.advance' : 'target.advance', 'this.advance') + '\n}\n');
  return { source, target, sourceAfter, targetAfter, inspect, model, sourceName, targetName };
}

test('Move retains field-owned shared aliases and distinct allocations with their original capture order', () => {
  const f = fixture();
  const proof = inspectStatefulResult(f.model, f.sourceAfter, f.targetAfter);
  assert.equal(proof.sharedReferenceIdentityPreserved, true);
  assert.equal(proof.ownerReferenceFieldsPreserved, true);
  assert.equal(proof.referenceCaptureOrderPreserved, true);
  assert.equal(proof.receiverReference.root, 'primary');
  assert.deepEqual(proof.referenceFields.map(({ field, root, phase, from }) => [field, root, phase, from]), [
    ['primary', 'primary', 'initializer', undefined], ['mirror', 'primary', 'initializer', 'primary'],
    ['other', 'other', 'constructor', undefined], ['forward', 'primary', 'constructor', 'mirror']
  ]);
  assert.deepEqual(proof.referenceArgumentCaptures.map(({ caller, field, root, parameter }) => [caller, field, root, parameter]), [
    ['runShared', 'mirror', 'primary', 0], ['runShared', 'forward', 'primary', 1],
    ['runDistinct', 'mirror', 'primary', 0], ['runDistinct', 'other', 'other', 1]
  ]);
  assert.equal(proof.constructorDelegationCount, 1);
  assert.equal(proof.ownerOnlyLiteralCallsPreserved, false);
});

test('Fresh parameter receiver stays distinct from constructor-assigned objects with the same captured root', () => {
  const f = fixture('parameter');
  const proof = inspectStatefulResult(f.model, f.sourceAfter, f.targetAfter);
  assert.deepEqual(proof.receiverReference, { kind: 'fresh-caller-allocation' });
  assert.deepEqual(proof.referenceArgumentCaptures.map(({ field, root }) => [field, root]), [
    ['stored', 'stored'], ['storedAlias', 'stored']
  ]);
});

test('A proven alias can itself be the selected receiver without changing its allocation root', () => {
  const f = fixture();
  const source = f.source.replace('primary.advance', 'mirror.advance');
  const model = inspectInstanceMove(source, 'file:///FieldSource.java', f.target, 'file:///FieldTarget.java',
    source.indexOf('routeReferences'), 'mirror');
  const proof = inspectStatefulResult(model, f.sourceAfter.replaceAll('primary.routeReferences', 'mirror.routeReferences'), f.targetAfter);
  assert.deepEqual(proof.receiverReference, { field: 'mirror', root: 'primary', kind: 'alias', phase: 'initializer', from: 'primary' });
});

test('Qualifier normalization cannot change object aliases or field identity', () => {
  const f = fixture();
  assert.equal(inspectStatefulResult(f.model, f.sourceAfter.replaceAll('this.mirror, this.forward', 'mirror, forward'), f.targetAfter)
    .sharedReferenceIdentityPreserved, true);
  const edits = [
    f.sourceAfter.replace('this.mirror, this.forward', 'this.forward, this.mirror'),
    f.sourceAfter.replace('this.mirror, this.forward', 'this.mirror, this.other'),
    f.sourceAfter.replace('this.forward = this.mirror', 'this.forward = this.other'),
    f.sourceAfter.replace('mirror = primary', 'mirror = new FieldTarget(2)'),
    f.sourceAfter.replace('return primary.routeReferences', 'return mirror.routeReferences')
  ];
  for (const after of edits) assert.throws(() => inspectStatefulResult(f.model, after, f.targetAfter), /argument|ownership|constructor|binding/i);
});

test('Move refuses reordered reference fields and changed identity or mutation order in the engine result', () => {
  const f = fixture();
  const swapped = f.sourceAfter.replace('private final FieldTarget other;\n    private final FieldTarget forward;',
    'private final FieldTarget forward;\n    private final FieldTarget other;');
  assert.throws(() => inspectStatefulResult(f.model, swapped, f.targetAfter), /order/);
  for (const after of [f.targetAfter.replace('left == right', 'left != right'),
    f.targetAfter.replace('left.advance(1) * 10 + right.advance(2)', 'right.advance(2) * 10 + left.advance(1)')]) {
    assert.throws(() => inspectStatefulResult(f.model, f.sourceAfter, after), /return expression/);
  }
});

test('Nullable, forward, cyclic, mutable and externally bound object fields are refused', () => {
  const f = fixture();
  const invalid = [
    f.source.replace('mirror = primary', 'mirror = null'),
    f.source.replace('mirror = primary', 'mirror = this.other'),
    f.source.replace('mirror = primary', 'mirror = this.mirror'),
    f.source.replace('private final FieldTarget mirror', 'private FieldTarget mirror'),
    f.source.replace('this.other = new FieldTarget(10)', 'this.other = this.forward'),
    f.source.replace('this.forward = this.mirror', 'this.forward = mirror'),
    f.source.replace('int bias) {\n        this.other', 'FieldTarget bias) {\n        this.other'),
    f.source.replace('this.forward = this.mirror', 'this.forward = uncertain()'),
    f.source.replace('this.forward = this.mirror', 'this.forward = null')
  ];
  for (const source of invalid) assert.throws(() => f.inspect(source), /field|reference|constructors/i);
});

test('Caller object injection, fresh substitutions and reference escapes are refused', () => {
  const f = fixture();
  const invalid = [
    f.source.replace('this.mirror, this.forward', 'null, this.forward'),
    f.source.replace('this.mirror, this.forward', 'new FieldTarget(2), this.forward'),
    f.source.replace('runShared(int delta)', 'runShared(FieldTarget left, int delta)').replace('this.mirror, this.forward', 'left, this.forward'),
    f.source.replace('left.advance(1)', 'left.unreviewed(1)'),
    f.source.replace('left.advance(1)', 'left.advance(right)'),
    f.source.replace('left == right', 'left == null'),
    f.source.replace(/}\s*$/, 'public FieldTarget leak() { return mirror; }\n}')
  ];
  for (const source of invalid) assert.throws(() => f.inspect(source), /object arguments|caller|accessor|primitive/i);
});

test('Javac accepts an incorrect owner alias or capture order but the Move proof rejects both', {
  skip: !process.env.ROCKETBRAIN_JAVA_MOVE_V25_COMPILER_TEST, timeout: 120000
}, async () => {
  const java = JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_JAVA_TEST_CONFIG || 'test-output/v0.4-java-host-runtime.json'));
  const folder = path.resolve('test-output/v0.25-reference-compiler-' + randomUUID());
  const f = fixture();
  const edited = [f.sourceAfter.replace('this.forward = this.mirror', 'this.forward = this.other'),
    f.sourceAfter.replace('this.mirror, this.forward', 'this.forward, this.mirror')];
  for (const [name, a, b] of [['before', f.source, f.target], ['after', f.sourceAfter, f.targetAfter],
    ['wrong-alias', edited[0], f.targetAfter], ['wrong-capture', edited[1], f.targetAfter]]) {
    const sources = [[f.sourceName, a], [f.targetName, b]].map(([file, text]) =>
      ({ uri: pathToFileURL(path.join(folder, file + '.java')).href, text }));
    const report = await analyzeJavaSources({ javaHome: java.javaHome, classpath: [], sources, storagePath: path.join(folder, name) });
    assert.deepEqual(report.errors, []);
    assert.equal(report.processorsEnabled, false);
    assert.equal(report.classGenerationEnabled, false);
    report.validateClasspath();
  }
  for (const after of edited) assert.throws(() => inspectStatefulResult(f.model, after, f.targetAfter), /constructor|binding/);
});
