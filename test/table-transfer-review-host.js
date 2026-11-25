'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { runTableTransferVerificationChecks } = require('./table-transfer-verification-host');

const reviewDecisions = { acknowledged: 1, 'follow-up-required': 2, 'external-resolution-recorded': 1 };
const observationFields = ['version', 'captureId', 'recordedAt', 'status', 'reason', 'coverage', 'rows', 'sampledKeys',
  'checkedKeys', 'keyLimit', 'matching', 'missing', 'mismatch', 'comparedMappedColumns', 'historicalCommitConfirmed',
  'replayBlocked', 'observationId', 'review'];

async function checkTransferReviewRestart(api, vscode) {
  await assert.rejects(api.databaseCatalog(), /Connect to MySQL or MariaDB/);
  const observations = await api.tableTransfer.listTransferVerificationEvidence();
  assert.equal(observations.length, 10);
  assert.equal(new Set(observations.map(entry => entry.observationId)).size, 10);
  const decisions = {};
  let reviewed = 0;
  for (const entry of observations) {
    assert.ok(Object.keys(entry).every(field => observationFields.includes(field)));
    assert.match(entry.observationId, /^[0-9a-f-]{36}$/i);
    assert.equal(entry.historicalCommitConfirmed, false);
    assert.equal(entry.replayBlocked, true);
    if (entry.review) {
      assert.deepEqual(Object.keys(entry.review).sort(), ['decision', 'historicalCommitConfirmed', 'replayBlocked', 'reviewedAt']);
      assert.equal(entry.review.historicalCommitConfirmed, false);
      assert.equal(entry.review.replayBlocked, true);
      assert.ok(Date.parse(entry.review.reviewedAt) >= Date.parse(entry.recordedAt));
      decisions[entry.review.decision] = (decisions[entry.review.decision] || 0) + 1;
      reviewed++;
    }
  }
  assert.deepEqual(decisions, reviewDecisions);
  assert.equal(reviewed, 4);
  const visible = await vscode.commands.executeCommand('rocketbrain.data.transferVerificationHistory');
  assert.deepEqual(visible, observations);
  const history = vscode.window.activeTextEditor.document;
  assert.equal(history.uri.scheme, 'rocketbrain-table-copy-history');
  assert.match(history.getText(), /Mark for Follow-up/);
  assert.match(history.getText(), /Record External Resolution/);
  assert.match(history.getText(), /Acknowledge Inspection/);
  assert.match(history.getText(), /Commit history remains unconfirmed and replay stays blocked/);
  const canonical = value => JSON.stringify(value, Object.keys(value).sort());
  const historySha256 = createHash('sha256').update(JSON.stringify(observations.map(({ review, ...entry }) =>
    [canonical(entry), review ? canonical(review) : '']).sort(([a], [b]) => a.localeCompare(b)))).digest('hex');
  return { observations: observations.length, reviewed, decisions, historySha256, disconnected: true };
}

async function runTableTransferReviewChecks(api, vscode, checks) {
  const tools = api.tableTransfer;
  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes('rocketbrain.data.reviewTransferVerification'));
  assert.ok(commands.includes('rocketbrain.data.exportTransferVerificationHistory'));
  const initial = new Map();
  let staleRejected = 0, fenceChecks = 0, filteredCapture;
  const result = await runTableTransferVerificationChecks(api, vscode, checks, {
    expanded: true,
    async onVerification({ status, captureId, engine }) {
      if (status === 'matching') {
        const preview = await tools.prepareTransferVerificationReview({ captureId });
        assert.equal(preview.observation.status, 'matching');
        initial.set(captureId, preview.reviewId);
        return;
      }
      if (status === 'inconclusive') {
        const reviewId = initial.get(captureId);
        assert.ok(reviewId);
        await assert.rejects(tools.recordTransferVerificationReview({ reviewId, decision: 'acknowledged' }), /evidence or its review changed/);
        staleRejected++;
        filteredCapture = captureId;
      }
      const { reviewId, observation } = await tools.prepareTransferVerificationReview({ captureId });
      assert.equal(observation.status, status);
      const decision = status === 'inconclusive' ? 'follow-up-required'
        : engine === 'mysql' ? 'external-resolution-recorded' : 'acknowledged';
      const recorded = await tools.recordTransferVerificationReview({ reviewId, decision });
      assert.equal(recorded.observationId, observation.observationId);
      assert.equal(recorded.review.decision, decision);
      assert.equal(recorded.historicalCommitConfirmed, false);
      assert.equal(recorded.replayBlocked, true);
      await assert.rejects(tools.resumeSource({ captureId }), /previous Commit/);
      fenceChecks++;
    }
  });
  assert.equal(staleRejected, 2);
  assert.equal(fenceChecks, 4);
  const reopened = await checkTransferReviewRestart(api, vscode);
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'rocketbrain-copy-verifications-'));
  const full = path.join(temporary, 'history.json'), filtered = path.join(temporary, 'capture.json');
  try {
    const uri = vscode.Uri.file(full), captureUri = vscode.Uri.file(filtered);
    assert.deepEqual(await tools.exportTransferVerificationHistory({ uri }), { uri: uri.toString(), observations: 10, reviewed: 4 });
    const content = await fs.readFile(full, 'utf8');
    const report = JSON.parse(content);
    assert.equal(report.format, 'RocketbrainTableCopyVerificationHistory');
    assert.equal(report.version, 1);
    assert.ok(Number.isFinite(Date.parse(report.exportedAt)));
    assert.deepEqual(report.observations, await tools.listTransferVerificationEvidence());
    assert.doesNotMatch(content, /rb_verify_|9007199254740993|127\.0\.0\.1|private_hash|"password"|"samples"|"observationHash"/);
    await assert.rejects(tools.exportTransferVerificationHistory({ uri }), /preserve the existing export/);
    assert.equal(await fs.readFile(full, 'utf8'), content);
    assert.deepEqual(await tools.exportTransferVerificationHistory({ uri: captureUri, captureId: filteredCapture }),
      { uri: captureUri.toString(), observations: 4, reviewed: 1 });
    const scoped = JSON.parse(await fs.readFile(filtered, 'utf8'));
    assert.ok(scoped.observations.every(entry => entry.captureId === filteredCapture));
  } finally {
    for (const file of [full, filtered]) await fs.unlink(file).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
    await fs.rmdir(temporary);
  }
  checks.push('Operator decisions rejected obsolete evidence and retained replay fences for both actual database directions. Full and scoped redacted JSON exports read the same durable review evidence without a destination connection.');
  return {
    ...result, operatorReviews: reopened.reviewed, reviewDecisions: reopened.decisions, staleReviewRejected: true,
    replayFencePreserved: true, exportRedacted: true, exportNoOverwrite: true, scopedExport: true
  };
}

module.exports = { runTableTransferReviewChecks, checkTransferReviewRestart };
