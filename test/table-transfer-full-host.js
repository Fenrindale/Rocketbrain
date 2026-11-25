'use strict';

const assert = require('node:assert/strict');
const { createHash, randomBytes } = require('node:crypto');
const mysql = require('mysql2/promise');
const { participants, probe, loseCommitAcknowledgement } = require('./table-transfer-verification-host');

const rows = 144;
const pageSize = 16;
const maxUnsigned = '18446744073709551615';
const springIsolation = { people: 2, departments: 1, rolledBackNames: 0 };
const names = ['id', 'label', 'note', 'cost', 'payload'];
const targetFields = 'id BIGINT UNSIGNED NOT NULL, label VARCHAR(16) NOT NULL, note VARCHAR(100), ' +
  'cost DECIMAL(24,6), payload VARBINARY(8), PRIMARY KEY(id,label)';
const sourceFields = 'src_note VARCHAR(100), src_label VARCHAR(16) NOT NULL, src_id BIGINT UNSIGNED NOT NULL, ' +
  'src_payload VARBINARY(8), src_cost DECIMAL(24,6), PRIMARY KEY(src_id,src_label)';

async function checkFullTransferRestart(api, vscode) {
  await assert.rejects(api.databaseCatalog(), /Connect to MySQL or MariaDB/);
  const evidence = await api.tableTransfer.listTransferVerificationEvidence();
  assert.equal(evidence.length, 8);
  const full = evidence.filter(item => item.method === 'full-mapped-keys');
  const reviewed = evidence.filter(item => item.review);
  assert.equal(full.length, 6);
  assert.equal(reviewed.length, 2);
  assert.deepEqual(full.map(item => item.status).sort(), ['matching', 'matching', 'mismatch', 'mismatch', 'missing', 'missing']);
  assert.ok(full.every(item => item.checkedKeys === rows && item.sampledKeys === 0 && item.pages === rows / pageSize &&
    item.coverage === 'all-reviewed-keys' && item.replayBlocked && !item.historicalCommitConfirmed));
  assert.ok(reviewed.every(item => item.review.decision === 'follow-up-required' && item.mismatch === 1 && item.missing === 1));
  const captureId = reviewed[0].captureId;
  const plan = await vscode.commands.executeCommand('rocketbrain.data.previewTransferRecovery', captureId);
  assert.ok(plan);
  assert.equal(plan.observation.observationId, reviewed[0].observationId);
  assert.equal(plan.snapshot.retained, false);
  assert.equal(plan.executable, false);
  assert.equal(plan.replayBlocked, true);
  assert.equal(plan.historicalCommitConfirmed, false);
  assert.equal(vscode.window.activeTextEditor.document.uri.scheme, 'rocketbrain-table-copy-recovery');
  assert.match(vscode.window.activeTextEditor.document.getText(), /144 \/ 144 keys checked/);
  assert.match(vscode.window.activeTextEditor.document.getText(), /Mark for Follow-up/);
  assert.doesNotMatch(vscode.window.activeTextEditor.document.getText(), /rb_full|9007199254740993|127\.0\.0\.1/);
  const canonical = value => JSON.stringify(value, Object.keys(value).sort());
  const historySha256 = createHash('sha256').update(JSON.stringify(evidence.map(({ review, ...item }) =>
    [canonical(item), review ? canonical(review) : '']).sort(([a], [b]) => a.localeCompare(b)))).digest('hex');
  return { observations: evidence.length, fullObservations: full.length, reviewed: reviewed.length, historySha256, disconnected: true };
}

