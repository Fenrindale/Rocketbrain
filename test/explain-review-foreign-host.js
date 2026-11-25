'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { runExplainReviewChecks } = require('./explain-review-host');

function sharedFiles(vscode) {
  const directory = process.env.ROCKETBRAIN_V40_PLAN_SHARE_DIR;
  assert.ok(directory && path.isAbsolute(directory), 'Set ROCKETBRAIN_V40_PLAN_SHARE_DIR to an isolated absolute directory.');
  return Object.fromEntries(['series', 'baseline', 'candidate'].map(name =>
    [name, vscode.Uri.file(path.join(directory, name + '.json'))]));
}

const stored = async uri => JSON.parse(await fs.readFile(uri.fsPath, 'utf8'));
const alternatives = report => report.candidateReview.pairs.filter(pair => pair.baseline.name.includes('repeated_access') &&
  pair.baseline.index === 'PRIMARY' && pair.candidate.index === 'rb38_lookup_code');
const statuses = report => alternatives(report).map(pair => pair.status);

async function runExplainForeignReviewChecks(api, vscode, checks) {
  const service = api.explainPlans;
  const { series, baseline, candidate } = sharedFiles(vscode);
  const prior = await runExplainReviewChecks(api, vscode, checks, { afterReviewed:async review => {
    const reviewId = review.series.reviewId;
    const [pair, ignored] = alternatives(review.series);
    service.reviewComparison(reviewId, { action:'reset' });
    service.reviewComparison(reviewId, { action:'ignore', candidateId:ignored.id });
    service.reviewComparison(reviewId, { action:'accept', candidateId:pair.id });
    assert.equal((await service.saveComparisonReview(reviewId, series)).decisions, 2);
    const payload = await stored(series);
    assert.deepEqual(payload.decisions.map(([id,, state]) => [id, state]), [[pair.id, 'accepted'], [ignored.id, 'ignored']]);
    await assert.rejects(service.prepareSharedComparisonReview(reviewId, series), /verified by your VS Code secret store/);
    service.reviewComparison(reviewId, { action:'reset' });
    assert.deepEqual(statuses(await service.loadComparisonReview(reviewId, series)),
      ['accepted', 'ignored', 'unavailable', 'pending']);
    await service.exportSamples(review.firstSeries.id, baseline);
    await service.exportSamples(review.secondSeries.id, candidate);
  } });
  checks.push('Exported the original ordered sample archives and their signed review from the native sender profile.');
  return { ...prior, sharePrepared:true, sameProfileVerified:true, sharedDecisions:2 };
}

