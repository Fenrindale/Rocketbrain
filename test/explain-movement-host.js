'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { comparePlans } = require('../src/db/explain-plan');

async function runExplainMovementChecks(api, vscode, checks) {
  const runtime = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const config = JSON.parse(await fs.readFile(runtime.dbConfigPath, 'utf8'));
  const owner = JSON.parse(await fs.readFile(path.join(path.dirname(runtime.dbConfigPath), 'owner.json'), 'utf8'));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(owner.kind));
  assert.equal(config.host, '127.0.0.1');
  assert.equal(runtime.dbEngine, process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE);
  const service = api.explainPlans, activity = api.activityLog, ids = [];
  const previous = activity.snapshot().enabled;
  const verb = runtime.dbEngine === 'mysql' ? 'EXPLAIN' : 'ANALYZE';
  const completed = () => activity.snapshot().entries.filter(entry =>
    entry.category === 'query' && entry.operation === verb && entry.status === 'succeeded').length;
  const people = 'SELECT people_branch.id FROM rb_spring_person AS people_branch';
  const departments = 'SELECT department_branch.id FROM rb_spring_department AS department_branch';
  async function capture(first, second) {
    const sql = first + ' UNION ALL ' + second;
    const document = await vscode.workspace.openTextDocument({ language:'sql', content:sql });
    const selection = new vscode.Selection(document.positionAt(0), document.positionAt(sql.length));
    const review = service.prepareSeries({ document, selection, samples:2 });
    const series = await service.measureSeries(review.id, { confirmed:true });
    ids.push(series.id);
    return series;
  }

  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'rocketbrain-plan-samples-'));
  const file = path.join(scratch, 'samples.json');
  try {
    assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.sql.exportPlanSamples'));
    await api.connectMysql(config);
    await activity.setEnabled(true);
    const before = completed();
    const baseline = await capture(people, departments);
    const candidate = await capture(departments, people);
    assert.equal(completed() - before, 4);
    const planBefore = service.getSample(baseline.id, 0), planAfter = service.getSample(candidate.id, 0);
    const single = comparePlans(planBefore, planAfter);
    const singleMoves = single.rows.filter(row => row.alignment === 'moved');
    const comparison = service.showSeriesComparison(baseline.id, candidate.id);
    const movedMetrics = comparison.metrics.filter(item => item.alignment === 'moved' && item.baseline && item.candidate);
    for (const alias of ['people_branch', 'department_branch']) {
      assert.ok(singleMoves.some(row => row.before.name.includes(alias) && row.baselinePosition !== row.candidatePosition),
        JSON.stringify(single.rows.map(row => [row.before?.name, row.after?.name, row.alignment])));
      assert.ok(movedMetrics.some(row => row.baseline.name.includes(alias) && row.baseline.count === 2 && row.candidate.count === 2));
    }
    const uri = vscode.Uri.file(file);
    assert.equal((await service.exportSamples(baseline.id, uri)).samples, 2);
    const bytes = await fs.readFile(file, 'utf8'), exported = JSON.parse(bytes);
    assert.equal(exported.format, 'RocketbrainSqlPlanSamples');
    assert.equal(exported.version, 1);
    assert.equal(exported.summary.engine, runtime.dbEngine);
    assert.equal(exported.summary.format, runtime.dbEngine === 'mysql' ? 'tree' : 'json');
    assert.deepEqual(exported.summary.metrics, baseline.metrics);
    assert.deepEqual(exported.samples.map(sample => sample.raw), [planBefore.raw, service.getSample(baseline.id, 1).raw]);
    for (const key of ['source', 'target', 'sql']) assert.equal(Object.hasOwn(exported, key), false);
    await assert.rejects(service.exportSamples(baseline.id, uri), /preserve the existing export/);
    assert.equal(await fs.readFile(file, 'utf8'), bytes);
    assert.equal(completed() - before, 4);
    const result = await fetch(runtime.baseUrl + '/probe/testing-state', { signal:AbortSignal.timeout(9000) });
    assert.ok(result.ok);
    const jdbc = await result.json();
    assert.deepEqual(jdbc, { people:2, departments:1, rolledBackNames:0 });
    checks.push('Swapped real UNION ALL arms in two measurement series. Both operators matched their new positions, and the local JSON export retained the raw samples and exact distributions without another server execution.');
    return { engine:runtime.dbEngine, format:planBefore.format, baselineSamples:2, candidateSamples:2,
      singleMoved:single.movedCount, seriesMoved:comparison.movedCount, matchedMovedMetrics:movedMetrics.length,
      exportedSamples:2, rawPreserved:true, exactSummaries:true, existingFilePreserved:true, noExtraExecution:true, jdbc };
  } finally {
    for (const id of ids) service.closeSeries(id);
    await activity.setEnabled(previous);
    await api.disconnectMysql();
    await fs.unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await fs.rmdir(scratch);
  }
}

module.exports = { runExplainMovementChecks };
