'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeResult, numericColumns } = require('../src/db/result-analysis');
const { ResultsView } = require('../src/results');

const result = {
  columns: ['group', 'value'],
  fields: [{ type: 253 }, { type: 246 }],
  rows: [
    ['alpha', '12345678901234567890.000000000000001'],
    ['alpha', '-12345678901234567889.999999999999998'],
    ['alpha', '0.000000000000001'],
    ['alpha', null],
    [null, null],
    ['', '-10.5'],
    ['NULL', '5']
  ],
  browse: { page: 3, pageSize: 25, hasPrevious: true, hasNext: false },
  state: { inTransaction: true }
};

test('captured result grouping retains precision, distinguishes SQL NULL and empty category and protects pagination context', () => {
  assert.deepEqual(numericColumns(result), [1]);
  const grouped = operation => analyzeResult(result, { operation, category: 0, measure: 1 });
  const summed = grouped('sum');
  assert.deepEqual(summed.groups.map(({ category, rows, nonNull, value }) => [category, rows, nonNull, value]), [
    ['alpha', 4, 3, '0.000000000000004'], [null, 1, 0, null], ['', 1, 1, '-10.5'], ['NULL', 1, 1, '5']
  ]);
  assert.deepEqual(summed.axis, { minimum: '-10.5', maximum: '5', zero: 0.677419 });
  assert.deepEqual(summed.groups.map(group => group.position), [0.677419, null, 0, 1]);
  assert.equal(summed.page, 4);
  assert.equal(summed.hasPrevious, true);
  assert.equal(summed.uncommitted, true);
  assert.equal(grouped('average').groups[0].value, '1/750000000000000');
  assert.equal(grouped('min').groups[0].value, '-12345678901234567889.999999999999998');
  assert.equal(grouped('max').groups[0].value, '12345678901234567890.000000000000001');
  assert.equal(grouped('nonnull').groups[0].value, '3');
  assert.equal(grouped('count').groups[0].value, '4');
  assert.deepEqual(analyzeResult(result, { operation: 'values', measure: 1 }).groups.map(group => group.category), [76, 77, 78, 79, 80, 81, 82]);
});

test('empty and extreme numeric snapshots remain exact, and categorization never coerces textual numerics', () => {
  const captured = { columns: ['category', 'amount'], rows: [['12', 1e308], [12, -1e308], [-0, 1e-323], [0, 0]] };
  const chart = analyzeResult(captured, { operation: 'sum', category: 0, measure: 1 });
  assert.deepEqual(chart.groups.map(group => group.position), [1, 0, 0.5, 0.5]);
  assert.ok(chart.groups[2].negativeZero);
  assert.equal(chart.groups[0].value, '1' + '0'.repeat(308));
  assert.equal(chart.groups[2].value, '0.' + '0'.repeat(322) + '1');
  assert.equal(analyzeResult({ ...captured, rows: [] }).groups[0].value, '0');
  assert.throws(() => analyzeResult(captured, { operation: 'sum', measure: 0 }), /supported aggregation/);
});

test('the native result analysis entry point handles only current captured rows and excludes unresolved drafts', () => {
  const view = new ResultsView({ workspace: {} }, {});
  const id = view.begin('SELECT * FROM sample', 'fixture');
  view.finish(id, result);
  const revision = view.history[0].chart.revision;
  assert.equal(view.analyzeSnapshot(id, { operation: 'count' }).groups[0].value, '7');
  view.editState(id, { hasDraft: true });
  assert.throws(() => view.analyzeSnapshot(id), /discard drafts/);
  view.editState(id, { hasDraft: false });
  view.finish(id, { ...result, rows: result.rows.slice(0, 1) });
  assert.throws(() => view.analyzeSnapshot(id, {}, revision), /current captured result/);
  assert.equal(view.analyzeSnapshot(id, { operation: 'count' }).groups[0].value, '1');
});
