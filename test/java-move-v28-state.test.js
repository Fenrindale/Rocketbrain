'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { inspectInstanceMove, inspectStatefulResult } = require('../src/java/move-instance');

const fixture = path.join(__dirname, 'fixtures/refactoring-v28-state/src/main/java/fixture/statev28');
const ownerUri = 'file:///BranchOwner.java';
const targetUri = 'file:///RefTarget.java';
const owner = fs.readFileSync(path.join(fixture, 'BranchOwner.java'), 'utf8');
const target = fs.readFileSync(path.join(fixture, 'RefTarget.java'), 'utf8');

function inspect(source = owner) {
  return inspectInstanceMove(source, ownerUri, target, targetUri, source.indexOf('measure('), 'receiver');
}

function transformed(model) {
  const method = owner.slice(model.selected.all[0].start, model.selected.all.at(-1).end);
  return [
    owner.replace(method, '').replaceAll('return measure(', 'return receiver.measure('),
    target.replace(/}\s*$/, method.replaceAll('receiver.advance(', 'this.advance(') + '\n}\n')
  ];
}

test('Instance Move keeps both private writers and each boolean path in original call order', () => {
  const model = inspect();
  const proof = inspectStatefulResult(model, ...transformed(model)).referenceFlow;
  assert.equal(proof.branchGuardsPreserved, true);
  assert.deepEqual(proof.rebindings.map(({caller, field, origin, when}) => [caller,field,origin.kind,when]), [
    ['choose','active','external-caller-parameter',{parameter:'useIncoming',value:true}],
    ['choose','active','owner-reference-read',{parameter:'useIncoming',value:false}],
    ['reset','active','null',{parameter:'keep',value:false}]
  ]);
  assert.equal(proof.callTimeCaptures.filter(capture => capture.field === 'active').length, 3);
  assert.equal(proof.infersDynamicAliasOrNullability, false);
});

test('Instance Move refuses a compiler-valid branch guard or write change after engine transformation', () => {
  const model = inspect();
  const [after, destination] = transformed(model);
  for (const changed of [
    after.replace('if (useIncoming)', 'if (!useIncoming)'),
    after.replace('this.active = this.fallback;', 'this.active = incoming;'),
    after.replace('if (!keep)', 'if (keep)')
  ]) assert.throws(() => inspectStatefulResult(model, changed, destination), /assignment or its order/);
});

test('Instance Move requires bounded braced writes with a boolean parameter guard', () => {
  for (const changed of [
    owner.replace('if (useIncoming)', 'if (useIncoming && incoming != null)'),
    owner.replace('if (useIncoming)', 'if (incoming != null)'),
    owner.replace('if (!keep) {\n            this.active = null;\n        }', 'if (!keep) this.active = null;'),
    owner.replace('this.active = null;', 'if (keep) { this.active = null; }'),
    owner.replace('this.active = incoming;', 'this.active = incoming; '.repeat(5))
  ]) assert.throws(() => inspect(changed), /branch|at most four/i);
});
