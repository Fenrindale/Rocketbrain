'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const mysql = require('mysql2/promise');
const { jdbcReadback } = require('./java-source-analysis-host');

function fixtureConfig() {
  const runtime = JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const config = JSON.parse(fs.readFileSync(runtime.dbConfigPath, 'utf8'));
  const directory = path.dirname(runtime.dbConfigPath);
  const marker = JSON.parse(fs.readFileSync(path.join(directory, 'owner.json'), 'utf8'));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(marker.kind));
  assert.equal(marker.id, path.basename(directory));
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.database, 'rocketbrain_fixture');
  assert.equal(runtime.dbEngine, process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE);
  return { config, engine: runtime.dbEngine };
}

async function withSortFixture(action) {
  const { config, engine } = fixtureConfig();
  const spring = await jdbcReadback();
  const table = 'rb_sort_' + randomBytes(5).toString('hex');
  const observer = await mysql.createConnection(config);
  try {
    await observer.query(
      'CREATE TABLE ' + table + ' (id INT PRIMARY KEY, label VARCHAR(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL, ' +
      'score INT NOT NULL, flags VARBINARY(4) NULL, body BLOB NULL, data JSON NULL) ENGINE=InnoDB');
    const items = [[1, null, -6, 255, 2], [2, 'a', -1, 0, 1], [3, 'A', 1, 1, 3],
      [4, 'b', -4, 128, 4], [5, null, 2, null, null], [6, 'á', 6, 0, 2]];
    for (const [id, label, score, byte, number] of items) {
      const bytes = byte == null ? null : Buffer.from([byte]);
      const json = number == null ? null : JSON.stringify({ lot: number });
      await observer.execute('INSERT INTO ' + table + ' VALUES (?,?,?,?,?,?)', [id, label, score, bytes, bytes, json]);
    }
    const report = await action({ table, config, observer });
    assert.deepEqual(await jdbcReadback(), spring);
    return { engine, spring, ...report };
  } finally {
    try { await observer.query('DROP TABLE IF EXISTS ' + table); }
    finally { await observer.end(); }
  }
}

const ordered = [{ column: 'label', direction: 'asc', nulls: 'last', collation: 'utf8mb4_general_ci' },
  { column: 'score', direction: 'desc', expression: 'ABS(score) + 1' }];
const sortedIds = result => result.rows.map(row => Number(row[0]));

async function checkLiveSort(browse) {
  const initial = await browse([]);
  assert.ok(initial.browse.sortOptions.collations.utf8mb4.includes('utf8mb4_bin'));
  assert.ok(initial.browse.sortOptions.collations.utf8mb4.includes('utf8mb4_general_ci'));
  const collated = await browse(ordered);
  assert.deepEqual(sortedIds(collated), [6, 2, 3, 4, 1, 5]);
  assert.deepEqual(collated.browse.order, [...ordered, { column: 'id', direction: 'asc' }]);
  const binary = { column: 'label', direction: 'asc', nulls: 'last', collation: 'utf8mb4_bin' };
  assert.deepEqual(sortedIds(await browse([binary])), [3, 2, 4, 6, 1, 5]);
  assert.deepEqual(sortedIds(await browse([{ ...binary, direction: 'desc', nulls: 'first' }])), [1, 5, 6, 4, 2, 3]);
  assert.deepEqual(sortedIds(await browse([{ ...binary, expression: 'LOWER(label)' }])), [2, 3, 4, 6, 1, 5]);
  assert.deepEqual(sortedIds(await browse([{ column: 'id', direction: 'desc', expression: 'ABS(id % 2)' }])), [1, 3, 5, 2, 4, 6]);
  const bytes = [2, 6, 3, 4, 1, 5];
  assert.deepEqual(sortedIds(await browse([{ column: 'flags', direction: 'asc', nulls: 'last' }])), bytes);
  assert.deepEqual(sortedIds(await browse([{ column: 'body', direction: 'asc', nulls: 'last', expression: 'BYTE_PREFIX(body)' }])), bytes);
  assert.deepEqual(sortedIds(await browse([{ column: 'data', direction: 'asc', nulls: 'last', expression: 'JSON_TEXT(data)' }])), [2, 1, 6, 3, 4, 5]);
  assert.deepEqual(sortedIds(await browse(ordered, 1, 2)), [3, 4]);
  await assert.rejects(browse([{ ...binary, collation: 'latin1_bin' }]), /collation observed/);
  return { orderedRows: sortedIds(collated), mixedDirection: true, secondPage: true, forcedNulls: true, liveCollations: true,
    textExpressions: true, exactPrimaryKeyTiebreaker: true, binaryAndJsonPrefix: true, invalidCollationRejected: true };
}

