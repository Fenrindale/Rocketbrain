'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createResultFilters } = require('../src/db/result-filters');
const { ResultsView } = require('../src/results');

test('named filters persist typed groups in the matching workspace table and refuse stale columns', async () => {
  const items = new Map();
  const memento = { get: key => items.get(key), async update(key, values) { items.set(key, structuredClone(values)); } };
  const columns = [
    { name: 'id', kind: 'integer', type: 'bigint unsigned', primaryKey: true },
    { name: 'note', kind: 'text', type: 'varchar(80)', nullable: true }
  ];
  const filters = [{ logic: 'or', filters: [
    { column: 'id', operator: 'eq', value: { kind: 'value', text: '9007199254740993' } },
    { column: 'note', operator: 'contains', value: { kind: 'value', text: '_%\n' } }
  ] }];
  const key = 'a'.repeat(64), different = 'b'.repeat(64);
  const store = createResultFilters(memento);
  await store.save(key, '  Production search ', filters, columns);
  const restarted = createResultFilters(memento);
  assert.deepEqual(restarted.list(key, columns), [{ name: 'Production search', filters, applicable: true }]);
  assert.deepEqual(restarted.list(different, columns), []);
  assert.deepEqual(restarted.list(key, columns.slice(0, 1)), [{ name: 'Production search', filters: undefined, applicable: false }]);
  assert.throws(() => restarted.save(key, 'broken', filters, columns.slice(0, 1)), /catalog column/);
  await restarted.remove(key, 'production SEARCH');
  assert.deepEqual(createResultFilters(memento).list(key, columns), []);
});

test('result pins survive bounded history pressure and names cannot mutate a running result', () => {
  const closed = [], view = new ResultsView({}, {}, { resultClosed: id => closed.push(id) });
  const pin = view.begin('SELECT 1', 'DB');
  assert.throws(() => view.setResultTab(pin, { pinned: true }), /completed result/);
  view.finish(pin, { columns: ['n'], rows: [[1]] });
  assert.deepEqual(view.setResultTab(pin, { name: '  Evidence  ', pinned: true }), { id: pin, name: 'Evidence', pinned: true });
  for (let i = 0; i < 14; i++) {
    const id = view.begin('SELECT 2', 'DB');
    view.finish(id, { columns: ['n'], rows: [[2]] });
  }
  assert.equal(view.history.length, 8);
  assert.equal(view.history[0].id, pin);
  assert.equal(view.history[0].tabName, 'Evidence');
  assert.ok(!closed.includes(pin));
  for (const record of view.history) view.setResultTab(record.id, { pinned: true });
  assert.throws(() => view.begin('SELECT 3', 'DB'), /pinned or contain active work/);
  assert.deepEqual(view.setResultTab(pin, { name: '', pinned: false }), { id: pin, name: undefined, pinned: false });
  view.begin('SELECT 3', 'DB');
  assert.ok(closed.includes(pin));
});
