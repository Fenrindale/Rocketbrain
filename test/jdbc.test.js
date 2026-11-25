'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const { runJdbc, examineJdbcDriver } = require('../src/db/jdbc');
const { createJdbcProfiles } = require('../src/db/jdbc-profiles');

test('bundled JDBC worker source matches the independent owned Java source', () => {
  assert.equal(require('../src/db/jdbc-worker-source.json'), fs.readFileSync(require.resolve('../runtime/jdbc/DriverWorker.java'), 'utf8'));
});

test('JDBC profile consent, workspace trust and SQL policy are checked before JVM launch', async () => {
  let trusted = false, updates = 0;
  const api = createJdbcProfiles({ state: { get: () => undefined, async update() { updates++; } },
    isTrusted: () => trusted, getJavaHome: () => { throw Error('JVM configuration must not be read.'); } });
  assert.throws(() => api.list(), /Trust the workspace/);
  await assert.rejects(api.prepare({ name: 'Driver', jar: 'driver.jar', driverClass: 'lab.fixture.Driver' }), /Trust the workspace/);
  trusted = true;
  await assert.rejects(api.save('unreviewed', true), /explicitly approve/);
  await assert.rejects(api.open('unreviewed', { url: 'jdbc:fixture:', user: '', password: '' }), /approved JDBC profile/);
  assert.equal(updates, 0);
  await assert.rejects(examineJdbcDriver('driver.jar', 'no/slash'), { code: 'ROCKETBRAIN_JDBC_CLASS' });
  const options = { profile: { driverClass: 'org.demo.Driver', sha256: '0'.repeat(64) },
    credential: { url: 'jdbc:fixture:', user: 'readonly', password: '' }, operation: 'query' };
  await assert.rejects(runJdbc({ ...options, sql: 'SELECT 1; DELETE FROM people' }), /one statement/);
  await assert.rejects(runJdbc({ ...options, sql: 'SELECT 1', maxRows: 501 }), { code: 'ROCKETBRAIN_JDBC_LIMIT' });
});
