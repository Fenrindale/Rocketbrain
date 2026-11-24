'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createQueryHistory, retentionMs } = require('../src/db/query-history');
const { createSavedQueries } = require('../src/db/saved-queries');
const { registerDbSessionTools } = require('../src/db/session-tools-vscode');

const targetA = { key: 'a'.repeat(64), connectionEpoch: 2, label: 'Observed database',
  profile: { id: '11111111-1111-4111-8111-111111111111', database: 'ledger' } };
const targetB = { key: 'b'.repeat(64), connectionEpoch: 3, label: 'Other database',
  profile: { id: '22222222-2222-4222-8222-222222222222', database: 'ledger' } };

function memory() {
  const data = new Map();
  return { data, get: (key, fallback) => data.get(key) ?? fallback,
    async update(key, value) { data.set(key, structuredClone(value)); } };
}

test('history is opt-in, searchable and bounded to exact source plus opaque origin', async () => {
  const state = memory();
  let now = 10 * retentionMs;
  const clock = { now: () => now };
  const history = createQueryHistory(state, () => {}, clock);
  const payload = { sql: 'SELECT 1 AS Customer',
    target: { ...targetA, host: 'private host' }, params: { private: 'excluded bound value' }, password: 'excluded password' };
  assert.equal(await history.record(payload), false);
  assert.deepEqual(history.list(), []);
  await history.setEnabled(true);
  assert.equal(await history.record(payload), true);
  const first = history.list()[0];
  assert.deepEqual(Object.keys(first).sort(), ['id', 'preview', 'recordedAt', 'revision', 'target']);
  assert.equal(history.resolve(first.id, first.revision).sql, payload.sql);
  assert.equal(history.list({ search: 'customer', target: targetA.key })[0].id, first.id);
  assert.deepEqual(history.list({ search: 'customer', target: targetB.key }), []);
  assert.deepEqual(history.list({ since: now + 1 }), []);
  await history.record({ sql: 'SELECT 2 AS Customer', target: targetB });
  assert.equal(history.list()[0].target, targetB.key);
  const saved = JSON.stringify([...state.data.values()]);
  assert.doesNotMatch(saved, /excluded password|excluded bound value|private host|Observed database|ledger/);
  const afterRegistration = createQueryHistory(state, () => {}, clock);
  assert.equal(afterRegistration.enabled(), true);
  assert.equal(afterRegistration.list().length, 2);
  await afterRegistration.remove(first.id, first.revision);
  await assert.rejects(afterRegistration.remove(first.id, first.revision), /removed, expired or changed/);
  await afterRegistration.setEnabled(false);
  assert.equal(await afterRegistration.record(payload), false);
  assert.equal(afterRegistration.list().length, 1);
  now += retentionMs;
  await afterRegistration.prune();
  assert.deepEqual(afterRegistration.list(), []);
  assert.doesNotMatch(JSON.stringify([...state.data.values()]), /SELECT/);
  await afterRegistration.clear();
});

test('queued pruning, entries and removal keep a bounded newest-first ledger', async () => {
  const history = createQueryHistory(memory(), () => {});
  await history.setEnabled(true);
  for (let index = 0; index <= 105; index++) await history.record({ target: targetA, sql: 'SELECT ' + index });
  assert.equal(history.list().length, 100);
  assert.equal(history.list()[0].preview, 'SELECT 105');
  assert.equal(history.list().at(-1).preview, 'SELECT 6');
  await history.clear();
  await assert.rejects(history.remove('missing', 'missing'), /removed, expired or changed/);
});

test('saved tags and bound profiles validate, filter and keep the legacy v1 collection usable', async () => {
  const state = memory();
  const old = { id: '33333333-3333-4333-8333-333333333333', revision: '44444444-4444-4444-8444-444444444444',
    favorite: true, name: 'Existing query', sql: 'SELECT 42;' };
  await state.update('rocketbrain.savedQueries', { version: 1, queries: [old] });
  const saved = createSavedQueries(state, () => {});
  assert.deepEqual(saved.resolve(old.id, old.revision), old);
  await assert.rejects(saved.update(old.id, old.revision, { tags: ['Sales', 'sales'] }), /distinct/);
  await assert.rejects(saved.update(old.id, old.revision, { tags: ['a,b'] }), /commas/);
  await assert.rejects(saved.update(old.id, old.revision, { binding: { ...targetA.profile, key: targetA.key, host: 'private' } }), /observed/);
  const updated = await saved.update(old.id, old.revision, { tags: ['Usage', 'Korean 비용'], binding: { ...targetA.profile, key: targetA.key } });
  assert.deepEqual(saved.list({ tag: 'usage' }), [updated]);
  assert.deepEqual(saved.list({ tag: 'another' }), []);
  assert.doesNotMatch(JSON.stringify(updated), /private/);
  const untied = await saved.update(updated.id, updated.revision, { tags: [], binding: null });
  assert.equal(untied.binding, undefined);
  assert.equal(untied.tags, undefined);
});

test('history and saved SQL recheck revisions and scope at the read-only request boundary', async () => {
  const workspaceState = memory(), calls = [];
  let onQuery, active = targetA, interrupt;
  const database = {
    onDidCompleteUserSql(handler) { onQuery = handler; return { dispose() { onQuery = undefined; } }; },
    savedQueryTarget: () => active,
    selectedSql: editor => editor.sql,
    async openSavedQuery(sql, target, { beforeRun } = {}) {
      if (interrupt) await interrupt();
      beforeRun?.();
      calls.push({ sql, target });
    }
  };
  const vscode = { workspace: { workspaceFolders: [{}], isTrusted: true }, window: {},
    commands: { registerCommand() { return { dispose() {} }; } } };
  const api = registerDbSessionTools({ workspaceState }, vscode, { database });
  try {
    await api.setQueryHistoryEnabled(true);
    onQuery({ sql: 'SELECT 33;', target: targetA });
    await api.flushQueryHistory();
    const history = api.listQueryHistory()[0];
    active = targetB;
    await assert.rejects(api.openQueryHistory(history.id, history.revision, targetB), /where this query was recorded/);
    active = { ...targetA, connectionEpoch: 4 };
    await assert.rejects(api.openQueryHistory(history.id, history.revision, targetA), /active database changed/);
    interrupt = () => api.deleteQueryHistory(history.id, history.revision);
    await assert.rejects(api.openQueryHistory(history.id, history.revision, active), /removed, expired or changed/);
    assert.deepEqual(calls, []);
    interrupt = undefined;
    const editor = { document: { version: 2 }, sql: 'SELECT 55;' };
    const draft = await api.saveQuery('Billing', editor, { tags: ['Customer'] });
    const tied = await api.bindSavedQuery(draft.id, draft.revision, active);
    assert.deepEqual(api.listSavedQueries({ tag: 'Customer' }), [tied]);
    active = { ...targetB, profile: targetA.profile };
    await assert.rejects(api.openSavedQuery(tied.id, tied.revision, active), /bound profile and schema/);
    active = targetA;
    interrupt = () => api.updateSavedQuery(tied.id, tied.revision, { sql: 'SELECT 66;' });
    await assert.rejects(api.openSavedQuery(tied.id, tied.revision, targetA), /saved query changed/i);
    interrupt = undefined;
    const fresh = api.listSavedQueries()[0];
    await api.openSavedQuery(fresh.id, fresh.revision, targetA);
    assert.deepEqual(calls, [{ sql: 'SELECT 66;', target: targetA }]);
  } finally { await api.dispose(); }
  assert.equal(onQuery, undefined);
});
