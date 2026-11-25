'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { randomBytes } = require('node:crypto');
const { MysqlService } = require('../src/db/mysql');
const { createResultSnapshotStore } = require('../src/db/result-snapshots');
const { compareSavedCaptures } = require('../src/db/saved-result-compare');
const { owned } = require('./schema-stored-diff-host');
const { jdbcReadback } = require('./java-source-analysis-host');

const baseline = "SELECT CAST('9007199254740993' AS SIGNED) AS item_id,'KR' AS region,CAST('15.1200' AS DECIMAL(20,4)) AS price,UNHEX('61FF') AS payload,NULL AS notes,'one' AS repeated,'two' AS repeated " +
  "UNION ALL SELECT CAST('9007199254740993' AS SIGNED),'JP',CAST('7.2500' AS DECIMAL(20,4)),UNHEX('61FE'),'배송','three','four' " +
  "UNION ALL SELECT CAST('9007199254740994' AS SIGNED),'JP',CAST('1' AS DECIMAL(20,4)),UNHEX('00'),'old','five','six'";
const candidate = "SELECT 'JP' AS zone,CAST('9007199254740993' AS SIGNED) AS item_id,CAST('7.260000' AS DECIMAL(22,6)) AS price,UNHEX('61FF') AS payload,NULL AS notes,'ambiguous' AS repeated " +
  "UNION ALL SELECT 'KR',CAST('9007199254740995' AS SIGNED),CAST('0' AS DECIMAL(22,6)),UNHEX('01'),'new','ambiguous' " +
  "UNION ALL SELECT 'KR',CAST('9007199254740993' AS SIGNED),CAST('15.12' AS DECIMAL(22,6)),UNHEX('61FF'),NULL,'ambiguous'";
const candidateRow = "SELECT 'JP' AS zone,CAST('9007199254740993' AS SIGNED) AS item_id,CAST('7.260000' AS DECIMAL(22,6)) AS price";
const duplicate = candidateRow + " UNION ALL SELECT 'JP',CAST('9007199254740993' AS SIGNED),CAST('7.26' AS DECIMAL(22,6))";
const nullKey = candidateRow + " UNION ALL SELECT 'KR',CAST(NULL AS SIGNED),CAST('8' AS DECIMAL(22,6))";
const limited = "WITH RECURSIVE nums(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM nums WHERE n<501) SELECT 'KR' AS zone,n AS item_id,n AS price FROM nums ORDER BY n";
const sql = { baseline, candidate, duplicate, nullKey, limited };
const keys = [{ target: 0, source: 1 }, { target: 1, source: 0 }];
const expectedJdbc = { people: 2, departments: 1, rolledBackNames: 0 };

async function runtimeConfig() {
  const runtime = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const host = await owned(runtime.dbConfigPath);
  await host.actor.end();
  assert.deepEqual(await jdbcReadback(), expectedJdbc);
  return { runtime, ...host };
}

function observe(compare, ids) {
  const report = compare(ids.baseline, ids.candidate, keys);
  assert.equal(report.executedSql, false);
  assert.equal(report.readOnly, true);
  assert.equal(report.independentCaptures, true);
  assert.deepEqual(report.summary, { equal: 1, changed: 1, baselineOnly: 1, candidateOnly: 1 });
  const changed = report.differences.find(row => row.state === 'changed');
  assert.deepEqual(changed.key, ['9007199254740993', 'JP']);
  assert.deepEqual(changed.fields.find(field => field.baseline.name === 'price'), {
    baseline: { name: 'price', value: '7.2500' }, candidate: { name: 'price', value: '7.260000' }
  });
  assert.match(changed.fields.find(field => field.baseline.name === 'payload').baseline.value, /^0x61fe$/iu);
  assert.deepEqual(changed.fields.find(field => field.baseline.name === 'notes'), {
    baseline: { name: 'notes', value: '배송' }, candidate: { name: 'notes', value: null }
  });
  assert.equal(report.omittedColumns.baseline.filter(field => field.name === 'repeated').length, 2);
  assert.equal(report.omittedColumns.candidate.filter(field => field.name === 'repeated').length, 1);
  assert.equal(report.baseline.coverage.truncated, false);
  assert.equal(report.candidate.coverage.truncated, false);
  assert.notEqual(report.baseline.contentSha256, report.candidate.contentSha256);
  assert.throws(() => compare(ids.baseline, ids.duplicate, keys), /key is duplicated/);
  assert.throws(() => compare(ids.baseline, ids.nullKey, keys), /key contains SQL NULL/);
  const partial = compare(ids.baseline, ids.limited, keys);
  assert.equal(partial.candidate.coverage.truncated, true);
  assert.equal(partial.candidate.rows, 500);
  assert.equal(partial.summary.candidateOnly, 500);
  return report;
}

