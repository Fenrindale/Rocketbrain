'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const { MysqlService } = require('../src/db/mysql');
const { jdbcReadback } = require('./java-source-analysis-host');
const { until } = require('./helpers/stdio-lsp');

const fixture = process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG;
test('the live MySQL family session initializes, stays healthy, idles safely and reconnects explicitly', { skip: !fixture }, async () => {
  const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
  const runtime = await read(fixture), file = runtime.dbConfigPath;
  const owner = await read(path.join(path.dirname(file), 'owner.json'));
  const config = await read(file);
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(owner.kind));
  assert.equal(config.host, '127.0.0.1');
  const idleLimit = 3;
  const service = new MysqlService({ ...config, sessionLifecycle: {
    initialSql: "SET SESSION time_zone='+05:00'; SET SESSION group_concat_max_len=256;",
    idleSeconds: idleLimit, keepAliveSeconds: 1
  } });
  const id = 'lifecycle-integration';
  const options = { sessionId: id };
  const state = () => service.getSessionState(id);
  const readValues = async () => (await service.query('SELECT @@session.time_zone,@@session.group_concat_max_len', options)).rows.map(row => row.map(String));
  try {
    const jdbc = await jdbcReadback();
    const original = await service.openSession(id);
    assert.deepEqual(await readValues(), [['+05:00', '256']]);
    assert.equal(state().lifecycle.initializedStatements, 2);
    await until(() => state().lifecycle.keepAliveChecks >= 1, 4500);
    assert.equal(state().connectionId, original.connectionId);
    await until(() => state().lifecycle.disconnectedByIdleTimeout, 5500);
    assert.equal(state().transactionState, 'idle');
    assert.equal(state().outcomeUnknown, false);
    await assert.rejects(readValues, /Reconnect explicitly/);
    const next = await service.reconnect(id);
    assert.notEqual(next.connectionId, original.connectionId);
    assert.equal(next.lifecycle.initializedStatements, 2);
    assert.deepEqual(await readValues(), [['+05:00', '256']]);
    await service.begin(options);
    await new Promise(resolve => setTimeout(resolve, (idleLimit + 0.4) * 1000));
    assert.equal(state().inTransaction, true);
    assert.equal(state().connectionId, next.connectionId);
    assert.ok(state().lifecycle.keepAliveChecks >= 1);
    await service.rollback(options);
    assert.deepEqual(await jdbcReadback(), jdbc);
  } finally { await service.dispose(); }
});
