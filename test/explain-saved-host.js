'use strict';

const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs/promises');
const mysql = require('mysql2/promise');
const os = require('node:os');
const path = require('node:path');
const { comparePlans } = require('../src/db/explain-plan');

async function runExplainSavedChecks(api, vscode, checks) {
  const runtime = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const config = JSON.parse(await fs.readFile(runtime.dbConfigPath, 'utf8'));
  const owner = JSON.parse(await fs.readFile(path.join(path.dirname(runtime.dbConfigPath), 'owner.json'), 'utf8'));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(owner.kind));
  assert.equal(config.host, '127.0.0.1');
  assert.equal(runtime.dbEngine, process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE);
  const service = api.explainPlans, activity = api.activityLog, ids = new Set();
  const previous = activity.snapshot().enabled;
  const verb = runtime.dbEngine === 'mysql' ? 'EXPLAIN' : 'ANALYZE';
  const completed = () => activity.snapshot().entries.filter(entry =>
    entry.category === 'query' && entry.operation === verb && entry.status === 'succeeded').length;
  const table = 'rb37_explain_' + randomBytes(6).toString('hex');
  const indexName = 'rb37_lookup_code';
  const select = index => 'SELECT moved_access.id FROM ' + table + ' AS moved_access FORCE INDEX (' + index + ')';
  const peopleBefore = select('PRIMARY') + ' WHERE moved_access.id BETWEEN 1 AND 3 AND moved_access.marker + 0 <> 90';
  const peopleAfter = select(indexName) + ' WHERE moved_access.code BETWEEN 15 AND 40 AND moved_access.marker + 0 <> 91';
  const departments = 'SELECT department_branch.id FROM rb_spring_department AS department_branch';
  async function capture(first, second) {
    const sql = first + ' UNION ALL ' + second;
    const document = await vscode.workspace.openTextDocument({ language:'sql', content:sql });
    const selection = new vscode.Selection(document.positionAt(0), document.positionAt(sql.length));
    const review = service.prepareSeries({ document, selection, samples:2 });
    const series = await service.measureSeries(review.id, { confirmed:true });
    ids.add(series.id);
    return series;
  }

  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'rocketbrain-saved-plans-'));
  const leftPath = path.join(scratch, 'baseline.json'), rightPath = path.join(scratch, 'candidate.json');
  let fixture, created = false, connected = false;
  try {
    assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.sql.openPlanSamples'));
    fixture = await mysql.createConnection(config);
    await fixture.query('CREATE TABLE ' + table + ' (id BIGINT PRIMARY KEY, code BIGINT NOT NULL, marker BIGINT NOT NULL, KEY ' +
      indexName + ' (code)) ENGINE=InnoDB');
    created = true;
    await fixture.query('INSERT INTO ' + table + ' (id, code, marker) VALUES (1,11,80),(2,20,90),(3,25,91),(4,35,93),(5,50,95)');
    await api.connectMysql(config);
    connected = true;
    await activity.setEnabled(true);
    const start = completed();
    const baseline = await capture(peopleBefore, departments);
    const candidate = await capture(departments, peopleAfter);
    assert.equal(completed() - start, 4);
    const plansBefore = [0, 1].map(index => service.getSample(baseline.id, index));
    const plansAfter = [0, 1].map(index => service.getSample(candidate.id, index));
    const single = comparePlans(plansBefore[0], plansAfter[0]);
    function assertChanges(rows, readName) {
      const moves = rows.filter(row => row.alignment === 'candidate-move' && readName(row).includes('moved_access'));
      assert.ok(moves.some(row => row.changes.some(change => change.label === 'Index' &&
        change.before === 'PRIMARY' && change.after === indexName)), JSON.stringify(moves.map(row => row.changes)));
      assert.ok(moves.some(row => row.changes.some(change => change.label === 'Predicate' &&
        change.before && change.after && change.before !== change.after)));
    }
    assertChanges(single.rows.filter(row => row.before), row => row.before.name);
    const left = vscode.Uri.file(leftPath), right = vscode.Uri.file(rightPath);
    await service.exportSamples(baseline.id, left);
    await service.exportSamples(candidate.id, right);
    const archive = JSON.parse(await fs.readFile(leftPath, 'utf8'));
    archive.summary.metrics = [{ count:999, median:'tampered' }];
    archive.summary.shapes = [];
    await fs.writeFile(leftPath, JSON.stringify(archive), 'utf8');
    const reopened = await service.openSavedSamples(left);
    ids.add(reopened.id);
    assert.equal(reopened.saved, true);
    assert.deepEqual(reopened.metrics, baseline.metrics);
    assert.deepEqual(reopened.shapes, baseline.shapes);
    const online = service.seriesComparison(reopened.id, candidate.id);
    assert.equal(online.saved, true);
    assertChanges(online.changedAccess, row => row.baselineName);
    for (const id of [baseline.id, candidate.id, reopened.id]) {
      service.closeSeries(id);
      ids.delete(id);
    }
    await api.disconnectMysql();
    connected = false;
    const archivedBaseline = await service.openSavedSamples(left), archivedCandidate = await service.openSavedSamples(right);
    ids.add(archivedBaseline.id);
    ids.add(archivedCandidate.id);
    for (const [series, plans] of [[archivedBaseline, plansBefore], [archivedCandidate, plansAfter]]) {
      assert.deepEqual([0, 1].map(index => service.getSample(series.id, index).raw), plans.map(plan => plan.raw));
    }
    const offline = service.showSeriesComparison(archivedBaseline.id, archivedCandidate.id);
    assert.equal(offline.saved, true);
    assertChanges(offline.changedAccess, row => row.baselineName);
    assert.equal(completed() - start, 4);
    const response = await fetch(runtime.baseUrl + '/probe/testing-state', { signal:AbortSignal.timeout(9000) });
    assert.ok(response.ok);
    const jdbc = await response.json();
    assert.deepEqual(jdbc, { people:2, departments:1, rolledBackNames:0 });
    checks.push('Actual server plans swapped a UNION ALL branch after an index and its predicate changed. Archived samples recovered their raw plans and recomputed statistics, and a disconnected comparison issued no queries.');
    return { engine:runtime.dbEngine, format:plansBefore[0].format, baselineSamples:2, candidateSamples:2,
      singleMoved:single.movedCount, seriesMoved:offline.movedCount, singleCandidateMoves:single.candidateMoveCount,
      seriesCandidateMoves:offline.candidateMoveCount, changedIndexCompared:true, changedPredicateCompared:true,
      onlineCompared:true, offlineCompared:true, rawPreserved:true, recomputedSummary:true, noExtraExecution:true, jdbc };
  } finally {
    for (const id of ids) service.closeSeries(id);
    await activity.setEnabled(previous);
    if (connected) await api.disconnectMysql();
    if (fixture) {
      try {
        if (created) await fixture.query('DROP TABLE ' + table);
      } finally { await fixture.end(); }
    }
    for (const file of [leftPath, rightPath]) await fs.unlink(file).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
    await fs.rmdir(scratch);
  }
}

module.exports = { runExplainSavedChecks };
