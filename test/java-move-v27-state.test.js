'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { inspectInstanceMove, inspectStatefulResult } = require('../src/java/move-instance');

const fixturePath = path.join(__dirname, 'fixtures/refactoring-v27-state/src/main/java/fixture/statev27');
const read = name => fs.readFileSync(path.join(fixturePath, name + '.java'), 'utf8');
const uri = name => 'file:///' + name + '.java';

function fixture(kind) {
  const field = kind === 'field';
  const name = field ? 'MutableOwner' : 'IncomingOwner';
  const method = field ? 'measureOwned' : 'measureBorrowed';
  const receiver = field ? 'primary' : 'target';
  const source = read(name), target = read('RefTarget');
  const inspect = (text = source, selection = receiver) =>
    inspectInstanceMove(text, uri(name), target, uri('RefTarget'), text.indexOf(method), selection);
  const model = inspect();
  const declaration = source.slice(model.selected.all[0].start, model.selected.all.at(-1).end);
  const cut = source.replace(declaration, '');
  const sourceAfter = field ? cut.replaceAll('return measureOwned(', 'return primary.measureOwned(')
    : cut.replaceAll('return measureBorrowed(new RefTarget(3), ', 'return new RefTarget(3).measureBorrowed(');
  const targetAfter = target.replace(/}\s*$/, declaration.replace('RefTarget target, ', '')
    .replaceAll(receiver + '.advance', 'this.advance') + '\n}\n');
  return { source, model, inspect, sourceAfter, targetAfter };
}

test('Owner reference rebinds retain the live field read and its original identity provenance', () => {
  const f = fixture('field');
  const proof = inspectStatefulResult(f.model, f.sourceAfter, f.targetAfter);
  const flow = proof.referenceFlow;
  assert.deepEqual(flow.mutableFields, ['active']);
  assert.equal(flow.captureOrderPreserved, true);
  assert.equal(flow.assignmentsPreserved, true);
  assert.equal(flow.infersDynamicAliasOrNullability, false);
  assert.deepEqual(flow.rebindings.map(({ caller, field, origin }) => [caller, field, origin.kind]), [
    ['runIncoming', 'active', 'external-caller-parameter'],
    ['runOwned', 'active', 'owner-reference-read'],
    ['runNew', 'active', 'owner-reference-read'],
    ['runNew', 'active', 'reviewed-allocation'],
    ['runClear', 'active', 'null']
  ]);
  const callTime = flow.callTimeCaptures.find(capture => capture.caller === 'runCurrent');
  assert.deepEqual(callTime, { caller: 'runCurrent', field: 'active', parameter: 0, type: 'RefTarget', kind: 'mutable-owner-read' });
});

test('Nullable or aliased external arguments bind directly while the invocation receiver is independently non-null', () => {
  const f = fixture('parameter');
  const proof = inspectStatefulResult(f.model, f.sourceAfter, f.targetAfter);
  assert.deepEqual(proof.receiverReference, { kind: 'fresh-caller-allocation' });
  assert.equal(proof.referenceFlow.receiverIndependentOfMutableAndExternalReferences, true);
  assert.deepEqual(proof.referenceFlow.callTimeCaptures.map(({ caller, name, parameter }) => [caller, name, parameter]), [
    ['runBorrowed', 'incoming', 0], ['runBorrowed', 'other', 1], ['runAliased', 'incoming', 0], ['runAliased', 'incoming', 1]
  ]);
  assert.ok(proof.referenceFlow.callTimeCaptures.every(capture => !Object.hasOwn(capture, 'root')));
});

test('Compilable rebind changes, reordered assignments and replaced argument reads are rejected', () => {
  const f = fixture('field');
  for (const after of [
    f.sourceAfter.replace('this.active = incoming;', 'this.active = this.backup;'),
    f.sourceAfter.replace('this.active = this.backup;\n        this.active = new RefTarget(7);',
      'this.active = new RefTarget(7);\n        this.active = this.backup;'),
    f.sourceAfter.replace('this.active = incoming;', ''),
    f.sourceAfter.replace('primary.measureOwned(this.active, incoming, delta)', 'primary.measureOwned(incoming, this.active, delta)')
  ]) assert.throws(() => inspectStatefulResult(f.model, after, f.targetAfter), /assignment|capture/i);
  assert.throws(() => inspectStatefulResult(f.model, f.sourceAfter,
    f.targetAfter.replace('right == null', 'left == null')), /return expression/i);
});

test('Unmodeled writes, external receivers, changing receiver identity, and source escapes are refused', () => {
  const f = fixture('field'), p = fixture('parameter');
  for (const source of [
    f.source.replace('this.active = incoming;', 'this.active = incoming == null ? this.backup : incoming;'),
    f.source.replace('this.active = incoming;', 'this.primary = incoming;'),
    f.source.replace('this.active = incoming;', 'log(incoming); this.active = incoming;'),
    f.source.replace('this.active = incoming;', 'this.active = incoming; after(incoming);'),
    f.source.replace('this.active = incoming;', 'this.active = incoming; '.repeat(5)),
    f.source.replace('private RefTarget active;', 'private volatile RefTarget active;'),
    f.source.replace(/}\s*$/, 'public RefTarget leak() { return active; }\n}')
  ]) assert.throws(() => f.inspect(source), /mutable destination|mutable reference assignments|private fields|plain final classes|primitive\/String/i);
  assert.throws(() => f.inspect(f.source, 'active'), /private final target field/i);
  assert.throws(() => p.inspect(p.source.replace('new RefTarget(3), incoming, other', 'incoming, incoming, other')),
    /new non-null target/i);
});
