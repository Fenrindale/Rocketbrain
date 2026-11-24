'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const mysql = require('mysql2/promise');

const rows = 575;
const columns = 'id INT PRIMARY KEY, b BIT(64), y YEAR, e ENUM(\'open\',\'닫힘\'), s SET(\'red\',\'green\',\'검정\'), raw BINARY(4), memo TEXT';
const projection = 'SELECT id,CAST(CAST(b AS UNSIGNED) AS CHAR),y,e,s,HEX(raw),memo FROM ';
const mapping = ['id', 'b', 'y', 'e', 's', 'raw', 'memo'].map(name => ({ source: name, target: name }));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const isolation = { people: 2, departments: 1, rolledBackNames: 0 };
const connection = config => mysql.createConnection({ ...config, rowsAsArray: true, supportBigNumbers: true, bigNumberStrings: true });

function participants() {
  const pair = read(process.env.ROCKETBRAIN_COORDINATOR_TEST_CONFIG);
  assert.equal(pair.format, 'RocketbrainOwnedPairedSpringFixtures');
  assert.equal(pair.version, 1);
  assert.deepEqual(pair.participants.map(item => item.engine).sort(), ['mariadb', 'mysql']);
  for (const item of pair.participants) {
    const marker = read(path.join(path.dirname(item.configPath), 'owner.json'));
    assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(marker.kind));
    item.config = read(item.configPath);
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
    assert.deepEqual(await response.json(), isolation);
  }
}

