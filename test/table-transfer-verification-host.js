'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const mysql = require('mysql2/promise');

const springIsolation = { people: 2, departments: 1, rolledBackNames: 0 };
const columns = 'id BIGINT UNSIGNED NOT NULL, label VARCHAR(16) NOT NULL, note VARCHAR(100), ' +
  'cost DECIMAL(24,6), payload VARBINARY(8), PRIMARY KEY(id,label)';
const mapping = ['id', 'label', 'note', 'cost', 'payload'].map(name => ({ source: name, target: name }));
const safeRead = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const connect = config => mysql.createConnection({ ...config, rowsAsArray: true, supportBigNumbers: true, bigNumberStrings: true });

function participants() {
  const pair = safeRead(process.env.ROCKETBRAIN_COORDINATOR_TEST_CONFIG);
  assert.equal(pair.format, 'RocketbrainOwnedPairedSpringFixtures');
  assert.equal(pair.version, 1);
  assert.deepEqual(pair.participants.map(item => item.engine).sort(), ['mariadb', 'mysql']);
  for (const item of pair.participants) {
    const marker = safeRead(path.join(path.dirname(item.configPath), 'owner.json'));
    assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(marker.kind));
    item.config = safeRead(item.configPath);
    assert.equal(item.config.host, '127.0.0.1');
  }
  return pair.participants;
}

async function probe(engines) {
  for (const { baseUrl } of engines) {
    const url = new URL('/probe/testing-state', baseUrl);
    assert.equal(url.hostname, '127.0.0.1');
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    assert.ok(response.ok);
    assert.deepEqual(await response.json(), springIsolation);
  }
}

async function loseCommitAcknowledgement(api, reviewId, sendCommit) {
  let db, original, intercepted = 0, dispatched = 0;
  await api.withTableTransfer(async lease => {
    db = lease.db;
    original = db._control;
    db._control = async function (session, sql) {
      if (sql !== 'COMMIT' || !session.id.startsWith('__rocketbrain_import_')) return original.call(this, session, sql);
      intercepted++;
      if (sendCommit) {
        await original.call(this, session, sql);
        dispatched++;
      }
      throw new Error('Test fixture dropped the owned COMMIT acknowledgement.');
    };
  });
  try {
    const staged = await api.tableTransfer.run({ reviewId });
    assert.equal(staged.state, 'awaiting-commit', staged.error?.message);
    const report = await api.tableTransfer.settle({ transactionId: staged.transactionId, commit: true });
    assert.equal(intercepted, 1);
    assert.equal(dispatched, Number(sendCommit));
    assert.equal(report.state, 'uncertain');
    assert.equal(report.recoveryState, 'settlement-unconfirmed');
    return report.captureId;
  } finally { db._control = original; }
}

