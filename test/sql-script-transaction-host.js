'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const mysql = require('mysql2/promise');
const { MysqlService } = require('../src/db/mysql');
const { jdbcReadback } = require('./java-source-analysis-host');

async function withFixture(exercise) {
  const runtime = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const config = JSON.parse(await fs.readFile(runtime.dbConfigPath, 'utf8'));
  const owner = JSON.parse(await fs.readFile(path.join(path.dirname(runtime.dbConfigPath), 'owner.json'), 'utf8'));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(owner.kind));
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.database, 'rocketbrain_fixture');
  const actor = await mysql.createConnection(config);
  const table = 'rb_script_transaction_' + randomBytes(5).toString('hex');
  try {
    await actor.query('CREATE TABLE ' + table + ' (id INT PRIMARY KEY, label VARCHAR(40)) ENGINE=InnoDB');
    const jdbc = await jdbcReadback();
    assert.deepEqual(jdbc, { people: 2, departments: 1, rolledBackNames: 0 });
    const [[{ version }]] = await actor.query('SELECT VERSION() version');
    return { engine: runtime.dbEngine, version, jdbc, ...await exercise({ config, table, actor }) };
  } finally {
    try { await actor.query('DROP TABLE IF EXISTS ' + table); }
    finally { await actor.end(); }
  }
}

async function exerciseBlock({ preview, run, table, actor, withExistingTransaction }) {
  const insert = (id, label) => `INSERT INTO ${table} (id,label) VALUES (${id},'${label}');`;
  const selected = () => `SELECT id,label FROM ${table} ORDER BY id;`;
  const rows = async () => (await actor.query(selected()))[0].map(({ id, label }) => [id, label]);
  const batch = (...parts) => ['BEGIN;', ...parts].join('\n');
  const commit = batch(insert(1, 'preserved'), 'SAVEPOINT MyPoint;', insert(2, 'undone'),
    'SAVEPOINT discarded;', 'ROLLBACK TO SAVEPOINT MYPOINT;', 'RELEASE SAVEPOINT myPoint;', selected(), 'COMMIT;');
  const plan = await preview(commit);
  assert.deepEqual(plan.transactionBlock, { mode: 'read-write', finish: 'commit', requiresCommitApproval: true });
  await assert.rejects(run(plan, false), /approve committing/i);
  assert.deepEqual(await rows(), []);
  const committed = await run(plan, true);
  assert.equal(committed.transactionOutcome, 'committed', JSON.stringify(committed.statements.map(entry => entry.error)));
  assert.equal(committed.state, 'completed');
  assert.equal(committed.stateAfter.inTransaction, false);
  assert.deepEqual(committed.statements[7].result.rows, [[1, 'preserved']]);
  assert.deepEqual(await rows(), [[1, 'preserved']]);
  await assert.rejects(run(plan, true), /expired|consumed/i);

  const plannedRollback = await run(await preview(batch(insert(3, 'rollback'), 'ROLLBACK;')));
  assert.equal(plannedRollback.transactionOutcome, 'rolled-back');
  assert.deepEqual(await rows(), [[1, 'preserved']]);
  const readPlan = await preview(['START TRANSACTION READ ONLY;', selected(), 'COMMIT;'].join('\n'));
  assert.equal(readPlan.transactionBlock.requiresCommitApproval, false);
  const read = await run(readPlan);
  assert.equal(read.transactionOutcome, 'committed');
  assert.deepEqual(read.statements[1].result.rows, [[1, 'preserved']]);

  const failing = batch(insert(4, 'before failure'), insert(1, 'duplicate'), insert(5, 'unreached'), 'COMMIT;');
  const rolledBack = await run(await preview(failing), true);
  assert.equal(rolledBack.state, 'failed');
  assert.equal(rolledBack.transactionOutcome, 'rolled-back-after-stop');
  assert.equal(rolledBack.statements[2].error.code, 'ER_DUP_ENTRY');
  assert.equal(rolledBack.statements[3].status, 'not-run');
  assert.equal(rolledBack.stateAfter.inTransaction, false);
  assert.deepEqual(await rows(), [[1, 'preserved']]);
  await assert.rejects(preview(batch('SELECT 1;', 'ALTER TABLE ' + table + ' ADD extra INT;', 'COMMIT;')), /outside this reviewed transaction/);
  await assert.rejects(preview(batch('SELECT @external;', 'COMMIT;')), /variable operations/);
  await withExistingTransaction(sql => assert.rejects(preview(sql), /idle autocommit/), commit);

  const reviewed = await preview(batch(insert(6, 'stale'), 'COMMIT;'));
  await actor.query('ALTER TABLE ' + table + ' ADD COLUMN extra INT');
  await assert.rejects(run(reviewed, true), { code: 'ROCKETBRAIN_SCRIPT_STALE' });
  assert.deepEqual(await rows(), [[1, 'preserved']]);
  return { commitApproval: true, visibleCommit: true, rollbackToSavepoint: true, oneShot: true,
    plannedRollback: true, readOnlyBlock: true, failureRolledBack: true, priorTransactionKept: true, changedTableRefused: true };
}

