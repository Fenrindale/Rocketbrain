'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ResultsView } = require('../src/results');
const { createResultLayouts, resultTableKey, tableLayoutConnectionKey } = require('../src/db/result-layouts');

const direct = { host: 'DB.example.test', port: 3306, user: 'member', database: 'shop', password: 'test-secret' };
const connection = tableLayoutConnectionKey(direct);
const columns = [
  { name: 'name', hidden: false, pinned: true, width: 240 },
  { name: 'id', hidden: true, pinned: false }
];

function memento() {
  const values = new Map();
  return {
    values,
    get: key => values.get(key),
    async update(key, value) { values.set(key, structuredClone(value)); }
  };
}

function preview(view, key, table, modelId, names = ['id', 'name']) {
  const id = view.begin('SELECT * FROM `example`', 'Display name', { tableLayoutConnection: key, table });
  view.finish(id, { columns: names, rows: [], edit: { modelId, table } });
  return id;
}

test('table preference identity uses the logical saved endpoint, account, schema and SSH route', () => {
  assert.equal(tableLayoutConnectionKey({ ...direct, password: 'rotated', host: 'db.example.test', readOnly: true }), connection);
  for (const changed of [{ host: 'elsewhere.example.test' }, { port: 3307 }, { user: 'other' }, { database: 'other' }, { ssl: { serverName: 'db.other.test' } }]) {
    assert.notEqual(tableLayoutConnectionKey({ ...direct, ...changed }), connection);
  }
  const profile = { ...direct, id: '390ab816-da48-49af-abf6-ba5323fdcc16', name: 'Original name', ssh: { host: 'jump.example.test', user: 'bridge' } };
  const first = tableLayoutConnectionKey({ ...direct, host: '127.0.0.1', port: 54001 }, profile);
  const next = tableLayoutConnectionKey({ ...direct, host: '127.0.0.1', port: 54002 }, { ...profile, name: 'Renamed' });
  assert.equal(first, next);
  const summary = { id:profile.id, host:profile.host, database:profile.database, ssh:true, connectionKey:first };
  assert.equal(tableLayoutConnectionKey({ ...direct,host:'127.0.0.1',port:54003 },summary),first);
  assert.notEqual(first, tableLayoutConnectionKey(direct, { ...profile, ssh: { ...profile.ssh, user: 'different' } }));
  assert.notEqual(first, tableLayoutConnectionKey(direct, { ...profile, database: 'next_schema' }));
  assert.notEqual(resultTableKey(connection, 'orders'), resultTableKey(connection, 'customers'));
});

test('result layout writes are serialized, persist across host recreation and isolate same-named objects', async () => {
  const state = memento(), context = { workspaceState: state };
  const host = new ResultsView({ workspace: { isTrusted: true } }, context);
  const origin = preview(host, connection, 'orders', 'model-a');
  const peer = preview(host, connection, 'customers', 'model-b');
  const remote = preview(host, tableLayoutConnectionKey({ ...direct, port: 3307 }), 'orders', 'model-c');
  await assert.rejects(host.saveLayout(origin, 'stale-id', columns), /current table preview/);
  await assert.rejects(host.saveLayout(origin, 'model-a', columns.map(column => ({ ...column, hidden: true }))), /columns changed/);
  await assert.rejects(host.saveLayout(origin, 'model-a', [{ ...columns[0], name: 'unknown' }, columns[1]]), /columns changed/);
  await Promise.all([
    host.saveLayout(origin, 'model-a', columns.map(column => ({ ...column, ...(column.width ? { width: 200 } : {}) }))),
    host.saveLayout(origin, 'model-a', columns)
  ]);
  assert.deepEqual(host.savedLayout(origin), columns);
  assert.equal(host.savedLayout(peer), undefined);
  assert.equal(host.savedLayout(remote), undefined);
  assert.doesNotMatch(JSON.stringify([...state.values]), /DB\.example\.test|test-secret|member|shop|orders|customers/);

  const restarted = new ResultsView({ workspace: { isTrusted: true } }, context);
  const restored = preview(restarted, connection, 'orders', 'fresh-model', ['id', 'name', 'notes']);
  assert.deepEqual(restarted.savedLayout(restored), columns);
  const ordinary = restarted.begin('SELECT * FROM orders', 'Display name');
  restarted.finish(ordinary, { columns: ['id', 'name'], rows: [] });
  await assert.rejects(restarted.saveLayout(ordinary, 'missing', columns), /current table preview/);
  await restarted.saveLayout(restored, 'fresh-model', []);
  const again = new ResultsView({ workspace: { isTrusted: true } }, context);
  assert.equal(again.savedLayout(preview(again, connection, 'orders', 'reset-model')), undefined);
});

test('workspace state update failure preserves the last durable layout and can be retried', async () => {
  const state = memento(), goodUpdate = state.update;
  const store = createResultLayouts(state), key = resultTableKey(connection, 'orders');
  await store.write(key, columns, ['id', 'name']);
  state.update = async () => { throw Error('workspace unavailable'); };
  await assert.rejects(store.write(key, [], ['id', 'name']), /workspace unavailable/);
  assert.deepEqual(store.read(key), columns);
  state.update = goodUpdate;
  await store.write(key, [], ['id', 'name']);
  assert.equal(store.read(key), undefined);
});
