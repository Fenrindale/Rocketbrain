'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { runExplainReviewChecks } = require('./explain-review-host');

function ownedReviewDirectory() {
  const root = path.resolve(__dirname, '..', '.vscode-test');
  const relative = path.relative(root, process.env.ROCKETBRAIN_TEST_PROFILE || root);
  assert.match(relative, /^workflows-v39-(?:mysql|mariadb)-[a-f0-9-]+$/i);
  return path.join(root, relative, 'rocketbrain-review-persistence-fixture');
}

function fixtureFiles(dir, vscode) {
  return Object.fromEntries(['plan', 'series', 'baseline', 'candidate', 'tampered', 'current'].map(name =>
    [name, vscode.Uri.file(path.join(dir, name + '.json'))]));
}

const stored = async uri => JSON.parse(await fs.readFile(uri.fsPath, 'utf8'));
const accessAlternatives = report => report.candidateReview.pairs.filter(pair => pair.baseline.name.includes('repeated_access') &&
  pair.baseline.index === 'PRIMARY' && pair.candidate.index === 'rb38_lookup_code');
const states = report => accessAlternatives(report).map(pair => pair.status);

async function removeFiles(uris) {
  for (const uri of uris) await fs.unlink(uri.fsPath).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
}

async function runExplainReviewPersistenceChecks(api, vscode, checks) {
  const service = api.explainPlans, dir = ownedReviewDirectory();
  await fs.mkdir(dir);
  const { plan, series, baseline, candidate, tampered, current } = fixtureFiles(dir, vscode);
  try {
    const prior = await runExplainReviewChecks(api, vscode, checks, { afterReviewed:async review => {
      const singleId = review.single.reviewId, seriesId = review.series.reviewId;
      const expectedPlan = ['accepted', 'ignored', 'unavailable', 'pending'];
      assert.deepEqual(await service.saveComparisonReview(singleId, plan), { uri:plan.toString(), decisions:2 });
      const original = await fs.readFile(plan.fsPath, 'utf8');
      assert.doesNotMatch(original, /SELECT|repeated_access|PRIMARY|127\.0\.0\.1|password|\bsecret\b|\braw\b/i);
      assert.equal(JSON.parse(original).version, 1);
      assert.deepEqual(Object.keys(JSON.parse(original)).sort(), ['captures','decisions','format','keyId','kind','signature','version']);
      await assert.rejects(service.saveComparisonReview(singleId, plan), /preserve the existing export/);
      assert.equal(await fs.readFile(plan.fsPath, 'utf8'), original);
      service.reviewComparison(singleId, { action:'reset' });
      assert.deepEqual(states(await service.loadComparisonReview(singleId, plan)), expectedPlan);

      const changed = JSON.parse(original);
      changed.decisions[0][2] = 'ignored';
      await fs.writeFile(tampered.fsPath, JSON.stringify(changed), { flag:'wx' });
      await assert.rejects(service.loadComparisonReview(singleId, tampered), /signature is invalid/);
      const reversed = service.showComparison(review.second.id, review.first.id);
      try { await assert.rejects(service.loadComparisonReview(reversed.reviewId, plan), /original SQL plan captures/); }
      finally { service.closeComparison(reversed.reviewId); }
      const alternatives = accessAlternatives(service.reviewComparison(singleId, { action:'reset' }));
      assert.equal(alternatives.length, 4);
      service.reviewComparison(singleId, { action:'accept', candidateId:alternatives[2].id });
      await assert.rejects(service.loadComparisonReview(singleId, plan), /conflicts with another decision/);
      await service.saveComparisonReview(singleId, current);
      assert.deepEqual((await stored(current)).decisions.map(([id,, state]) => [id, state]), [[alternatives[2].id, 'accepted']]);
      service.reviewComparison(singleId, { action:'reset' });
      assert.deepEqual(states(await service.loadComparisonReview(singleId, plan)), expectedPlan);

      const alternativesSeries = accessAlternatives(service.reviewComparison(seriesId, { action:'reset' }));
      assert.equal(alternativesSeries.length, 4);
      service.reviewComparison(seriesId, { action:'ignore', candidateId:alternativesSeries[1].id });
      service.reviewComparison(seriesId, { action:'accept', candidateId:alternativesSeries[0].id });
      assert.equal((await service.saveComparisonReview(seriesId, series)).decisions, 2);
      await service.exportSamples(review.firstSeries.id, baseline);
      await service.exportSamples(review.secondSeries.id, candidate);
    } });
    await removeFiles([plan, tampered, current]);
    checks.push('A versioned local plan review restored chosen and ignored pairs, and rejected swapped captures, edited signatures and conflicting pairs without changing existing decisions.');
    return { ...prior, savedReviewVersion:1, singleRestored:true, persistedSeries:true, tamperingRejected:true,
      swappedCapturesRejected:true, conflictsRejectedAtomically:true, noOverwrite:true, noRawSql:true };
  } catch (error) {
    await removeFiles([plan, series, baseline, candidate, tampered, current]);
    await fs.rmdir(dir);
    throw error;
  }
}

async function checkReviewPersistenceRestart(api, vscode) {
  const service = api.explainPlans, dir = ownedReviewDirectory();
  const { series, baseline, candidate } = fixtureFiles(dir, vscode), captureIds = [], reviewIds = [];
  try {
    await assert.rejects(api.databaseCatalog(), /Connect to MySQL or MariaDB/);
    for (const uri of [baseline, candidate]) captureIds.push((await service.openSavedSamples(uri)).id);
    const before = captureIds.map(id => [service.getSample(id, 0).raw, service.getSample(id, 1).raw]);
    const opened = service.showSeriesComparison(...captureIds);
    reviewIds.push(opened.reviewId);
    assert.equal(opened.saved, true);
    const applied = await service.loadComparisonReview(opened.reviewId, series);
    assert.equal(applied.reviewedPairCount, 1);
    assert.deepEqual(states(applied), ['accepted', 'ignored', 'unavailable', 'pending']);
    assert.deepEqual(captureIds.map(id => [service.getSample(id, 0).raw, service.getSample(id, 1).raw]), before);
    return { restored:true, pairs:1, ignored:1, disconnected:true, capturesPreserved:true };
  } finally {
    for (const id of reviewIds) service.closeComparison(id);
    for (const id of captureIds) service.closeSeries(id);
    await removeFiles([series, baseline, candidate]);
    await fs.rmdir(dir);
  }
}

module.exports = { runExplainReviewPersistenceChecks, checkReviewPersistenceRestart };