async function checkForeignReviewReapproval(api, vscode) {
  const service = api.explainPlans, activity = api.activityLog;
  const { series, baseline, candidate } = sharedFiles(vscode);
  const directory = await fs.mkdtemp(path.join(path.dirname(series.fsPath), 'receiver-'));
  const invalidEvidence = vscode.Uri.file(path.join(directory, 'evidence.json'));
  const current = vscode.Uri.file(path.join(directory, 'current.json'));
  const captures = [], comparisons = [];
  const previous = activity.snapshot().enabled;
  const samples = () => captures.map(id => [service.getSample(id, 0).raw, service.getSample(id, 1).raw]);
  const decide = (reviewId, draft, index, choice) =>
    service.setSharedReviewChoice(reviewId, draft.id, draft.candidates[index].id, choice);
  try {
    await assert.rejects(api.databaseCatalog(), /Connect to MySQL or MariaDB/);
    await activity.setEnabled(true);
    const before = activity.snapshot().entries;
    for (const uri of [baseline, candidate]) captures.push((await service.openSavedSamples(uri)).id);
    const raw = samples();
    const show = (...ids) => {
      const report = service.showSeriesComparison(...ids);
      assert.equal(report.saved, true);
      comparisons.push(report.reviewId);
      return report;
    };
    const opened = show(...captures), { reviewId } = opened;
    const reversed = show(captures[1], captures[0]);
    await assert.rejects(service.loadComparisonReview(reviewId, series), /same VS Code secret store/);
    await assert.rejects(service.prepareSharedComparisonReview(reversed.reviewId, series), /original SQL plan captures/);

    const changed = await stored(series);
    changed.decisions[1][1] = '0'.repeat(64);
    await fs.writeFile(invalidEvidence.fsPath, JSON.stringify(changed), { flag:'wx' });
    await assert.rejects(service.prepareSharedComparisonReview(reviewId, invalidEvidence), /candidates have changed/);

    const pairs = alternatives(opened);
    const draft = await service.prepareSharedComparisonReview(reviewId, series);
    assert.equal(draft.signerVerified, false);
    assert.equal(draft.ready, false);
    assert.deepEqual(draft.candidates.map(({ choice, suggested, ...pair }) => [choice, suggested, pair]),
      [['pending', 'accepted', pairs[0]], ['pending', 'ignored', pairs[1]]]);
    assert.throws(() => service.setSharedReviewChoice(reviewId, draft.id, 'forged', 'approve'), /candidate in this shared/);
    assert.equal(decide(reviewId, draft, 0, 'approve').ready, false);
    assert.throws(() => service.applySharedComparisonReview(reviewId, draft.id), /approve or skip every candidate/i);
    await assert.rejects(service.saveComparisonReview(reviewId, current), /pair or ignore an alternative/i);
    decide(reviewId, draft, 0, 'skip');
    assert.equal(decide(reviewId, draft, 1, 'skip').ready, false);
    assert.throws(() => service.applySharedComparisonReview(reviewId, draft.id), /approve at least one/i);
    assert.equal(decide(reviewId, draft, 0, 'approve').ready, true);
    const applied = service.applySharedComparisonReview(reviewId, draft.id);
    const appliedStates = new Map(alternatives(applied).map(({ id, status }) => [id, status]));
    assert.equal(appliedStates.get(pairs[0].id), 'accepted');
    assert.ok(['pending', 'unavailable'].includes(appliedStates.get(pairs[1].id)));
    await service.saveComparisonReview(reviewId, current);
    assert.deepEqual((await stored(current)).decisions.map(([id,, state]) => [id, state]), [[pairs[0].id, 'accepted']]);
    await fs.unlink(current.fsPath);
    assert.throws(() => service.applySharedComparisonReview(reviewId, draft.id), /open the shared SQL plan review again/i);

    service.reviewComparison(reviewId, { action:'reset' });
    const stale = await service.prepareSharedComparisonReview(reviewId, series);
    service.reviewComparison(reviewId, { action:'accept', candidateId:pairs[2].id });
    assert.throws(() => decide(reviewId, stale, 0, 'approve'), /open the shared SQL plan review again/i);
    const conflict = await service.prepareSharedComparisonReview(reviewId, series);
    decide(reviewId, conflict, 0, 'approve');
    decide(reviewId, conflict, 1, 'approve');
    assert.throws(() => service.applySharedComparisonReview(reviewId, conflict.id), /conflicts with another decision/);
    await service.saveComparisonReview(reviewId, current);
    assert.deepEqual((await stored(current)).decisions.map(([id,, state]) => [id, state]), [[pairs[2].id, 'accepted']]);
    service.cancelSharedComparisonReview(reviewId, conflict.id);
    assert.throws(() => decide(reviewId, conflict, 1, 'approve'), /open the shared SQL plan review again/i);
    assert.deepEqual(samples(), raw);
    assert.deepEqual(activity.snapshot().entries, before);
    return { signerVerified:false, reviewed:2, approved:1, skipped:1, atomic:true, wrongOrderRejected:true,
      evidenceRejected:true, staleDraftRejected:true, disconnected:true, noExecution:true, capturesPreserved:true };
  } finally {
    for (const id of comparisons) service.closeComparison(id);
    for (const id of captures) service.closeSeries(id);
    await activity.setEnabled(previous);
    for (const uri of [invalidEvidence, current]) await fs.unlink(uri.fsPath).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
    await fs.rmdir(directory);
  }
}

module.exports = { runExplainForeignReviewChecks, checkForeignReviewReapproval };
