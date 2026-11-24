'use strict';

const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

async function runDbResultsV33Checks(api, vscode, checks) {
  const runtime = JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const marker = JSON.parse(fs.readFileSync(path.join(path.dirname(runtime.dbConfigPath), 'owner.json'), 'utf8'));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(marker.kind));
  const config = JSON.parse(fs.readFileSync(runtime.dbConfigPath, 'utf8'));
  const db = await require('mysql2/promise').createConnection(config);
  const table = 'rb_result_tabs_' + randomBytes(5).toString('hex');
  const sessions = new Set(), pins = new Set();
  const rule = (column, operator, text) => ({ column, operator, ...(text === undefined ? {} : { value: { kind: 'value', text } }) });
  const group = [
    { logic: 'or', filters: [rule('label', 'contains', '_%'), { logic: 'and', filters: [
      rule('amount', 'gt', '1000000000000000.00000000'), rule('note', 'isNull')
    ] }] }, rule('id', 'gte', '1')
  ];
  const record = id => api.results().find(result => result.id === id);
  let connected = false;
  const checkSpring = async () => {
    const response = await fetch(runtime.baseUrl + '/probe/testing-state');
    assert.ok(response.ok);
    return response.json();
  };
  try {
    const spring = await checkSpring();
    assert.deepEqual(spring, { people: 2, departments: 1, rolledBackNames: 0 });
    await db.query('CREATE TABLE ' + table + ' (id INT PRIMARY KEY, label VARCHAR(60), amount DECIMAL(24,8), note VARCHAR(60)) ENGINE=InnoDB');
    await db.execute('INSERT INTO ' + table + ' VALUES (?,?,?,?),(?,?,?,?),(?,?,?,?),(?,?,?,?)', [
      1, 'original _%', '1.00000000', 'small',
      2, 'threshold', '1234567890123456.12345678', null,
      3, 'threshold', '1234567890123456.12345678', 'exclude',
      4, 'underscore x', '1.00000000', null
    ]);
    await api.connectMysql(config);
    connected = true;
    const sql = 'SELECT label FROM ' + table + ' WHERE id=1; SELECT amount FROM ' + table + ' WHERE id=2;';
    const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: sql });
    await vscode.window.showTextDocument(doc);
    const run = async () => {
      const described = await api.sqlScripts.describe(doc);
      sessions.add(described.sessionId);
      const reviewed = await api.sqlScripts.preview(described.id, []);
      return api.sqlScripts.run(reviewed.id);
    };
    const executed = await run(), summary = executed.resultId;
    assert.equal(executed.state, 'completed');
    assert.deepEqual(record(summary).result.scriptStatements.map(statement => statement.index), [0, 1]);
    assert.deepEqual(api.setResultTab(summary, { name: 'Retained run', pinned: true }), { id: summary, name: 'Retained run', pinned: true });
    pins.add(summary);
    await db.execute('UPDATE ' + table + ' SET label=? WHERE id=1', ['later _%']);
    for (let i = 0; i < 8; i++) await run();
    assert.equal(record(summary).tabName, 'Retained run');
    const first = await api.sqlScripts.openStatement(summary, 0), second = await api.sqlScripts.openStatement(summary, 1);
    assert.equal(first.executedSql, false);
    assert.equal(second.executedSql, false);
    assert.deepEqual(record(first.resultId).result.rows, [['original _%']]);
    assert.deepEqual(record(second.resultId).result.rows, [['1234567890123456.12345678']]);
    api.setResultTab(first.resultId, { name: 'First capture', pinned: true });
    pins.add(first.resultId);
    assert.deepEqual(await api.sqlScripts.openStatement(summary, 0), first);
    assert.equal(record(first.resultId).tabName, 'First capture');

    async function open() {
      await vscode.commands.executeCommand('rocketbrain.openTable', table);
      const result = api.results().at(-1);
      if (result?.sessionId) sessions.add(result.sessionId);
      assert.equal(result?.result?.edit?.table, table, result?.error);
      return result.id;
    }
    const options = filters => ({ type: 'browseTable', query: { page: 0, pageSize: 25, sort: [], filters } });
    const browse = async (id, filters) => {
      await api.tableAction(id, options(filters));
      assert.equal(record(id).editError, undefined, record(id).editError);
      return record(id).result.rows.map(row => row[0]);
    };
    const firstBrowse = await open();
    assert.deepEqual(await browse(firstBrowse, group), [1, 2]);
    assert.match(record(firstBrowse).result.browse.sql, /LIKE \? ESCAPE '=' OR \(`amount` > \? AND `note` IS NULL\)/);
    assert.ok(!record(firstBrowse).result.browse.sql.includes('1000000000000000.00000000'));
    await api.saveResultFilter(firstBrowse, record(firstBrowse).result.edit.modelId, 'Exact grouped search');
    await api.controlConsoleSession(record(firstBrowse).sessionId, 'begin');
    await api.tableAction(firstBrowse, options([]));
    assert.match(record(firstBrowse).editError, /commit or roll back/);
    await api.controlConsoleSession(record(firstBrowse).sessionId, 'rollback');
    const reopened = await open();
    assert.notEqual(reopened, firstBrowse);
    const saved = api.savedResultFilters(reopened);
    assert.deepEqual(saved, [{ name: 'Exact grouped search', filters: group, applicable: true }]);
    assert.deepEqual(await browse(reopened, saved[0].filters), [1, 2]);
    await api.removeResultFilter(reopened, record(reopened).result.edit.modelId, 'Exact grouped search');
    assert.deepEqual(api.savedResultFilters(reopened), []);
    assert.deepEqual(await checkSpring(), spring);
    checks.push('A named pinned script summary survives eight fresh executions and opens both exact captured statement result sets after the server data changes. Reopening a kept statement reuses its tab without SQL.');
    checks.push('Nested AND/OR uses bound exact decimal, SQL NULL and literal wildcard conditions. A named typed preset loads in a new native table tab, and a live transaction blocks filter changes.');
    return { pinnedScript: true, originalCaptures: 2, tabReused: true, groupedRows: [1, 2],
      presetReopened: true, transactionGuard: true, spring };
  } finally {
    try {
      for (const id of pins) if (record(id)) api.setResultTab(id, { pinned: false });
      for (const id of sessions) await api.closeConsoleSession(id);
      if (connected) await vscode.commands.executeCommand('rocketbrain.useDemo');
    } finally {
      try { await db.query('DROP TABLE IF EXISTS ' + table); }
      finally { await db.end(); }
    }
  }
}

module.exports = { runDbResultsV33Checks };
