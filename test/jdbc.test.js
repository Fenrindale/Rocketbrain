'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { runJdbc, examineJdbcDriver, classpathFingerprint } = require('../src/db/jdbc');
const { createJdbcProfiles } = require('../src/db/jdbc-profiles');

test('bundled JDBC worker source matches the independent owned Java source', () => {
  assert.equal(require('../src/db/jdbc-worker-source.json'), fs.readFileSync(require.resolve('../runtime/jdbc/DriverWorker.java'), 'utf8'));
});

test('legacy approved JDBC profiles keep their identity and migrate without storing credentials', async () => {
  const id = '00000000-0000-4000-a000-000000000001', other = '00000000-0000-4000-a000-000000000002';
  let value = { version: 1, profiles: [{ id, name: 'Legacy profile', jar: path.resolve('fixture.jar'), driverClass: 'org.demo.Driver',
    sha256: '1'.repeat(64), size: 1024, password: 'injected-property', url: 'jdbc:not-kept:' }] };
  const state = { get: () => structuredClone(value), async update(key, input) { value = structuredClone(input); } };
  const api = createJdbcProfiles({ state, isTrusted: () => true, getJavaHome: () => null });
  assert.equal(api.list()[0].selectedVersion, id);
  assert.equal(api.list()[0].versions[0].name, 'Initial driver');
  assert.equal(api.list()[0].sha256, '1'.repeat(64));
  assert.deepEqual(api.list()[0].libraries, []);
  assert.doesNotMatch(JSON.stringify(api.list()), /injected-property|jdbc:not-kept/);
  await api.remove(other);
  assert.equal(value.version, 2);
  assert.equal(value.profiles[0].selectedVersion, id);
  await assert.rejects(api.selectVersion(id, other), /approved JDBC driver version/);
  assert.equal(api.list()[0].versions.length, 1);
});

test('JDBC classpath identity changes with driver class and explicit library order', () => {
  const driver = { sha256: '1'.repeat(64) }, first = { sha256: '2'.repeat(64) }, second = { sha256: '3'.repeat(64) };
  const ordered = classpathFingerprint('org.demo.Driver', [driver, first, second]);
  assert.notEqual(ordered, classpathFingerprint('org.demo.Driver', [driver, second, first]));
  assert.notEqual(ordered, classpathFingerprint('org.demo.OtherDriver', [driver, first, second]));
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
