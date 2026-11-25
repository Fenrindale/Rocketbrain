'use strict';

const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs/promises');
const mysql = require('mysql2/promise');
const path = require('node:path');

async function runExplainReviewChecks(api, vscode, checks) {
  const runtime = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const config = JSON.parse(await fs.readFile(runtime.dbConfigPath, 'utf8'));
  const owner = JSON.parse(await fs.readFile(path.join(path.dirname(runtime.dbConfigPath), 'owner.json'), 'utf8'));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(owner.kind));
  assert.equal(config.host, '127.0.0.1');
  assert.equal(runtime.dbEngine, process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE);
  const service = api.explainPlans, activity = api.activityLog, ids = new Set(), seriesIds = new Set(), reviewIds = new Set();
  const previous = activity.snapshot().enabled;
  const verb = runtime.dbEngine === 'mysql' ? 'EXPLAIN' : 'ANALYZE';
  const completed = () => activity.snapshot().entries.filter(entry =>
    entry.category === 'query' && entry.operation === verb && entry.status === 'succeeded').length;
  const table = 'rb38_review_' + randomBytes(6).toString('hex');
  const indexName = 'rb38_lookup_code';
  const select = index => 'SELECT repeated_access.id FROM ' + table + ' AS repeated_access FORCE INDEX (' + index + ') WHERE ';
  const baselineBranches = [
    select('PRIMARY') + 'repeated_access.id BETWEEN 1 AND 3 AND repeated_access.marker + 0 <> 90',
    select('PRIMARY') + 'repeated_access.id BETWEEN 2 AND 4 AND repeated_access.marker + 0 <> 93'
  ];
  const candidateBranches = [
    select(indexName) + 'repeated_access.code BETWEEN 11 AND 30 AND repeated_access.marker + 0 <> 80',
    select(indexName) + 'repeated_access.code BETWEEN 15 AND 40 AND repeated_access.marker + 0 <> 91'
  ];
  const fillers = [
    'SELECT dept_filler.id FROM rb_spring_department AS dept_filler',
    'SELECT person_filler.id FROM rb_spring_person AS person_filler'
  ];
  const baseline = [...baselineBranches, ...fillers].join(' UNION ALL ');
  const candidate = [...fillers, ...candidateBranches].join(' UNION ALL ');

  async function capture(sql, series = false) {
    const document = await vscode.workspace.openTextDocument({ language:'sql', content:sql });
    const selection = new vscode.Selection(document.positionAt(0), document.positionAt(sql.length));
    const request = { document, selection };
    if (series) {
      const preview = service.prepareSeries({ ...request, samples:2 });
      const model = await service.measureSeries(preview.id, { confirmed:true });
      seriesIds.add(model.id);
      return model;
    }
    const preview = service.prepareMeasurement(request);
    const model = await service.measure(preview.id, { confirmed:true });
    ids.add(model.id);
    return model;
  }

  const review = (report, action, candidateId) => service.reviewComparison(report.reviewId, { action, candidateId });
  function realOptions(report) {
    const pairs = report.candidateReview.pairs.filter(pair => pair.baseline.name.includes('repeated_access') &&
      pair.baseline.index === 'PRIMARY' && pair.candidate.index === indexName);
    assert.equal(pairs.length, 4, JSON.stringify(report.candidateReview.pairs));
    assert.equal(new Set(pairs.map(pair => pair.baseline.position)).size, 2);
    assert.equal(new Set(pairs.map(pair => pair.candidate.position)).size, 2);
    for (const pair of pairs) {
      assert.equal(pair.matching, 'access');
      assert.equal(pair.status, 'pending');
      assert.notEqual(pair.baseline.position, pair.candidate.position);
      assert.ok(pair.baseline.method && pair.baseline.method === pair.candidate.method);
    }
    assert.ok(pairs.some(pair => pair.baseline.predicate && pair.candidate.predicate &&
      pair.baseline.predicate !== pair.candidate.predicate));
    return pairs;
  }

  let fixture, created = false, connected = false;
  try {
    fixture = await mysql.createConnection(config);
    await fixture.query('CREATE TABLE ' + table + ' (id BIGINT PRIMARY KEY, code BIGINT NOT NULL, marker BIGINT NOT NULL, KEY ' +
      indexName + ' (code)) ENGINE=InnoDB');
    created = true;
    await fixture.query('INSERT INTO ' + table + ' (id, code, marker) VALUES (1,11,80),(2,20,90),(3,25,91),(4,35,93),(5,50,95)');
    await api.connectMysql(config);
    connected = true;
    await activity.setEnabled(true);
    const start = completed();
    const first = await capture(baseline), second = await capture(candidate);
    const firstSeries = await capture(baseline, true), secondSeries = await capture(candidate, true);
    const rawSamples = [service.getSample(firstSeries.id, 0).raw, service.getSample(secondSeries.id, 0).raw];
    assert.equal(completed() - start, 6);
    await api.disconnectMysql();
    connected = false;

    const single = service.showComparison(first.id, second.id);
    reviewIds.add(single.reviewId);
    const [pair, ignored, conflict] = realOptions(single);
    assert.equal(single.reviewedPairCount, 0);
    assert.equal(conflict.candidate.position, pair.candidate.position);
    assert.equal(review(single, 'ignore', ignored.id).candidateReview.pairs.find(option => option.id === ignored.id).status, 'ignored');
    const paired = review(single, 'accept', pair.id);
    assert.equal(paired.reviewedPairCount, 1);
    assert.ok(paired.rows.some(row => row.alignment === 'reviewed' && row.baselinePosition === pair.baseline.position &&
      row.candidatePosition === pair.candidate.position));
    assert.equal(paired.candidateReview.pairs.find(item => item.id === conflict.id).status, 'unavailable');
    assert.throws(() => review(single, 'accept', conflict.id), /available pair/);
    assert.throws(() => review(single, 'accept', 'forged'), /available pair/);

    const series = service.showSeriesComparison(firstSeries.id, secondSeries.id);
    reviewIds.add(series.reviewId);
    const seriesPairs = realOptions(series);
    assert.equal(series.reviewedPairCount, 0);
    const seriesReviewed = review(series, 'accept', seriesPairs[0].id);
    assert.equal(seriesReviewed.reviewedPairCount, 1);
    assert.ok(seriesReviewed.metrics.some(metric => metric.alignment === 'reviewed' && metric.baseline && metric.candidate));
    const reset = review(single, 'reset');
    assert.equal(reset.reviewedPairCount, 0);
    assert.deepEqual(realOptions(reset), realOptions(single));
    service.closeComparison(series.reviewId);
    assert.throws(() => review(series, 'reset'), /closed/);
    assert.equal(completed() - start, 6);
    assert.deepEqual([service.getSample(firstSeries.id, 0).raw, service.getSample(secondSeries.id, 0).raw], rawSamples);
    assert.deepEqual(realOptions(service.comparison(first.id, second.id)), realOptions(single));

    const response = await fetch(runtime.baseUrl + '/probe/testing-state', { signal:AbortSignal.timeout(9000) });
    assert.ok(response.ok);
    const jdbc = await response.json();
    assert.deepEqual(jdbc, { people:2, departments:1, rolledBackNames:0 });
    checks.push('Actual plans contained four alternatives for relocated repeated accesses. Each comparison reviewed pairs independently, kept its captures, and issued no additional SQL.');
    return { engine:runtime.dbEngine, format:first.format, singleOptions:4, seriesOptions:seriesPairs.length,
      choiceEvidence:true, singleReviewed:true, seriesReviewed:true, conflictRejected:true, ignoreAndReset:true,
      scopeIsolated:true, capturesUnchanged:true, noExtraExecution:true, jdbc };
  } finally {
    for (const id of reviewIds) service.closeComparison(id);
    for (const id of ids) service.close(id);
    for (const id of seriesIds) service.closeSeries(id);
    await activity.setEnabled(previous);
    if (connected) await api.disconnectMysql();
    if (fixture) {
      try {
        if (created) await fixture.query('DROP TABLE ' + table);
      } finally { await fixture.end(); }
    }
  }
}

module.exports = { runExplainReviewChecks };
