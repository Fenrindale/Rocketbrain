'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { MysqlService } = require('../src/db/mysql');

const fixtureConfig = process.env.ROCKETBRAIN_TEST_MYSQL_CONFIG;
const pipe = process.env.ROCKETBRAIN_TEST_MYSQL_PIPE;
test('Windows IPC connects to the actual MySQL or MariaDB named-pipe fixture over every owned console', {
  skip: !pipe || !fixtureConfig ? 'Start an owned named-pipe fixture to verify the real database route.' : false,
  timeout: 20000
}, async () => {
  const tcp = JSON.parse(await fs.readFile(fixtureConfig, 'utf8'));
  const owner = JSON.parse(await fs.readFile(path.join(path.dirname(fixtureConfig), 'owner.json'), 'utf8'));
  const engine = owner.kind === 'RocketbrainDisposableOracleMysqlFixture-v1' ? 'mysql' : 'mariadb';
  assert.ok(['RocketbrainDisposableOracleMysqlFixture-v1', 'RocketbrainDisposableMariaDbFixture-v1'].includes(owner.kind));
  assert.equal(tcp.host, '127.0.0.1');
  assert.equal(pipe, 'rocketbrain-' + engine + '-' + owner.id);
  const local = new MysqlService({ transport: { kind: 'named-pipe', address: pipe },
    database: tcp.database, user: tcp.user, password: tcp.password });
  try {
    const metadata = await local.metadata();
    assert.ok(metadata.tables.some(table => table.name === 'people'));
    const named = await local.openSession('named');
    assert.equal(named.readOnly, true);
    const { rows } = await local.query('SELECT CURRENT_USER(), @@socket, DATABASE()', { sessionId: 'named' });
    assert.equal(rows[0][0], tcp.user + '@localhost');
    assert.equal(rows[0][1].toLowerCase(), pipe.toLowerCase());
    assert.equal(rows[0][2], tcp.database);
    const bound = await local.query('SELECT COUNT(*) FROM people WHERE id > ?', { sessionId: 'named', values: [0] });
    assert.equal(Number(bound.rows[0][0]), 3);
    const missing = new MysqlService({ transport: { kind: 'named-pipe', address: pipe + '-missing' },
      database: tcp.database, user: tcp.user, password: tcp.password });
    try {
      await assert.rejects(missing.metadata(), /pipe|port|connect|ENOENT/i);
    } finally { await missing.dispose(); }
  } finally { await local.dispose(); }
});