async function seedRecoverableTransfer(api, checks) {
  const engines = participants(), directions = [], tools = api.tableTransfer;
  assert.equal(tools.canRecover, true);
  await probe(engines);
  for (const from of engines) {
    const to = engines.find(item => item.engine !== from.engine);
    const suffix = randomBytes(5).toString('hex'), sourceTable = 'rb_resume_from_' + suffix, destinationTable = 'rb_resume_into_' + suffix;
    const source = await connection(from.config), destination = await connection(to.config);
    let capture;
    try {
      await source.query('CREATE TABLE ' + sourceTable + ' (' + columns + ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
      await destination.query('CREATE TABLE ' + destinationTable + ' (' + columns + ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
      const values = Array.from({ length: rows }, (_, i) => [i,
        i % 11 === 0 ? null : ((1n << 64n) - 1n - BigInt(i)).toString(),
        i % 13 === 0 ? null : [0, 1901, 2155, 2026][i % 4], i % 7 === 0 ? null : ['open', '닫힘'][i % 2],
        [null, '', 'red,검정', 'green,검정'][i % 4], i % 3 === 0 ? null : Buffer.from([0, 255, i % 256]),
        'saved row ' + i + ' · 가나다 🍀\r\n' + 'repeat-'.repeat(300)]);
      for (let offset = 0; offset < rows; offset += 60) {
        const batch = values.slice(offset, offset + 60);
        await source.execute('INSERT INTO ' + sourceTable + ' VALUES ' + batch.map(() => '(?,CAST(? AS UNSIGNED),?,?,?,?,?)').join(','), batch.flat());
      }
      const [sourceRows] = await source.query(projection + sourceTable + ' ORDER BY id');
      assert.deepEqual(sourceRows.slice(0, 5).map(row => row.slice(0, 6)), [
        [0, null, null, null, null, null], [1, '18446744073709551614', 1901, '닫힘', '', '00FF0100'],
        [2, '18446744073709551613', 2155, 'open', 'red,검정', '00FF0200'],
        [3, '18446744073709551612', 2026, '닫힘', 'green,검정', null], [4, '18446744073709551611', 0, 'open', null, '00FF0400']
      ]);
      await api.connectMysql(from.config);
      capture = await tools.capture({ table: sourceTable, mode: 'stream', recoverable: true });
      assert.equal(capture.recoveryState, 'ready');
      assert.equal(capture.rowCount, rows);
      assert.equal(capture.omittedColumns, 0);
      assert.ok(capture.encryptedBytes > 1024 * 1024);
      await source.execute('UPDATE ' + sourceTable + ' SET memo=? WHERE id=0', ['changed after sealing']);
      assert.equal(tools.discardSource(capture.id), true);
      assert.ok(!tools.listSources().some(item => item.id === capture.id));
      assert.ok((await tools.listRecoverableSources()).some(item => item.id === capture.id && item.recoveryState === 'ready'));
      directions.push({ sourceEngine: from.engine, destinationEngine: to.engine, sourceTable, destinationTable, captureId: capture.id,
        sourceHash: capture.sourceHash, expectedHash: digest(sourceRows), rows, encryptedBytes: capture.encryptedBytes });
    } catch (error) {
      if (capture) await tools.discardRecoverableSource({ captureId: capture.id });
      await source.query('DROP TABLE IF EXISTS ' + sourceTable);
      await destination.query('DROP TABLE IF EXISTS ' + destinationTable);
      throw error;
    } finally {
      await api.disconnectMysql();
      await source.end();
      await destination.end();
    }
  }
  checks.push('Both Spring database fixtures saved more than 500 rows in workspace-scoped encrypted snapshots and released their live source state.');
  return { format: 'RocketbrainSavedTransferFixture', version: 1, hostPid: process.pid, directions };
}

async function runResumableTableTransferChecks(api, vscode, checks) {
  const fromRestart = process.env.ROCKETBRAIN_TRANSFER_RESUME_SEED;
  const seed = fromRestart ? read(fromRestart) : await seedRecoverableTransfer(api, checks);
  assert.equal(seed.format, 'RocketbrainSavedTransferFixture');
  assert.equal(seed.version, 1);
  if (fromRestart) assert.notEqual(process.pid, seed.hostPid, 'the saved snapshots must be reopened by a distinct extension host');
  assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.data.transfer'));
  const engines = participants(), tools = api.tableTransfer, directions = [];
  assert.deepEqual(seed.directions.map(item => item.sourceEngine).sort(), ['mariadb', 'mysql']);
  await probe(engines);
  for (const { sourceEngine, destinationEngine, sourceTable, destinationTable, captureId, sourceHash, expectedHash, encryptedBytes } of seed.directions) {
    assert.match(sourceTable, /^rb_resume_from_[0-9a-f]{10}$/);
    assert.match(destinationTable, /^rb_resume_into_[0-9a-f]{10}$/);
    assert.equal(sourceTable.slice(-10), destinationTable.slice(-10));
    const source = await connection(engines.find(item => item.engine === sourceEngine).config);
    const targetConfig = engines.find(item => item.engine === destinationEngine).config, target = await connection(targetConfig);
    const count = async () => Number((await target.query('SELECT COUNT(*) FROM ' + destinationTable))[0][0][0]);
    try {
      assert.ok(!tools.listSources().some(item => item.id === captureId));
      const capture = await tools.resumeSource({ captureId });
      assert.equal(capture.rowCount, rows);
      assert.equal(capture.sourceHash, sourceHash);
      assert.equal(capture.encryptedBytes, encryptedBytes);
      assert.equal(capture.recoveryState, 'ready');
      assert.ok(!JSON.stringify(capture).includes('table-copy-snapshots'));
      await api.connectMysql(targetConfig);
      const review = async () => {
        const destination = await tools.inspectDestination({ captureId, table: destinationTable });
        const plan = await tools.preview({ captureId, destinationId: destination.id, mapping });
        assert.match(plan.sql, /CAST\(\? AS UNSIGNED\)/);
        assert.equal(plan.rowCount, rows);
        assert.equal(plan.automaticRetry, false);
        return plan.reviewId;
      };
      const cancel = new AbortController();
      const cancelled = await tools.run({ reviewId: await review(), cancellation: cancel.signal, onProgress: async () => {
        assert.equal(await count(), 0);
        cancel.abort();
      } });
      assert.equal(cancelled.state, 'cancelled', cancelled.error?.message);
      assert.equal(cancelled.rolledBack, true);
      assert.ok(cancelled.rows > 0);
      assert.equal(await count(), 0);
      const rolled = await tools.run({ reviewId: await review() });
      assert.equal(rolled.state, 'awaiting-commit', rolled.error?.message);
      assert.equal(await count(), 0);
      assert.equal((await tools.settle({ transactionId: rolled.transactionId, commit: false })).state, 'rolled-back');
      assert.ok((await tools.listRecoverableSources()).some(item => item.id === captureId && item.recoveryState === 'ready'));
      const staged = await tools.run({ reviewId: await review() });
      assert.equal(staged.state, 'awaiting-commit', staged.error?.message);
      assert.equal(await count(), 0);
      assert.equal((await tools.settle({ transactionId: staged.transactionId, commit: true })).state, 'committed');
      assert.equal(digest((await target.query(projection + destinationTable + ' ORDER BY id'))[0]), expectedHash);
      assert.ok(!(await tools.listRecoverableSources()).some(item => item.id === captureId));
      await assert.rejects(tools.resumeSource({ captureId }), /expired|unavailable/);
      directions.push({ sourceEngine, destinationEngine, rows, encryptedBytes, restoredSnapshotHash: sourceHash,
        cancelledAndRestarted: true, rolledBackAndRestarted: true, invisibleUntilCommit: true,
        exactTypes: ['BIT(64)', 'YEAR', 'ENUM', 'SET', 'BINARY(4)'], committedSnapshotRetired: true });
    } finally {
      if (tools.pending()) await tools.settle({ transactionId: tools.pending().transactionId, commit: false });
      await tools.discardRecoverableSource({ captureId });
      await api.disconnectMysql();
      try { await source.query('DROP TABLE IF EXISTS ' + sourceTable); }
      finally { await source.end(); }
      try { await target.query('DROP TABLE IF EXISTS ' + destinationTable); }
      finally { await target.end(); }
    }
  }
  await probe(engines);
  checks.push('Both directions reopened the authenticated workspace snapshots, re-reviewed a fresh destination transaction after cancellation and rollback, then committed unchanged BIT(64), YEAR, ENUM, SET, and fixed BINARY values.');
  return { nativeHostRestart: Boolean(fromRestart), directions, springIsolation: isolation };
}

module.exports = { seedRecoverableTransfer, runResumableTableTransferChecks };
