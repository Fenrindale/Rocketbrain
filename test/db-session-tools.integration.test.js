'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const mysql = require('mysql2/promise');
const { MysqlService } = require('../src/db/mysql');
const { levels } = require('../src/db/transaction-isolation');

const file = process.env.ROCKETBRAIN_TEST_MYSQL_CONFIG || process.env.ROCKETBRAIN_MYSQL_TEST_CONFIG;

test('live session isolation remains local and changes committed-read visibility', {
  skip: !file && 'Run with an owned MySQL or MariaDB test fixture.',
  timeout: 30000
}, async () => {
  const marker = JSON.parse(fs.readFileSync(path.join(path.dirname(file), 'owner.json')));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(marker.kind));
  const config = JSON.parse(fs.readFileSync(file));
  assert.equal(config.host, '127.0.0.1');
  const service = new MysqlService(config);
  const writer = await mysql.createConnection(config);
  const table = 'rb_isolation_' + randomBytes(6).toString('hex');
  let created = false;
  try {
    await writer.query('CREATE TABLE ' + table + ' (id INT PRIMARY KEY, v INT NOT NULL) ENGINE=InnoDB');
    created = true;
    await writer.query('INSERT INTO ' + table + ' VALUES (1, 10)');
    await service.openSession('peer');
    const peer = await service.getTransactionIsolation({ sessionId: 'peer' });
    for (const level of levels) {
      const current = await service.setTransactionIsolation(level);
      assert.equal(current.transactionIsolation, level);
      assert.equal(current.readOnly, true);
      assert.equal(current.autocommit, true);
      assert.equal((await service.getTransactionIsolation({ sessionId: 'peer' })).transactionIsolation, peer.transactionIsolation);
    }
    const read = async () => (await service.query('SELECT v FROM ' + table + ' WHERE id=1')).rows[0][0];
    const repeatable = await service.setTransactionIsolation('REPEATABLE READ');
    assert.equal((await service.begin()).inTransaction, true);
    assert.equal(await read(), 10);
    await writer.query('UPDATE ' + table + ' SET v=20 WHERE id=1');
    assert.equal(await read(), 10);
    await assert.rejects(service.setTransactionIsolation('READ COMMITTED'), /active or uncertain/);
    assert.equal((await service.rollback()).inTransaction, false);
    const review = await service.previewScript('SELECT 1;');
    await service.setTransactionIsolation('READ COMMITTED');
    await assert.rejects(service.runScript({ reviewId: review.reviewId }), { code: 'ROCKETBRAIN_SCRIPT_STALE' });
    await service.begin();
    assert.equal(await read(), 20);
    await writer.query('UPDATE ' + table + ' SET v=30 WHERE id=1');
    assert.equal(await read(), 30);
    await service.commit();
    const reconnect = await service.reconnect();
    assert.notEqual(reconnect.connectionId, repeatable.connectionId);
    assert.equal(reconnect.transactionIsolation, null);
    assert.equal((await service.getTransactionIsolation()).transactionIsolation, peer.transactionIsolation);
  } finally {
    await service.dispose();
    try { if (created) await writer.query('DROP TABLE ' + table); }
    finally { await writer.end(); }
  }
});
