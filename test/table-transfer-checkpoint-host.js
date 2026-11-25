'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { runTableTransferFullChecks, checkFullTransferRestart } = require('./table-transfer-full-host');

async function checkRuns(api, vscode) {
  const runs = await api.tableTransfer.listTransferVerificationRuns();
  const cancelled = runs.filter(run => run.state === 'cancelled');
  const complete = runs.filter(run => run.state === 'complete');
  assert.equal(runs.length, 8);
  assert.equal(cancelled.length, 2);
  assert.equal(complete.length, 6);
  assert.ok(cancelled.every(run => run.rows === 144 && run.checkedKeys === 16 && run.pages === 1));
  assert.ok(complete.every(run => run.rows === 144 && run.checkedKeys === 144 && run.pages === 9));
  assert.ok(cancelled.every(previous => complete.some(run => run.captureId === previous.captureId && run.runId !== previous.runId)));
  const displayed = await vscode.commands.executeCommand('rocketbrain.data.showTransferVerificationRuns');
  assert.deepEqual(displayed, runs);
  const { document } = vscode.window.activeTextEditor;
  assert.equal(document.uri.scheme, 'rocketbrain-table-copy-runs');
  assert.match(document.getText(), /16 \/ 144 keys examined · 1 pages/);
  assert.match(document.getText(), /Each attempt opens a fresh read-only destination snapshot/);
  assert.doesNotMatch(document.getText(), /rb_full_|9007199254740993|127\.0\.0\.1/);
  const checkpointHistorySha256 = createHash('sha256').update(JSON.stringify(runs)).digest('hex');
  return { verificationRuns: runs.length, cancelledRuns: cancelled.length, completeRuns: complete.length, checkpointHistorySha256 };
}

async function checkTransferCheckpointRestart(api, vscode) {
  return { ...await checkFullTransferRestart(api, vscode), ...await checkRuns(api, vscode) };
}

async function runTableTransferCheckpointChecks(api, vscode, checks) {
  const tools = api.tableTransfer, recoverySql = [];
  const original = await runTableTransferFullChecks(api, vscode, checks, {
    async beforeFollowUp(captureId) {
      await assert.rejects(tools.prepareTransferRecoverySql({ captureId }), /mark the latest discrepancy for follow-up/);
    },
    async onFollowUp({ captureId, target, from, to, changed, missing, columns }) {
      await api.connectMysql(from.config);
      await assert.rejects(tools.prepareTransferRecoverySql({ captureId }), /destination-identity-changed/);
      await api.connectMysql(to.config);
      const plan = await vscode.commands.executeCommand('rocketbrain.data.previewTransferRecoverySql', captureId);
      assert.ok(plan);
      assert.equal(plan.destination.engine, to.engine);
      assert.equal(plan.executable, false);
      assert.equal(plan.replayBlocked, true);
      assert.equal(plan.historicalCommitConfirmed, false);
      assert.deepEqual(await tools.validateTransferRecoverySql({ reviewId: plan.reviewId }), plan);
      const { document } = vscode.window.activeTextEditor;
      assert.equal(document.uri.scheme, 'rocketbrain-table-copy-recovery-sql');
      assert.match(document.getText(), /LEFT JOIN .* AS rb_existing .* WHERE rb_existing\.\`id\` IS NULL/);
      assert.match(document.getText(), /AS BINARY\) <=> CAST\(\? AS BINARY\)/);
      assert.doesNotMatch(document.getText(), /9007199254740993|later destination edit|127\.0\.0\.1/);

      const [audit, insert, update] = plan.statements;
      assert.deepEqual(plan.statements.map(item => item.kind), ['audit-key', 'insert-missing-key', 'update-unchanged-key']);
      const readKey = async row => (await target.execute(audit.sql, row.slice(0, 2)))[0];
      const rows = await readKey(changed);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].note, 'later destination edit');
      assert.equal(Number(rows[0][audit.overflowFlag]), 0);
      assert.equal((await readKey(missing)).length, 0);
      const apply = async (statement, desired, observed = {}) => {
        const values = statement.parameters.map(parameter =>
          parameter.value === 'observed-value' ? observed[parameter.column] : desired[columns.indexOf(parameter.column)]);
        return (await target.execute(statement.sql, values))[0].affectedRows;
      };
      // Execute reviewed templates only in the fixture transaction, then roll back.
      await target.beginTransaction();
      try {
        assert.equal(await apply(insert, changed), 0);
        assert.equal(await apply(insert, missing), 1);
        assert.equal(await apply(update, changed, { ...rows[0], note: 'LATER DESTINATION EDIT' }), 0);
        assert.equal(await apply(update, changed, rows[0]), 1);
        assert.equal((await readKey(changed))[0].note, changed[2]);
        assert.equal((await readKey(missing)).length, 1);
      } finally { await target.rollback(); }
      assert.equal((await readKey(changed))[0].note, 'later destination edit');
      assert.equal((await readKey(missing)).length, 0);
      return async () => {
        await assert.rejects(tools.validateTransferRecoverySql({ reviewId: plan.reviewId }), /unconfirmed|unavailable|retained/i);
        recoverySql.push({ destinationEngine: to.engine, auditRows: 1, guardedInsert: true, guardedUpdate: true,
          blockedBeforeReview: true, blockedWrongDestination: true, blockedAfterDiscard: true });
      };
    }
  });
  const runs = await checkRuns(api, vscode);
  checks.push('Cancelled full-range verification retained its first checked page. Fresh read-only attempts completed independently.');
  checks.push('Follow-up-reviewed, qualified recovery templates matched live MySQL and MariaDB. Fixture transactions proved missing-key and exact-value guards, then rolled back.');
  return { ...original, ...runs, recoverySql };
}

module.exports = { runTableTransferCheckpointChecks, checkTransferCheckpointRestart };
