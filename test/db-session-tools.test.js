'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSavedQueries } = require('../src/db/saved-queries');
const { levels, serverIsolationLevel } = require('../src/db/transaction-isolation');
const { registerDbSessionTools } = require('../src/db/session-tools-vscode');

function memory() {
  const entries = new Map();
  return {
    entries,
    get(key, initial) { return entries.get(key) ?? initial; },
    async update(key, value) {
      await new Promise(resolve => setImmediate(resolve));
      entries.set(key, structuredClone(value));
    }
  };
}

test('canonical isolation is read consistently from both server variable names', () => {
  for (const level of levels) {
    const value = level.replaceAll(' ', '-');
    assert.equal(serverIsolationLevel({ rows: [['tx_isolation', value]] }), level);
    assert.equal(serverIsolationLevel({ rows: [['TRANSACTION_ISOLATION', value], ['tx_isolation', value]] }), level);
  }
  for (const output of [
    { rows: [] }, { rows: [['wrong', 'SERIALIZABLE']] }, { rows: [['tx_isolation', 'unrecognized']] },
    { rows: [['tx_isolation', 'READ-COMMITTED'], ['transaction_isolation', 'SERIALIZABLE']] },
    { rows: [['tx_isolation', 'SERIALIZABLE']], truncated: true },
    { rows: [['tx_isolation', 'SERIALIZABLE'], ['tx_isolation', 'SERIALIZABLE']] }
  ]) assert.throws(() => serverIsolationLevel(output), { code: 'ROCKETBRAIN_ISOLATION_NOT_OBSERVED' });
});

test('workspace queries preserve selected bytes, favorite order and edits across a new registration', async () => {
  const state = memory();
  const store = createSavedQueries(state, () => {});
  const sql = " SELECT '한글' AS value;\r\n";
  const [first, second] = await Promise.all([store.save('Alpha', sql), store.save('Zulu', 'SELECT 2')]);
  assert.deepEqual(store.list().map(query => query.name), ['Alpha', 'Zulu']);
  assert.equal(Object.hasOwn(first, 'sql'), false);
  const favorite = await store.update(second.id, second.revision, { favorite: true });
  const reopened = createSavedQueries(state, () => {});
  assert.deepEqual(reopened.list(), [favorite, first]);
  assert.equal(reopened.source(first.id, first.revision), sql);
  const updated = await reopened.update(first.id, first.revision, { name: 'Renamed', sql: 'SELECT 3' });
  await assert.rejects(reopened.remove(first.id, first.revision), /changed/);
  assert.throws(() => reopened.source(first.id, first.revision), /changed/);
  assert.equal(reopened.source(first.id, updated.revision), 'SELECT 3');
  await reopened.remove(updated.id, updated.revision);
  assert.deepEqual(reopened.list(), [favorite]);
});

test('workspace saves reject empty, duplicate, oversized or untrusted entries', async () => {
  let trusted = true;
  const state = memory();
  const store = createSavedQueries(state, () => { if (!trusted) throw new Error('Trust workspace first.'); });
  const entry = await store.save('Full width Ａ', 'SELECT 1');
  await assert.rejects(store.save('full width a', 'SELECT 2'), /already uses/);
  await assert.rejects(store.save('Invalid\nname', 'SELECT 2'), /1–80/);
  await assert.rejects(store.save('Invalid SQL', ' \t '), /128 KiB/);
  await assert.rejects(store.update(entry.id, entry.revision, { sql: '가'.repeat(44000) }), /128 KiB/);
  const pending = store.update(entry.id, entry.revision, { favorite: true });
  trusted = false;
  await assert.rejects(pending, /Trust workspace/);
  assert.throws(() => store.list(), /Trust workspace/);
  trusted = true;
  assert.deepEqual(store.list(), [entry]);
});

test('session command wiring anchors the picker, captures selected SQL and stops stale editor saves', async () => {
  const workspaceState = memory();
  const commands = new Map();
  const calls = [];
  const errors = [];
  const resource = path => ({ scheme: 'file', path: '/' + path, toString: () => 'file:///' + path });
  const document = { languageId: 'sql', version: 1, isClosed: false, uri: resource('active.sql') };
  const editor = { document };
  let updateWhileNaming = false;
  const vscode = {
    workspace: { isTrusted: true, workspaceFolders: [{}] },
    window: {
      activeTextEditor: editor,
      async showInputBox() {
        if (updateWhileNaming) document.version++;
        return 'Saved source';
      },
      async showQuickPick(items, { title }) {
        if (title === 'Set Transaction Isolation') return items.find(item => item.level === 'READ COMMITTED');
        if (title === 'Saved SQL Queries') return items[0];
        return items.find(item => item.value === 'run');
      },
      async showInformationMessage() {},
      async showErrorMessage(message) { errors.push(message); }
    },
    commands: {
      registerCommand(id, action) {
        commands.set(id, action);
        return { dispose() { commands.delete(id); } };
      }
    }
  };
  const observed = { id: 'console-1', connectionId: 11, connectionEpoch: 2, transactionIsolation: 'REPEATABLE READ' };
  const database = {
    selectedSql: source => { assert.equal(source, editor); return 'SELECT 42;'; },
    inspectConsoleIsolation: source => { assert.equal(source, document); return observed; },
    setConsoleIsolation(source, level, context) {
      assert.equal(source, document);
      assert.equal(context, observed);
      calls.push({ level });
      return { transactionIsolation: level };
    },
    savedQueryTarget: () => ({ connectionEpoch: 2, label: 'test database' }),
    openSavedQuery(sql, destination) { calls.push({ sql, destination }); }
  };
  const api = registerDbSessionTools({ workspaceState }, vscode, { database });
  await commands.get('rocketbrain.sql.saveQuery')(resource('active.sql'));
  await commands.get('rocketbrain.sql.savedQueries')();
  await commands.get('rocketbrain.setTransactionIsolation')(resource('active.sql'));
  assert.deepEqual(calls, [
    { sql: 'SELECT 42;', destination: { connectionEpoch: 2, label: 'test database' } },
    { level: 'READ COMMITTED' }
  ]);
  updateWhileNaming = true;
  await commands.get('rocketbrain.sql.saveQuery')();
  assert.match(errors[0], /editor changed/);
  await commands.get('rocketbrain.setTransactionIsolation')(resource('inactive.sql'));
  assert.match(errors[1], /Activate this SQL editor/);
  assert.equal(calls.length, 2);
  assert.equal(api.listSavedQueries().length, 1);
  await api.dispose();
  assert.equal(commands.size, 0);
  assert.throws(() => api.listSavedQueries(), /trusted workspace/);
});
