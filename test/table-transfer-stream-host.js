'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const mysql = require('mysql2/promise');

function owned(configPath) {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const marker = JSON.parse(fs.readFileSync(path.join(path.dirname(configPath), 'owner.json'), 'utf8'));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(marker.kind));
  assert.equal(config.host, '127.0.0.1');
  return config;
}

async function runStreamingTableTransferChecks(api, vscode, checks) {
  const pair = JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_COORDINATOR_TEST_CONFIG, 'utf8'));
  assert.equal(pair.format, 'RocketbrainOwnedPairedSpringFixtures');
  assert.equal(pair.version, 1);
  assert.deepEqual(pair.participants.map(item => item.engine).sort(), ['mariadb', 'mysql']);
  const springIsolation = { people: 2, departments: 1, rolledBackNames: 0 };
  const probe = async () => {
    for (const { baseUrl } of pair.participants) {
      const url = new URL('/probe/testing-state', baseUrl);
      assert.equal(url.hostname, '127.0.0.1');
      const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
      assert.ok(response.ok);
      assert.deepEqual(await response.json(), springIsolation);
    }
  };
  const tools = api.tableTransfer, directions = [];
  assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.data.captureTransferSource'));
  const rows = 768;
  const data = Array.from({ length: rows }, (_, index) => [
    (9007199254740993n + BigInt(index)).toString(),
    '12345678901234.' + String(index).padStart(6, '0'),
    'row ' + index + ' · 가나다 🍀\r\n' + 'exact-'.repeat(250),
    index % 19 === 0 ? null : index % 23 === 0 ? Buffer.alloc(0) : Buffer.from([0, index % 251, 255]),
    '2026-11-12 01:02:03.' + String(index).padStart(6, '0')
  ]);
  const expected = data.map(([id, amount, memo, payload, day]) => [id, amount, memo, payload?.toString('hex').toUpperCase() ?? null, day]);
  const connection = config => mysql.createConnection({ ...config, rowsAsArray: true, supportBigNumbers: true, bigNumberStrings: true, dateStrings: true });
  await probe();
  for (const from of pair.participants) {
    const to = pair.participants.find(item => item.engine !== from.engine);
    const sourceConfig = owned(from.configPath), targetConfig = owned(to.configPath);
    const source = await connection(sourceConfig), target = await connection(targetConfig);
    const suffix = randomBytes(5).toString('hex'), fromTable = 'rb_stream_from_' + suffix, toTable = 'rb_stream_into_' + suffix;
    let capture, changed = false, switched = false;
    const count = async () => Number((await target.query('SELECT COUNT(*) FROM ' + toTable))[0][0][0]);
    const mapping = [{ source: 'id', target: 'target_id' }, { source: 'amount', target: 'amount' },
      { source: 'memo', target: 'memo' }, { source: 'payload', target: 'payload' }, { source: 'day', target: 'day' }];
    const preview = async () => {
      const destination = await tools.inspectDestination({ captureId: capture.id, table: toTable });
      assert.equal(destination.engine, to.engine);
      assert.notEqual(destination.scope, capture.scope);
      const plan = await tools.preview({ captureId: capture.id, destinationId: destination.id, mapping });
      assert.equal(plan.rowsIncluded, false);
      assert.equal(plan.rowCount, rows);
      return plan.reviewId;
    };
    try {
      await source.query('CREATE TABLE ' + fromTable + ' (id BIGINT PRIMARY KEY, amount DECIMAL(20,6), memo LONGTEXT, payload VARBINARY(16), `day` DATETIME(6)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
      await target.query('CREATE TABLE ' + toTable + ' (target_id BIGINT PRIMARY KEY, amount DECIMAL(20,6), memo LONGTEXT, payload VARBINARY(32), `day` DATETIME(6)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
      for (let offset = 0; offset < rows; offset += 64) {
        const batch = data.slice(offset, offset + 64);
        await source.execute('INSERT INTO ' + fromTable + ' VALUES ' + batch.map(() => '(?,?,?,?,?)').join(','), batch.flat());
      }
      await api.connectMysql(sourceConfig);
      switched = true;
      await assert.rejects(tools.capture({ table: fromTable }), /500 source rows/);
      capture = await tools.capture({ table: fromTable, mode: 'stream', onProgress: async ({ rows: observed }) => {
        if (changed || observed < 128) return;
        changed = true;
        await source.execute('UPDATE ' + fromTable + ' SET memo=? WHERE id=?', ['changed during stream', data.at(-1)[0]]);
      } });
      assert.equal(changed, true);
      assert.equal(capture.engine, from.engine);
      assert.equal(capture.mode, 'stream');
      assert.equal(capture.rowCount, rows);
      assert.ok(capture.encryptedBytes > 1024 * 1024);
      assert.ok(capture.maxFrameBytes < 4096 && capture.maxBufferedRows <= 1);
      assert.equal(Object.hasOwn(capture, 'rows'), false);
      assert.equal(Object.hasOwn(capture, 'spool'), false);
      assert.equal(JSON.stringify(capture).includes(data[0][2]), false);
      assert.deepEqual((await source.execute('SELECT memo FROM ' + fromTable + ' WHERE id=?', [data.at(-1)[0]]))[0], [['changed during stream']]);
      await api.connectMysql(targetConfig);
      const cancel = new AbortController();
      const cancelled = await tools.run({ reviewId: await preview(), cancellation: cancel.signal, onProgress: async ({ rows: written }) => {
        assert.ok(written > 0);
        assert.equal(await count(), 0);
        cancel.abort();
      } });
      assert.equal(cancelled.state, 'cancelled', cancelled.error?.message);
      assert.equal(cancelled.rolledBack, true);
      assert.ok(cancelled.rows > 0);
      assert.equal(await count(), 0);

      const rollback = await tools.run({ reviewId: await preview() });
      assert.equal(rollback.state, 'awaiting-commit', rollback.error?.message);
      assert.equal(await count(), 0);
      assert.equal((await tools.settle({ transactionId: rollback.transactionId, commit: false })).state, 'rolled-back');
      assert.equal(await count(), 0);

      const staged = await tools.run({ reviewId: await preview() });
      assert.equal(staged.state, 'awaiting-commit', staged.error?.message);
      assert.equal(staged.rows, rows);
      assert.ok(staged.batches > 1);
      assert.ok(staged.maxBatchRows <= 100 && staged.maxBatchBytes <= 1024 * 1024);
      assert.equal(await count(), 0);
      assert.equal((await tools.settle({ transactionId: staged.transactionId, commit: true })).state, 'committed');
      assert.deepEqual((await target.query('SELECT target_id,amount,memo,HEX(payload),`day` FROM ' + toTable + ' ORDER BY target_id'))[0], expected);
      directions.push({ sourceEngine: from.engine, destinationEngine: to.engine, rows,
        encryptedBytes: capture.encryptedBytes, maxSourceFrameBytes: capture.maxFrameBytes, maxBufferedRows: capture.maxBufferedRows,
        maxDestinationBatchRows: staged.maxBatchRows, maxDestinationBatchBytes: staged.maxBatchBytes,
        snapshotSurvivedLiveWrite: true, cancellationRolledBack: true, explicitRollback: true, independentlyInvisibleBeforeCommit: true,
        exactCommitted: true });
    } finally {
      try {
        if (tools.pending()) await tools.settle({ transactionId: tools.pending().transactionId, commit: false });
        if (capture) tools.discardSource(capture.id);
        if (switched) await api.disconnectMysql();
      } finally {
        try { await source.query('DROP TABLE IF EXISTS ' + fromTable); }
        finally { await source.end(); }
        try { await target.query('DROP TABLE IF EXISTS ' + toTable); }
        finally { await target.end(); }
      }
    }
    await probe();
  }
  checks.push('MySQL to MariaDB and MariaDB to MySQL each streamed 768 rows beyond the in-memory limit. Captures preserved a read-only snapshot during a concurrent change, and encrypted spill plus destination batches stayed within observed bounds.');
  checks.push('Cancellation after writes and explicit rollback left zero visible rows. Commit exposed all exact BIGINT, DECIMAL, multiline UTF-8, nullable and empty binary, and DATETIME(6) values. Both Spring fixtures remained unchanged.');
  return { directions, springIsolation };
}

module.exports = { runStreamingTableTransferChecks };
