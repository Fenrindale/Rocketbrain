'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const mysql = require('mysql2/promise');

function owned(configPath) {
  const config = JSON.parse(fs.readFileSync(configPath));
  const marker = JSON.parse(fs.readFileSync(path.join(path.dirname(configPath), 'owner.json')));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(marker.kind));
  assert.equal(config.host, '127.0.0.1');
  return config;
}

async function runTableTransferChecks(api, vscode, checks) {
  const runtime = JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG));
  assert.equal(runtime.dbEngine, process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE);
  const sourceConfig = owned(runtime.dbConfigPath);
  let peer = { engine: runtime.dbEngine, configPath: runtime.dbConfigPath, baseUrl: runtime.baseUrl };
  if (process.env.ROCKETBRAIN_COORDINATOR_TEST_CONFIG) {
    const pair = JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_COORDINATOR_TEST_CONFIG));
    assert.equal(pair.format, 'RocketbrainOwnedPairedSpringFixtures');
    assert.equal(pair.version, 1);
    assert.deepEqual(pair.participants.map(item => item.engine).sort(), ['mariadb', 'mysql']);
    assert.ok(pair.participants.some(item => item.configPath === runtime.dbConfigPath));
    peer = pair.participants.find(item => item.engine !== runtime.dbEngine);
  }
  const targetConfig = owned(peer.configPath);
  const springIsolation = { people: 2, departments: 1, rolledBackNames: 0 };
  async function checkSpring() {
    for (const base of new Set([runtime.baseUrl, peer.baseUrl])) {
      const url = new URL('/probe/testing-state', base);
      assert.equal(url.hostname, '127.0.0.1');
      const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), springIsolation);
    }
  }
  const connection = config => mysql.createConnection({ ...config, supportBigNumbers: true, bigNumberStrings: true, dateStrings: true });
  const source = await connection(sourceConfig), target = await connection(targetConfig);
  const tools = api.tableTransfer;
  assert.ok(tools);
  const suffix = randomBytes(6).toString('hex'), name = 'rb_copy_from_' + suffix, destination = 'rb_copy_into_' + suffix;
  const q = value => '`' + value + '`';
  let sourceCreated = false, targetCreated = false, capture;
  const mapping = [{ source: 'id', target: 'key_id' }, { source: 'amount', target: 'amount' },
    { source: 'memo', target: 'memo' }, { source: 'payload', target: 'payload' }, { source: 'day', target: 'day' }];
  const sourceRows = [
    ['9007199254740993', '12345678901234.123456', '첫 번째 🍀', Buffer.from('0011ffee', 'hex'), '2025-10-20 14:15:16.123456'],
    ['9007199254740994', '0.000001', '두 번째', null, '2025-10-20 14:15:18.000001']
  ];
  async function observed() {
    const [rows] = await target.query('SELECT key_id,amount,memo,HEX(payload) AS payload,`day` FROM ' + q(destination) + ' ORDER BY key_id');
    return rows.map(row => [row.key_id, row.amount, row.memo, row.payload, row.day]);
  }
  const makePreview = async () => {
    const inspected = await tools.inspectDestination({ captureId: capture.id, table: destination });
    assert.equal(inspected.engine, peer.engine);
    assert.notEqual(inspected.scope, capture.scope);
    return tools.preview({ captureId: capture.id, destinationId: inspected.id, mapping });
  };
  try {
    await checkSpring();
    const commands = await vscode.commands.getCommands(true);
    for (const id of ['rocketbrain.data.captureTransferSource', 'rocketbrain.data.transfer', 'rocketbrain.data.finishTransfer']) assert.ok(commands.includes(id));
    await source.query('CREATE TABLE ' + q(name) + ' (id BIGINT PRIMARY KEY,amount DECIMAL(20,6) NOT NULL,memo VARCHAR(64) NOT NULL,payload VARBINARY(16),`day` DATETIME(6) NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
    sourceCreated = true;
    await target.query('CREATE TABLE ' + q(destination) + ' (key_id BIGINT PRIMARY KEY,amount DECIMAL(20,6) NOT NULL,memo VARCHAR(64) NOT NULL,payload VARBINARY(32),`day` DATETIME(6) NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
    targetCreated = true;
    for (const row of sourceRows) await source.execute('INSERT INTO ' + q(name) + ' VALUES (?,?,?,?,?)', row);
    await api.connectMysql(sourceConfig);
    capture = await tools.capture({ table: name });
    assert.equal(capture.rowCount, 2);
    assert.equal(capture.engine, runtime.dbEngine);
    assert.equal(Object.hasOwn(capture, 'rows'), false);
    assert.equal(JSON.stringify(capture).includes(sourceRows[0][2]), false);
    await assert.rejects(tools.inspectDestination({ captureId: capture.id, table: name }), /different destination table/);
    await source.query('UPDATE ' + q(name) + ' SET memo=\'changed after capture\' WHERE id=9007199254740993');
    await api.connectMysql(targetConfig);
    assert.equal(tools.listSources()[0].sourceHash, capture.sourceHash);
    const inspected = await tools.inspectDestination({ captureId: capture.id, table: destination });
    const invalid = mapping.map(item => item.source === 'memo' ? { ...item, target: 'amount' } :
      item.source === 'amount' ? { ...item, target: 'memo' } : item);
    await assert.rejects(tools.preview({ captureId: capture.id, destinationId: inspected.id, mapping: invalid }), /compatible exact types/);

    const stale = await makePreview();
    assert.match(stale.sql, /^INSERT INTO /);
    assert.match(stale.sql, /VALUES \(\?,\?,\?,\?,\?\)$/);
    assert.equal(stale.rowsIncluded, false);
    await api.connectMysql(targetConfig);
    await assert.rejects(tools.run({ reviewId: stale.reviewId }), /destination connection changed/i);
    await tools.discardReview(stale.reviewId);
    assert.deepEqual(await observed(), []);
    const rollbackPlan = await makePreview();
    const staged = await tools.run({ reviewId: rollbackPlan.reviewId });
    assert.equal(staged.state, 'awaiting-commit', staged.error?.message);
    assert.equal(tools.pending().transactionId, staged.transactionId);
    assert.deepEqual(await observed(), []);
    await assert.rejects(api.disconnectMysql(), /current database operation|running query|database switch/i);
    const rolled = await tools.settle({ transactionId: staged.transactionId, commit: false });
    assert.equal(rolled.state, 'rolled-back');
    assert.deepEqual(await observed(), []);

    const finalPlan = await makePreview();
    const second = await tools.run({ reviewId: finalPlan.reviewId });
    assert.equal(second.state, 'awaiting-commit', second.error?.message);
    const committed = await tools.settle({ transactionId: second.transactionId, commit: true });
    assert.equal(committed.state, 'committed');
    assert.equal(tools.pending(), null);
    const expected = sourceRows.map(row => [row[0], row[1], row[2], row[3]?.toString('hex').toUpperCase() ?? null, row[4]]);
    assert.deepEqual(await observed(), expected);
    const duplicate = await tools.run({ reviewId: (await makePreview()).reviewId });
    assert.equal(duplicate.state, 'failed', duplicate.error?.message);
    assert.equal(duplicate.rolledBack, true);
    assert.deepEqual(await observed(), expected);
    assert.equal((await source.query('SELECT memo FROM ' + q(name) + ' WHERE id=9007199254740993'))[0][0].memo, 'changed after capture');
    await checkSpring();
    checks.push('Source snapshot stayed immutable across reconnection and a live source edit. Database/table identity and mismatched column mappings were checked before writes.');
    checks.push('Destination insert-only staging required a fresh review and retained exact BigInt, decimal, UTF-8, binary, NULL and DATETIME values. An independent session observed zero rows until commit.');
    checks.push('Explicit rollback and duplicate-key failure left the destination intact. The Spring fixtures retained their original JDBC counts.');
    return { sourceEngine: runtime.dbEngine, destinationEngine: peer.engine, crossEngine: peer.engine !== runtime.dbEngine,
      rows: expected.length, staleReviewRefused: true, destinationLockHeld: true, capturedValuesRetained: true,
      independentlyInvisibleBeforeCommit: true, manualRollback: true, duplicateRolledBack: true, springIsolation };
  } finally {
    try {
      const pending = tools.pending();
      if (pending) await tools.settle({ transactionId: pending.transactionId, commit: false });
      if (capture) tools.discardSource(capture.id);
      await api.disconnectMysql();
    } finally {
      try {
        if (targetCreated) await target.query('DROP TABLE ' + q(destination));
        if (sourceCreated) await source.query('DROP TABLE ' + q(name));
      } finally { await Promise.allSettled([source.end(), target.end()]); }
    }
  }
}

module.exports = { runTableTransferChecks };