async function checkPresets(actions, fixture) {
  const name = 'Labels and magnitude';
  await actions.browse(ordered);
  await actions.save(name);
  await actions.open();
  const [preset] = actions.saved();
  assert.deepEqual(preset, { name, sort: ordered, applicable: true });
  assert.deepEqual(sortedIds(await actions.browse(preset.sort)), [6, 2, 3, 4, 1, 5]);
  await fixture.observer.query('ALTER TABLE ' + fixture.table + ' MODIFY label VARCHAR(90) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL');
  await actions.open();
  assert.deepEqual(actions.saved(), [{ name, sort: undefined, applicable: false }]);
  await actions.remove(name);
  assert.deepEqual(actions.saved(), []);
  return { reopenedPreset: true, presetDriftGuard: true, removedPreset: true };
}

async function runGridSortChecks(api, vscode, checks) {
  return withSortFixture(async fixture => {
    const { table, config } = fixture;
    const sessions = new Set();
    let id;
    try {
      await api.connectMysql(config);
      await vscode.commands.executeCommand('rocketbrain.refresh');
      const record = () => api.results().find(item => item.id === id);
      const open = async () => {
        await vscode.commands.executeCommand('rocketbrain.openTable', table);
        const result = api.results().at(-1);
        if (result.sessionId) sessions.add(result.sessionId);
        assert.equal(result.result?.edit?.table, table, result.error);
        id = result.id;
      };
      const browse = async (sort, page = 0, pageSize = 25) => {
        await api.tableAction(id, { type: 'browseTable', query: { sort, page, pageSize, filters: [] } });
        if (record().editError) throw Error(record().editError);
        return record().result;
      };
      await open();
      const sorting = await checkLiveSort(browse);
      const presets = await checkPresets({
        open, browse, saved: () => api.savedResultSorts(id),
        save: name => api.saveResultSort(id, record().result.edit.modelId, name),
        remove: name => api.removeResultSort(id, record().result.edit.modelId, name)
      }, fixture);
      checks.push('Native table browsing observes charset-compatible collations and applies NULL placement, typed multi-sort expressions, binary and JSON prefix ordering, primary-key ties and offset pages on the live server.');
      checks.push('An ordered native sort preset reopens with exact rules, rejects changed column metadata and can be removed.');
      return { nativeCommands: true, ...sorting, ...presets };
    } finally {
      await Promise.all([...sessions].map(session => api.closeConsoleSession(session)));
      await vscode.commands.executeCommand('rocketbrain.useDemo');
    }
  });
}

async function verifyGridSort() {
  const { MysqlService } = require('../src/db/mysql');
  const { TableEditor } = require('../src/table-editor');
  const { ResultsView } = require('../src/results');
  const { tableLayoutConnectionKey } = require('../src/db/result-layouts');
  return withSortFixture(async fixture => {
    const { config, table } = fixture, db = new MysqlService(config), data = new Map();
    let id, workbench, results;
    function resetWorkbench() {
      workbench?.dispose();
      results = new ResultsView({ workspace: { isTrusted: true } }, { extensionUri: '/test', subscriptions: [],
        workspaceState: { get: key => data.get(key), async update(key, value) { data.set(key, structuredClone(value)); } } });
      const connection = { db, mysql: true, epoch: 1, label: 'Disposable sort fixture', tableLayoutConnection: tableLayoutConnectionKey(config) };
      workbench = new TableEditor({ results, connection: () => connection, trusted: () => true, withSession: (session, action) => action() });
    }
    const open = async () => {
      resetWorkbench();
      id = await workbench.open({ table, sessionId: 'grid-sort', sql: 'SELECT * FROM ' + table });
      assert.equal(record()?.result?.edit?.table, table, record()?.error);
    };
    const record = () => results.history.find(item => item.id === id);
    const browse = async (sort, page = 0, pageSize = 25) => {
      await workbench.handle(id, { type: 'browseTable', query: { sort, page, pageSize, filters: [] } });
      if (record().editError) throw Error(record().editError);
      return record().result;
    };
    try {
      await db.openSession('grid-sort', { readOnly: true });
      await open();
      const sorting = await checkLiveSort(browse);
      const presets = await checkPresets({
        open, browse, saved: () => results.savedSorts(id),
        save: name => results.saveSortPreset(id, record().result.edit.modelId, name),
        remove: name => results.removeSortPreset(id, record().result.edit.modelId, name)
      }, fixture);
      return { nativeCommands: false, persistedAcrossHostInstances: true, ...sorting, ...presets };
    } finally {
      workbench?.dispose();
      await db.dispose();
    }
  });
}

if (require.main === module) verifyGridSort().then(report => console.log(JSON.stringify(report))).catch(error => {
  console.error(error.stack);
  process.exitCode = 1;
});
module.exports = { runGridSortChecks, verifyGridSort, withSortFixture, ordered };