async function runTableTransferVerificationChecks(api, vscode, checks, { expanded = false, onVerification } = {}) {
  const engines = participants(), tools = api.tableTransfer, directions = [];
  const rows = expanded ? 144 : 48;
  const commands = await vscode.commands.getCommands(true);
  assert.equal(tools.canRecover, true);
  assert.ok(commands.includes('rocketbrain.data.verifyTransferDestination'));
  if (expanded) assert.ok(commands.includes('rocketbrain.data.transferVerificationHistory'));
  await probe(engines);
  for (const from of engines) {
    const to = engines.find(item => item.engine !== from.engine);
    const source = await connect(from.config), target = await connect(to.config);
    const suffix = randomBytes(5).toString('hex'), sourceTable = 'rb_verify_src_' + suffix;
    const committedTable = 'rb_verify_yes_' + suffix, missingTable = 'rb_verify_no_' + suffix;
    const saved = [];
    const count = async table => Number((await target.query('SELECT COUNT(*) FROM ' + table))[0][0][0]);
    const data = Array.from({ length: rows }, (_, index) => [(9007199254740993n + BigInt(index)).toString(), '키 ' + index,
      index % 7 ? '내용 🍀 ' + index + '\r\n' : null, '123456789012345678.' + String(index).padStart(6, '0'),
      index % 9 ? Buffer.from([0, 255, index]) : null]);
    let direction;
    const setup = async (table, sendCommit) => {
      await api.connectMysql(from.config);
      const capture = await tools.capture({ table: sourceTable, mode: 'stream', recoverable: true });
      saved.push(capture.id);
      await assert.rejects(tools.verifyUncertainCommit({ captureId: capture.id }), /no unconfirmed/);
      await api.connectMysql(to.config);
      const destination = await tools.inspectDestination({ captureId: capture.id, table });
      const plan = await tools.preview({ captureId: capture.id, destinationId: destination.id, mapping });
      assert.equal(await count(table), 0);
      assert.equal(await loseCommitAcknowledgement(api, plan.reviewId, sendCommit), capture.id);
      assert.ok(!tools.listSources().some(item => item.id === capture.id));
      return capture.id;
    };
    try {
      await source.query('CREATE TABLE ' + sourceTable + ' (' + columns + ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
      for (const table of [committedTable, missingTable]) await target.query('CREATE TABLE ' + table + ' (' + columns + ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
      await source.execute('INSERT INTO ' + sourceTable + ' VALUES ' + data.map(() => '(?,?,?,?,?)').join(','), data.flat());
      const matchingId = await setup(committedTable, true);
      assert.equal(await count(committedTable), rows);
      const listed = (await tools.listRecoverableSources()).find(item => item.id === matchingId);
      assert.deepEqual(listed.verificationTarget, { table: committedTable, database: to.config.database, engine: to.engine });
      const matching = await tools.verifyUncertainCommit({ captureId: matchingId });
      const sampleKeys = expanded ? 128 : Math.min(matching.keyLimit ?? 32, rows);
      assert.deepEqual([matching.status, matching.matching, matching.missing, matching.mismatch], ['matching', sampleKeys, 0, 0]);
      assert.equal(matching.coverage, sampleKeys < rows ? 'sampled-reviewed-keys' : 'all-reviewed-keys');
      if (expanded) assert.deepEqual([matching.checkedKeys, matching.keyLimit, matching.historyRecorded], [128, 128, true]);
      assert.equal(matching.historicalCommitConfirmed, false);
      assert.equal(matching.replayBlocked, true);
      assert.equal(matching.comparedMappedColumns, mapping.length);
      assert.ok(!Object.hasOwn(matching, 'samples') && !JSON.stringify(matching).includes(data[0][0]));
      await assert.rejects(tools.resumeSource({ captureId: matchingId }), /previous Commit/);
      await onVerification?.({ status: 'matching', captureId: matchingId, engine: from.engine });
      await api.connectMysql(from.config);
      const wrongTarget = await tools.verifyUncertainCommit({ captureId: matchingId });
      assert.equal(wrongTarget.reason, 'destination-identity-changed');
      if (expanded) assert.deepEqual([wrongTarget.checkedKeys, wrongTarget.coverage, wrongTarget.historyRecorded], [0, 'none', true]);
      await api.connectMysql(to.config);
      // The midpoint is covered by the expanded selection and was outside the original 32 selected ordinals.
      const changedRow = data[expanded ? 72 : 0];
      await target.execute('UPDATE ' + committedTable + ' SET note=? WHERE id=? AND label=?', ['changed by another session', ...changedRow.slice(0, 2)]);
      await target.execute('DELETE FROM ' + committedTable + ' WHERE id=? AND label=?', data.at(-1).slice(0, 2));
      const changed = await tools.verifyUncertainCommit({ captureId: matchingId });
      assert.deepEqual([changed.status, changed.matching, changed.missing, changed.mismatch], ['mismatch', sampleKeys - 2, 1, 1]);
      await target.query('ALTER TABLE ' + committedTable + ' ADD COLUMN later_col INTEGER NULL');
      const drift = await tools.verifyUncertainCommit({ captureId: matchingId });
      assert.deepEqual([drift.status, drift.reason], ['inconclusive', 'destination-definition-changed']);
      await onVerification?.({ status: 'inconclusive', captureId: matchingId, engine: from.engine });
      assert.equal(await count(committedTable), rows - 1);
      if (onVerification) await assert.rejects(tools.resumeSource({ captureId: matchingId }), /previous Commit/);

      const missingId = await setup(missingTable, false);
      const missing = await tools.verifyUncertainCommit({ captureId: missingId });
      assert.deepEqual([missing.status, missing.matching, missing.missing, missing.mismatch], ['missing', 0, sampleKeys, 0]);
      await onVerification?.({ status: 'missing', captureId: missingId, engine: from.engine });
      assert.equal(await count(missingTable), 0);
      await assert.rejects(tools.resumeSource({ captureId: missingId }), /previous Commit/);
      assert.ok((await tools.listRecoverableSources()).filter(item => saved.includes(item.id)).every(item => item.recoveryState === 'settlement-unconfirmed'));
      direction = { sourceEngine: from.engine, destinationEngine: to.engine, rows, sampledKeys: sampleKeys, mappedColumns: mapping.length,
        matchingAfterLostAck: true, missingWithoutDispatch: true, detectsChangedAndDeletedKeys: true, rejectsWrongIdentity: true,
        rejectsTableDrift: true, replayRemainsBlocked: true, historicalCommitConfirmed: false };
    } finally {
      if (tools.pending()) await tools.settle({ transactionId: tools.pending().transactionId, commit: false });
      for (const captureId of saved) await tools.discardRecoverableSource({ captureId });
      await api.disconnectMysql();
      try { await source.query('DROP TABLE IF EXISTS ' + sourceTable); }
      finally { await source.end(); }
      try { for (const table of [committedTable, missingTable]) await target.query('DROP TABLE IF EXISTS ' + table); }
      finally { await target.end(); }
    }
    if (expanded) {
      assert.ok(!(await tools.listRecoverableSources()).some(item => saved.includes(item.id)));
      const committed = await tools.listTransferVerificationHistory({ captureId: saved[0] });
      const absent = await tools.listTransferVerificationHistory({ captureId: saved[1] });
      assert.deepEqual(committed.map(item => item.status).sort(), ['inconclusive', 'inconclusive', 'matching', 'mismatch']);
      assert.deepEqual(absent.map(item => item.status), ['missing']);
      const recorded = JSON.stringify([...committed, ...absent]);
      for (const secret of [sourceTable, committedTable, missingTable, data[0][0], data[1][2], 'mysql', 'mariadb', 'destination":']) {
        assert.ok(!recorded.includes(secret));
      }
      assert.ok([...committed, ...absent].every(item => item.replayBlocked && !item.historicalCommitConfirmed));
      Object.assign(direction, { historyRetainedAfterDiscard: true, historyRedacted: true });
    }
    directions.push(direction);
  }
  await probe(engines);
  checks.push('Both MySQL/MariaDB directions checked mapped composite keys after a deliberately interrupted acknowledgement. Real committed, absent, changed, deleted, wrong-target, and schema-drift cases left the replay fence intact.');
  let historyObservations;
  if (expanded) {
    const entries = await vscode.commands.executeCommand('rocketbrain.data.transferVerificationHistory');
    assert.equal(entries.length, 10);
    const document = vscode.window.activeTextEditor?.document;
    assert.equal(document?.uri.scheme, 'rocketbrain-table-copy-history');
    assert.match(document.getText(), /128 \/ 144 keys checked \(sampled reviewed keys\)/);
    assert.match(document.getText(), /Different values/);
    assert.doesNotMatch(document.getText(), /rb_verify|9007199254740993/);
    historyObservations = entries.length;
    checks.push('Expanded verification checked 128 of 144 reviewed keys. The workspace history showed ten redacted observations after discarding their saved snapshots, with no live destination connection.');
  }
  return { directions, springIsolation, ...(expanded && { historyObservations }) };
}

module.exports = { runTableTransferVerificationChecks };
