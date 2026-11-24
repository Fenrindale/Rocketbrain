'use strict';

const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

async function runDbResultsV30Checks(api, vscode, checks) {
  const runtime = JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const marker = JSON.parse(fs.readFileSync(path.join(path.dirname(runtime.dbConfigPath), 'owner.json'), 'utf8'));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(marker.kind));
  const config = JSON.parse(fs.readFileSync(runtime.dbConfigPath, 'utf8'));
  const db = await require('mysql2/promise').createConnection({ ...config, rowsAsArray: true, jsonStrings: true });
  const table = 'rb_analytics_' + randomBytes(5).toString('hex');
  const notes = 'Target\r\nsecond\rthird\nfourth\0끝';
  const settings = '{\n  "exact":9007199254740993, "optional":null\n}';
  const probe = async () => {
    const response = await fetch(runtime.baseUrl + '/probe/testing-state');
    assert.ok(response.ok);
    return response.json();
  };
  let connected = false, sessionId, resultId;
  const record = () => api.results().find(item => item.id === resultId);
  const action = async (type, payload = {}) => {
    const current = record();
    await api.tableAction(resultId, { type, modelId: current.result.edit.modelId, draftRevision: current.draftRevision || 0, ...payload });
    assert.equal(record().editError, undefined, record().editError);
  };
  const values = async () => (await db.query('SELECT notes, opts, payload FROM ' + table + ' ORDER BY id'))[0];
  try {
    const isolation = await probe();
    assert.deepEqual(isolation, { people: 2, departments: 1, rolledBackNames: 0 });
    await db.query('CREATE TABLE ' + table + ' (id INT PRIMARY KEY, category VARCHAR(50), amount DECIMAL(35,15), notes LONGTEXT, opts JSON, payload BLOB) ENGINE=InnoDB');
    await db.execute('INSERT INTO ' + table + ' VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)', [
      1, 'Alpha', '12345678901234567890.000000000000001', 'original', null, Buffer.from([0, 255]),
      2, 'Alpha', '-12345678901234567889.999999999999998', null, null, null,
      3, 'Alpha', '0.000000000000001', '', null, null,
      4, null, null, null, null, null
    ]);
    await api.connectMysql(config);
    connected = true;
    await vscode.commands.executeCommand('rocketbrain.openTable', table);
    const opened = api.results().at(-1);
    sessionId = opened?.sessionId;
    resultId = opened?.id;
    assert.equal(opened?.result?.edit?.table, table, opened?.error);
    assert.equal(opened.result.edit.columns.find(column => column.name === 'opts').kind, 'json');
    const aggregate = operation => api.analyzeResult(resultId, { operation, category: 1, measure: 2 });
    assert.deepEqual(aggregate('sum').groups.map(({ category, value }) => [category, value]), [['Alpha', '0.000000000000004'], [null, null]]);
    assert.equal(aggregate('average').groups[0].value, '1/750000000000000');
    assert.equal(aggregate('count').page, 1);

    await action('enableEdit');
    const ids = record().result.edit.rowIds;
    const text = value => ({ kind: 'value', text: value });
    const changes = {
      updates: [
        { rowId: ids[0], values: { notes: text(notes), opts: text(settings), payload: text('0x000d0aff') } },
        { rowId: ids[1], values: { notes: text(''), opts: text('null'), payload: text('0x') } }
      ], deletes: [], inserts: []
    };
    const prior = await values();
    await action('draftChanged', { count: 2, draftRevision: 1 });
    assert.throws(() => aggregate('sum'), /discard drafts/);
    await action('reviewChanges', { changes });
    assert.equal(record().review.statements.length, 2);
    assert.deepEqual(await values(), prior);
    await action('applyChanges', { reviewId: record().review.reviewId });
    assert.deepEqual(await values(), prior);
    assert.equal(record().result.rows[0][3], notes);
    assert.equal(record().result.rows[0][5], '0x000d0aff');
    await action('commitChanges');
    const after = await values();
    assert.equal(after[0][0], notes);
    assert.match(after[0][1], /9007199254740993/);
    assert.deepEqual(after[0][2], Buffer.from([0, 13, 10, 255]));
    assert.deepEqual(after[1], ['', 'null', Buffer.alloc(0)]);
    assert.deepEqual(after[3], [null, null, null]);
    await action('restoreBrowsing');
    assert.deepEqual(await probe(), isolation);
    checks.push('Native captured table analysis preserves exact DECIMAL cancellation and rational average across Spring-connected rows. Reviewed text retains mixed line endings and NUL, JSON preserves its wide numeric token, and binary round-trips byte-exactly. Empty data, JSON null, and SQL NULL stay distinct over Apply and Commit.');
    return { capturedGroups: 2, exactSum: '0.000000000000004', exactAverage: '1/750000000000000',
      preservedLineEndings: true, jsonWideNumber: true, byteExact: true, distinctNulls: true, commit: true, springIsolation: isolation };
  } finally {
    try {
      if (sessionId) await api.closeConsoleSession(sessionId);
      if (connected) await vscode.commands.executeCommand('rocketbrain.useDemo');
    } finally {
      try { await db.query('DROP TABLE IF EXISTS ' + table); }
      finally { await db.end(); }
    }
  }
}

module.exports = { runDbResultsV30Checks };