async function seedSavedResultComparison(api, vscode, receipt) {
  const { runtime, config } = await runtimeConfig();
  const ids = {}, suffix = randomBytes(4).toString('hex');
  await api.connectMysql(config);
  try {
    for (const [name, query] of Object.entries(sql)) {
      const document = await vscode.workspace.openTextDocument({ language: 'sql', content: query });
      const editor = await vscode.window.showTextDocument(document, { preview: false });
      editor.selection = new vscode.Selection(document.positionAt(0), document.positionAt(query.length));
      const id = await vscode.commands.executeCommand('rocketbrain.runQuery');
      const record = api.results().find(item => item.id === id);
      assert.equal(record?.state, 'done', record?.error);
      const current = api.resultSnapshots.candidates().find(item => item.id === id);
      assert.ok(current);
      ids[name] = (await api.resultSnapshots.save(id, 'Owned ' + name + ' ' + suffix, current.revision)).id;
    }
    const saved = { ids, pid: process.pid, engine: runtime.dbEngine };
    if (receipt) await fs.writeFile(receipt, JSON.stringify(saved), { flag: 'wx' });
    return saved;
  } catch (error) {
    for (const id of Object.values(ids)) await api.resultSnapshots.remove(id);
    throw error;
  } finally { await api.disconnectMysql(); }
}

async function runSavedResultComparisonChecks(api, vscode, checks, receipt) {
  const { runtime, version } = await runtimeConfig();
  const { ids, pid, engine } = receipt ? JSON.parse(await fs.readFile(receipt, 'utf8')) : await seedSavedResultComparison(api, vscode);
  try {
    assert.equal(engine, runtime.dbEngine);
    if (receipt) {
      assert.notEqual(pid, process.pid);
      assert.deepEqual(api.results(), []);
    }
    const beforeTabs = api.results().map(item => item.id);
    assert.deepEqual(api.sessions(), []);
    assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.results.compareSnapshots'));
    const tools = api.resultSnapshots.comparison, report = observe(tools.compare, ids);
    const opened = await tools.open(ids.baseline, ids.candidate, keys);
    const uri = vscode.Uri.parse(opened.documentUri);
    assert.equal(uri.scheme, 'rocketbrain-saved-result-diff');
    const document = await vscode.workspace.openTextDocument(uri);
    assert.deepEqual(JSON.parse(document.getText()), report);
    assert.equal(document.isDirty, false);
    assert.deepEqual(api.results().map(item => item.id), beforeTabs);
    assert.deepEqual(api.sessions(), []);
    const removed = ids.candidate;
    await api.resultSnapshots.remove(removed);
    delete ids.candidate;
    await assert.rejects(tools.open(ids.baseline, removed, keys), /snapshot is unavailable/);
    const jdbc = await jdbcReadback();
    assert.deepEqual(jdbc, expectedJdbc);
    checks.push('Two saved, server-typed query captures opened as a read-only comparison while disconnected, without opening result tabs or replaying SQL.');
    checks.push('A composite key preserved BIGINT identities and exact DECIMAL equality, refused duplicate and NULL keys, and recorded the separately truncated capture.');
    return { engine, version, jdbc, separateHost: pid !== process.pid, readOnlyNativeReport: true, disconnected: true,
      noNewTabs: true, noSqlReplay: true, exactTypedCompositeKeys: true, omittedDuplicateAliases: true,
      duplicateAndNullKeysRejected: true, partialCoverageVisible: true, summary: report.summary };
  } finally {
    for (const id of Object.values(ids)) await api.resultSnapshots.remove(id);
  }
}

async function verifySavedResultComparisonBackend() {
  const { runtime, config, version } = await runtimeConfig();
  const service = new MysqlService(config), items = new Map();
  const storage = { keys: () => [...items.keys()], get: key => items.get(key),
    async update(key, value) { items.set(key, JSON.parse(JSON.stringify(value))); } };
  const saved = createResultSnapshotStore(storage, () => true), ids = {};
  try {
    for (const [name, query] of Object.entries(sql)) {
      const result = await service.query(query);
      ids[name] = (await saved.save(name, result)).id;
    }
  } finally { await service.dispose(); }
  const newHost = createResultSnapshotStore(storage, () => true);
  const report = observe((before, after, mapping) => compareSavedCaptures(newHost.get(before), newHost.get(after), mapping), ids);
  assert.deepEqual(await jdbcReadback(), expectedJdbc);
  return { engine: runtime.dbEngine, version, jdbc: expectedJdbc, snapshotStoreReopened: true, disconnected: true,
    noSqlReplay: true, exactTypedCompositeKeys: true, omittedDuplicateAliases: true,
    duplicateAndNullKeysRejected: true, partialCoverageVisible: true, summary: report.summary };
}

module.exports = { seedSavedResultComparison, runSavedResultComparisonChecks, verifySavedResultComparisonBackend };
if (require.main === module) verifySavedResultComparisonBackend().then(result => console.log(JSON.stringify(result)))
  .catch(error => { console.error(error.stack); process.exitCode = 1; });