async function runTableTransferFullChecks(api, vscode, checks, { beforeFollowUp, onFollowUp } = {}) {
  const engines = participants(), tools = api.tableTransfer, directions = [];
  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes('rocketbrain.data.verifyAllTransferKeys') && commands.includes('rocketbrain.data.previewTransferRecovery'));
  await probe(engines);
  for (const from of engines) {
    const to = engines.find(item => item.engine !== from.engine);
    const source = await mysql.createConnection(from.config), target = await mysql.createConnection(to.config);
    const suffix = randomBytes(5).toString('hex'), origin = 'rb_full_src_' + suffix;
    const committed = 'rb_full_yes_' + suffix, absent = 'rb_full_no_' + suffix;
    const saved = [];
    const data = Array.from({ length: rows }, (_, index) => [index === rows - 1 ? maxUnsigned : (9007199254740993n + BigInt(index)).toString(), 'same key',
      index % 7 ? '문자 🍀 ' + index + '\r\n' : null, '123456789012345678.' + String(index).padStart(6, '0'),
      index % 9 ? Buffer.from([0, 255, index]) : null]);
    const asNumber = async table => Number((await target.query('SELECT COUNT(*) AS total FROM ' + table))[0][0].total);
    const stage = async (table, send) => {
      await api.connectMysql(from.config);
      const capture = await tools.capture({ table: origin, mode: 'stream', recoverable: true });
      const captureId = capture.id;
      saved.push(captureId);
      await assert.rejects(tools.verifyAllTransferKeys({ captureId }), /no unconfirmed/);
      await api.connectMysql(to.config);
      const binding = await tools.inspectDestination({ captureId, table });
      const mapping = names.map(name => ({ source: 'src_' + name, target: name }));
      const plan = await tools.preview({ captureId, destinationId: binding.id, mapping });
      assert.equal(await loseCommitAcknowledgement(api, plan.reviewId, send), captureId);
      assert.equal((await tools.listRecoverableSources()).find(value => value.id === captureId).fullVerificationAvailable, true);
      return captureId;
    };
    const verify = async (captureId, expected) => {
      const states = [];
      const report = await tools.verifyAllTransferKeys({ captureId, onProgress: progress => states.push(progress) });
      const checkpoint = JSON.stringify({ report, lastProgress: states.at(-1) });
      assert.equal(report.method, 'full-mapped-keys', checkpoint);
      assert.equal(report.coverage, 'all-reviewed-keys', checkpoint);
      assert.deepEqual([report.status, report.checkedKeys, report.pages, report.sampledKeys, report.comparedMappedColumns],
        [expected.status, rows, rows / pageSize, 0, 5], JSON.stringify(report));
      assert.deepEqual([report.matching, report.missing, report.mismatch], expected.counts);
      assert.equal(report.historyRecorded, true);
      assert.equal(report.replayBlocked, true);
      assert.equal(report.historicalCommitConfirmed, false);
      assert.deepEqual(states.map(({ stage, checkedKeys }) => [stage, checkedKeys]),
        [['inspect-destination', 0],
          ...Array.from({ length: rows / pageSize }, (_, i) => ['compare-page', (i + 1) * pageSize]), ['complete', rows]]);
      return report;
    };
    try {
      await source.query('CREATE TABLE ' + origin + ' (' + sourceFields + ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
      for (const table of [committed, absent]) {
        await target.query('CREATE TABLE ' + table + ' (' + targetFields + ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
      }
      await source.execute('INSERT INTO ' + origin + ' (src_id, src_label, src_note, src_cost, src_payload) VALUES ' +
        data.map(() => '(?,?,?,?,?)').join(','), data.flat());
      const captureId = await stage(committed, true);
      assert.equal(await asNumber(committed), rows);
      const [maximum] = await target.query('SELECT CAST(MAX(id) AS CHAR) AS id FROM ' + committed);
      assert.equal(maximum[0].id, maxUnsigned);
      const cancellation = new AbortController();
      let cancelledAt;
      await assert.rejects(tools.verifyAllTransferKeys({ captureId, cancellation: cancellation.signal, onProgress: state => {
        if (state.stage === 'compare-page') {
          cancelledAt = state.checkedKeys;
          cancellation.abort();
        }
      } }), /verification cancelled/i);
      assert.equal(cancelledAt, pageSize);
      assert.deepEqual(await tools.listTransferVerificationHistory({ captureId }), []);
      await verify(captureId, { status: 'matching', counts: [rows, 0, 0] });
      const originalPlan = await tools.prepareTransferRecoveryPlan({ captureId });
      assert.equal(originalPlan.snapshot.fullVerificationAvailable, true);
      assert.deepEqual(await tools.validateTransferRecoveryPlan({ planId: originalPlan.planId }), originalPlan);

      const sampled = new Set(Array.from({ length: 128 }, (_, i) => Math.floor(i * (rows - 1) / 127)));
      const [changed, missing] = data.filter((_, i) => !sampled.has(i));
      await target.execute('UPDATE ' + committed + ' SET note=? WHERE id = CAST(? AS DECIMAL(20,0)) AND label=?',
        ['later destination edit', ...changed.slice(0, 2)]);
      await target.execute('DELETE FROM ' + committed + ' WHERE id = CAST(? AS DECIMAL(20,0)) AND label=?', missing.slice(0, 2));
      await target.execute('INSERT INTO ' + committed + ' (id,label) VALUES (?,?)', ['18446744073709551614', 'independent']);
      assert.equal(await asNumber(committed), rows);
      const partial = await tools.verifyUncertainCommit({ captureId });
      assert.deepEqual([partial.status, partial.checkedKeys], ['matching', 128]);
      await assert.rejects(tools.validateTransferRecoveryPlan({ planId: originalPlan.planId }), /evidence or the retained snapshot changed/i);
      await verify(captureId, { status: 'mismatch', counts: [rows - 2, 1, 1] });
      const priorReview = await tools.prepareTransferRecoveryPlan({ captureId });
      assert.ok(priorReview.steps.includes('review-observation'));
      await beforeFollowUp?.(captureId);
      const review = await tools.prepareTransferVerificationReview({ captureId });
      await tools.recordTransferVerificationReview({ reviewId: review.reviewId, decision: 'follow-up-required' });
      await assert.rejects(tools.validateTransferRecoveryPlan({ planId: priorReview.planId }), /evidence or the retained snapshot changed/i);
      const next = await tools.prepareTransferRecoveryPlan({ captureId });
      assert.ok(next.steps.includes('investigate-missing-keys') && next.steps.includes('investigate-different-values'));
      assert.equal(next.observation.review.decision, 'follow-up-required');
      const afterDiscard = await onFollowUp?.({ captureId, target, from, to, changed, missing, columns: names });
      await assert.rejects(tools.resumeSource({ captureId }), /previous Commit/);
      await tools.discardRecoverableSource({ captureId });
      await assert.rejects(tools.validateTransferRecoveryPlan({ planId: next.planId }), /evidence or the retained snapshot changed/i);
      await afterDiscard?.();

      const missingId = await stage(absent, false);
      await verify(missingId, { status: 'missing', counts: [0, rows, 0] });
      assert.equal(await asNumber(absent), 0);
      assert.equal(await asNumber(committed), rows);
      await assert.rejects(tools.resumeSource({ captureId: missingId }), /previous Commit/);
      directions.push({ sourceEngine: from.engine, destinationEngine: to.engine, rows, verifiedKeys: rows, mappedColumns: 5,
        pages: rows / pageSize, fullyMatchedAfterLostAck: true, detectedUnsampledKeys: true, allKeysMissingWithoutCommit: true,
        cancellationDidNotRecord: true, stalePlanRejected: true, reviewedPlan: true, replayFencePreserved: true, unsignedMaximumVerified: true });
    } finally {
      if (tools.pending()) await tools.settle({ transactionId: tools.pending().transactionId, commit: false });
      for (const captureId of saved) await tools.discardRecoverableSource({ captureId });
      await api.disconnectMysql();
      try { await source.query('DROP TABLE IF EXISTS ' + origin); }
      finally { await source.end(); }
      try { for (const table of [committed, absent]) await target.query('DROP TABLE IF EXISTS ' + table); }
      finally { await target.end(); }
    }
  }
  await probe(engines);
  const evidence = await checkFullTransferRestart(api, vscode);
  checks.push('Complete read-only verification compared 144 reviewed keys in nine pages per direction. It found missing and changed unsampled keys, preserved the replay fence and made stale previews unusable.');
  return { directions, historyObservations: evidence.observations, recoveryReviews: evidence.reviewed, springIsolation };
}

module.exports = { runTableTransferFullChecks, checkFullTransferRestart };
