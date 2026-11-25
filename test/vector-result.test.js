'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { vectorType, vectorResultText } = require('../src/db/vector-result');

function payload(values) {
  const buffer = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => buffer.writeFloatLE(value, index * 4));
  return buffer;
}

test('native VECTOR is identified by its protocol type and SQL NULL remains distinct', () => {
  assert.equal(vectorType, 242);
  assert.equal(vectorResultText(null), null);
  assert.deepEqual(JSON.parse(vectorResultText(payload([0, 0, 0]))), [0, 0, 0]);
});

test('native VECTOR entries keep order, float32 values and sign of zero', () => {
  const expected = [Math.fround(0.1), 1.5, -2.25, -0, Math.fround(1.401298464324817e-45)];
  assert.deepEqual(JSON.parse(vectorResultText(payload(expected))), expected);
});

test('native VECTOR dimensions and byte shape have a finite bound', () => {
  const maximum = Buffer.alloc(4 * 16383);
  assert.equal(JSON.parse(vectorResultText(maximum)).length, 16383);
  for (const invalid of [Buffer.alloc(4 * 16384), Buffer.alloc(0), Buffer.alloc(5), [1, 2], undefined]) {
    assert.throws(() => vectorResultText(invalid), /invalid native VECTOR payload/u);
  }
});

test('invalid non-finite components cannot turn into JSON NULLs', () => {
  for (const invalid of [NaN, Infinity, -Infinity]) {
    assert.throws(() => vectorResultText(payload([1, invalid])), /non-finite VECTOR/u);
  }
});
