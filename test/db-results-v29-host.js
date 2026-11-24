'use strict';

const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

async function runDbResultsV29Checks(api, vscode, checks) {
  const runtime = JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const marker = JSON.parse(fs.readFileSync(path.join(path.dirname(runtime.dbConfigPath), 'owner.json'), 'utf8'));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(marker.kind));
  const config = JSON.parse(fs.readFileSync(runtime.dbConfigPath, 'utf8'));
  const db = await require('mysql2/promise').createConnection({ ...config, rowsAsArray: true });
  const token = randomBytes(5).toString('hex'), table = 'rb_results_' + token, other = table + '_other';
  const layout = [
    { name: 'label', pinned: true, hidden: false, width: 255 },
    { name: 'id', pinned: false, hidden: false },
    { name: 'note', pinned: false, hidden: true }
  ];
  const record = id => api.results().find(result => result.id === id);
  const sessions = [];
  let connected = false;
  const open = async name => {
    await vscode.commands.executeCommand('rocketbrain.openTable', name);
    const result = api.results().at(-1);
    if (result?.sessionId) sessions.push(result.sessionId);
    assert.equal(result?.result?.edit?.table, name, result?.error);
    return result.id;
  };
  const action = async (id, type, extra = {}) => {
    const current = record(id);
    await api.tableAction(id, { type, modelId: current.result.edit.modelId, draftRevision: current.draftRevision || 0, ...extra });
    assert.equal(record(id).editError, undefined, record(id).editError);
  };
  const data = async () => (await db.query('SELECT id,label,note FROM ' + table + ' ORDER BY id'))[0];
  const probe = async () => {
    const result = await fetch(runtime.baseUrl + '/probe/testing-state');
    assert.ok(result.ok);
    return result.json();
  };
  try {
    const isolation = await probe();
    assert.deepEqual(isolation, { people: 2, departments: 1, rolledBackNames: 0 });
    await db.query('CREATE TABLE ' + table + ' (id INT PRIMARY KEY, label VARCHAR(60) NOT NULL, note VARCHAR(60)) ENGINE=InnoDB');
    await db.query('CREATE TABLE ' + other + ' LIKE ' + table);
    await db.execute('INSERT INTO ' + table + ' VALUES (?,?,?),(?,?,?)', [1, 'First', 'original', 2, 'Second', null]);
    await api.connectMysql(config);
    connected = true;
    const first = await open(table), old = record(first).result.edit.modelId;
    await api.saveResultLayout(first, old, layout);
    assert.deepEqual(api.savedResultLayout(first), layout);
    await action(first, 'enableEdit');
    await assert.rejects(api.saveResultLayout(first, old, []), /current table preview/);

    const expected = [[1, 'First', 'original'], [2, 'Second', null]];
    const rowId = record(first).result.edit.rowIds[0];
    const changes = { updates: [{ rowId, values: { label: { kind: 'value', text: 'Updated' }, note: { kind: 'null' } } }], inserts: [], deletes: [] };
    await action(first, 'draftChanged', { count: 1, draftRevision: 1 });
    await action(first, 'reviewChanges', { changes });
    assert.equal(record(first).review.statements.length, 1);
    assert.deepEqual(await data(), expected);
    const reviewId = record(first).review.reviewId;
    await action(first, 'applyChanges', { reviewId });
    assert.deepEqual(record(first).result.rows[0], [1, 'Updated', null]);
    assert.deepEqual(await data(), expected);
    await action(first, 'rollbackChanges');
    assert.deepEqual(record(first).result.rows, expected);
    await action(first, 'restoreBrowsing');
    assert.deepEqual(api.savedResultLayout(first), layout);

    const sibling = await open(other);
    assert.equal(api.savedResultLayout(sibling), undefined);
    for (const id of sessions.splice(0)) await api.closeConsoleSession(id);
    await api.connectMysql(config);
    const reopened = await open(table);
    assert.notEqual(reopened, first);
    assert.deepEqual(api.savedResultLayout(reopened), layout);
    await api.saveResultLayout(reopened, record(reopened).result.edit.modelId, []);
    assert.equal(api.savedResultLayout(reopened), undefined);
    assert.deepEqual(await probe(), isolation);
    checks.push('Native table layout survives model refresh, a new result tab and reconnect on the same table; a sibling table is isolated and Reset clears its stored layout. Shared edit payloads use review, manual Apply and Rollback with the server rows and Spring fixture verified independently.');
    return { layout: true, newResultTab: true, newConnection: true, siblingIsolated: true, reset: true,
      reviewedSharedDraft: true, rollback: true, springIsolation: isolation };
  } finally {
    try {
      for (const id of sessions) await api.closeConsoleSession(id);
      if (connected) await vscode.commands.executeCommand('rocketbrain.useDemo');
    } finally {
      try { await db.query('DROP TABLE IF EXISTS ' + other + ', ' + table); }
      finally { await db.end(); }
    }
  }
}

module.exports = { runDbResultsV29Checks };
