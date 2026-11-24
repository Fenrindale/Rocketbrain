'use strict';

const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

async function runDbDatasetsV31Checks(api, vscode, checks) {
  const runtime = JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const marker = JSON.parse(fs.readFileSync(path.join(path.dirname(runtime.dbConfigPath), 'owner.json'), 'utf8'));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(marker.kind));
  const config = JSON.parse(fs.readFileSync(runtime.dbConfigPath, 'utf8'));
  const db = await require('mysql2/promise').createConnection({
    ...config, rowsAsArray: true, supportBigNumbers: true, bigNumberStrings: true
  });
  const tag = randomBytes(5).toString('hex'), target = 'rb_compare_dest_' + tag, source = 'rb_compare_source_' + tag;
  const id = '9007199254740993', amount = '9007199254740993.12345678', newAmount = '9007199254740993.12345679';
  const sessions = [];
  const probe = async () => {
    const response = await fetch(runtime.baseUrl + '/probe/testing-state');
    assert.ok(response.ok);
    return response.json();
  };
  const read = async table => (await db.query('SELECT tenant,id,amount,note,HEX(payload) FROM ' + table + ' ORDER BY tenant,id'))[0];
  let current, connected = false, targetResult, sourceResult;
  const action = async (type, payload = {}, error) => {
    const record = current();
    await api.tableAction(targetResult, { type, modelId: record.result.edit.modelId, draftRevision: record.draftRevision || 0, ...payload });
    if (error) assert.match(current().editError || '', error);
    else assert.equal(current().editError, undefined, current().editError);
  };
  try {
    const isolation = await probe();
    assert.deepEqual(isolation, { people: 2, departments: 1, rolledBackNames: 0 });
    await db.query('CREATE TABLE ' + target + ' (tenant VARCHAR(12) COLLATE utf8mb4_bin NOT NULL, id BIGINT UNSIGNED NOT NULL, amount DECIMAL(32,8), note VARCHAR(80), payload BLOB, PRIMARY KEY (tenant,id)) ENGINE=InnoDB');
    await db.query('CREATE TABLE ' + source + ' LIKE ' + target);
    const seed = (table, rows) => db.execute('INSERT INTO ' + table + ' VALUES (?,?,?,?,?),(?,?,?,?,?),(?,?,?,?,?)', rows.flat());
    await seed(target, [['A', id, amount, 'NULL', Buffer.from('CAFE', 'hex')], ['B', '20', '7.1', '', Buffer.alloc(0)],
      ['OnlyTarget', '20', null, null, null]]);
    await seed(source, [['A', id, newAmount, null, Buffer.from('00FF', 'hex')], ['B', '20', '7.1', '', Buffer.alloc(0)],
      ['OnlySource', '20', null, null, null]]);
    const initialTarget = await read(target), initialSource = await read(source);
    await api.connectMysql(config);
    connected = true;

    const sql = 'SELECT id AS ident, tenant AS bucket, payload AS data, amount AS price, note AS remark FROM ' + source + ' ORDER BY tenant,id';
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: 'sql', content: sql }));
    await vscode.commands.executeCommand('rocketbrain.runQuery');
    const captured = api.results().at(-1);
    sourceResult = captured?.id;
    if (captured?.sessionId) sessions.push(captured.sessionId);
    assert.equal(captured?.state, 'done', captured?.error);
    await vscode.commands.executeCommand('rocketbrain.openTable', target);
    const preview = api.results().at(-1);
    targetResult = preview?.id;
    if (preview?.sessionId) sessions.push(preview.sessionId);
    current = () => api.results().find(record => record.id === targetResult);
    assert.equal(preview?.result?.edit?.table, target, preview?.error);
    await action('enableEdit');
    const pairs = [1, 0, 3, 4, 2].map((source, target) => ({ target, source, key: target < 2 }));
    const compare = () => api.compareDatasets(targetResult, sourceResult, pairs);
    const stage = async comparison => {
      await api.stageDatasetComparison(targetResult, { reviewId: comparison.reviewId, rows: [0],
        modelId: current().result.edit.modelId, draftRevision: current().draftRevision || 0 });
      for (let attempt = 0; attempt < 150 && !current().hasDraft; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.ok(current().hasDraft, 'The native Webview did not adopt the compared rows.');
      const { updates, inserts, deletes } = current().bulkDraft;
      await action('reviewChanges', { changes: { updates, inserts, deletes } });
      assert.deepEqual(current().review.summary, { updates: 1, deletes: 0, inserts: 0 });
      return current().review.reviewId;
    };
    const compared = compare();
    assert.deepEqual(compared.summary, { equal: 1, changed: 1, targetOnly: 1, sourceOnly: 1 });
    assert.equal(compared.stageableRows, 1);
    assert.deepEqual(compared.rows[0].key, ['A', id]);
    assert.deepEqual(compared.rows[0].fields.map(({ target, source }) => [target, source]), [[amount, newAmount], ['NULL', null], ['0xcafe', '0x00ff']]);

    const firstReview = await stage(compared);
    assert.deepEqual(await read(target), initialTarget);
    await db.execute('UPDATE ' + target + ' SET note=? WHERE tenant=? AND id=?', ['concurrent', 'A', id]);
    await action('applyChanges', { reviewId: firstReview }, /row changed|row.*deleted/i);
    const concurrent = await read(target);
    assert.equal(concurrent[0][3], 'concurrent');
    assert.equal(concurrent[0][2], amount);
    await action('rollbackChanges');
    const reviewed = await stage(compare());
    assert.deepEqual(await read(target), concurrent);
    await action('applyChanges', { reviewId: reviewed });
    assert.deepEqual(await read(target), concurrent);
    await action('commitChanges');
    const finalRows = await read(target);
    assert.deepEqual(finalRows[0], ['A', id, newAmount, null, '00FF']);
    assert.deepEqual(finalRows.slice(1), initialTarget.slice(1));
    assert.deepEqual(await read(source), initialSource);
    await action('restoreBrowsing');
    assert.deepEqual(await probe(), isolation);
    checks.push('Native captured dataset comparison aligns aliased query columns with a composite table key, preserving exact BIGINT, DECIMAL, NULL and binary differences. Selected matched updates become a Webview draft and require SQL review, Apply and Commit; a concurrent destination change refuses Apply. One-sided rows and the Spring fixture stay intact.');
    return { exactCompositeKeys: true, matchedUpdates: 1, membershipRowsUnchanged: true, nativeDraftAdopted: true,
      conflictRefused: true, commitVerified: true, springIsolation: isolation };
  } finally {
    try {
      for (const session of sessions) await api.closeConsoleSession(session);
      if (connected) await vscode.commands.executeCommand('rocketbrain.useDemo');
    } finally {
      try { await db.query('DROP TABLE IF EXISTS ' + source + ', ' + target); }
      finally { await db.end(); }
    }
  }
}

module.exports = { runDbDatasetsV31Checks };