async function verifyReviewedTransactionBackend() {
  return withFixture(async ({ config, table, actor }) => {
    const service = new MysqlService(config);
    try {
      await service.setReadOnly(false);
      const preview = sql => service.previewScript(sql);
      return await exerciseBlock({ table, actor, preview,
        run: (plan, approval) => service.runScript({ reviewId: plan.reviewId, allowTransactionCommit: approval }),
        async withExistingTransaction(check, sql) {
          await service.begin();
          try {
            await check(sql);
            assert.equal(service.getSessionState().inTransaction, true);
          } finally { await service.rollback(); }
        }
      });
    } finally { await service.dispose(); }
  });
}

async function runReviewedTransactionChecks(api, vscode, checks) {
  return withFixture(async ({ config, table, actor }) => {
    await api.connectMysql(config);
    const sessions = new Set();
    let existingSession;
    try {
      async function preview(sql) {
        const document = await vscode.workspace.openTextDocument({ language: 'sql', content: sql });
        const binding = await api.describeSqlScript('SELECT 1;', { document });
        const { sessionId } = binding;
        sessions.add(sessionId);
        await api.configureConsoleSession(sessionId, { readOnly: false, autocommit: true });
        if (existingSession) {
          await api.controlConsoleSession(sessionId, 'begin');
          existingSession.id = sessionId;
        }
        const description = await api.sqlScripts.describe(document);
        return api.sqlScripts.preview(description.id);
      }
      const verified = await exerciseBlock({ table, actor, preview,
        async run(plan, approval) {
          const result = await api.sqlScripts.run(plan.id, { allowTransactionCommit: approval });
          assert.deepEqual(api.results().find(item => item.id === result.resultId).result.rows.at(-1),
            ['Transaction', result.transactionOutcome, 0, 0, 0, '']);
          return result;
        },
        async withExistingTransaction(check, sql) {
          existingSession = {};
          try {
            await check(sql);
            assert.equal(api.sessions().find(session => session.id === existingSession.id).inTransaction, true);
          } finally {
            if (existingSession.id) await api.controlConsoleSession(existingSession.id, 'rollback');
            existingSession = undefined;
          }
        }
      });
      checks.push('A reviewed native SQL batch preserved a committed row, undid savepoint work, and rolled back failed or stale batches.');
      return { ...verified, nativeResultSummary: true };
    } finally {
      for (const session of sessions) await api.closeConsoleSession(session);
      await api.disconnectMysql();
    }
  });
}

if (require.main === module) verifyReviewedTransactionBackend().then(value => console.log(JSON.stringify(value)),
  error => { console.error(error.stack); process.exitCode = 1; });

module.exports = { runReviewedTransactionChecks, verifyReviewedTransactionBackend };
