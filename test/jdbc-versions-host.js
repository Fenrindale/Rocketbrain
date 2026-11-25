'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomBytes } = require('node:crypto');
const { spawnSync } = require('node:child_process');

async function buildWrapper(javaHome, folder, implicitPath) {
  const source = path.join(__dirname, 'fixtures/jdbc-wrapper/FixtureDriver.java');
  const binary = name => path.join(javaHome, 'bin', name + (process.platform === 'win32' ? '.exe' : ''));
  const argumentsOf = [
    ['javac', ['-proc:none', '-d', folder, source]],
    ['jar', ['--create', '--file', path.join(folder, 'wrapper.jar'), '--manifest', path.join(folder, 'jar.mf'), '-C', folder, 'fixture']]
  ];
  // An absolute URL proves that the worker ignores this existing dependency unless separately approved.
  const line = 'Class-Path: ' + pathToFileURL(implicitPath).href;
  const wrapped = line.match(/.{1,66}/g).map((part, index) => (index ? ' ' : '') + part).join('\n');
  await fs.writeFile(path.join(folder, 'jar.mf'), 'Manifest-Version: 1.0\n' + wrapped + '\n\n');
  for (const [tool, args] of argumentsOf) {
    const result = spawnSync(binary(tool), args, { windowsHide: true, shell: false, timeout: 10000, encoding: 'utf8' });
    assert.equal(result.status, 0, 'The owned JDBC wrapper did not compile/package.');
  }
  return path.join(folder, 'wrapper.jar');
}

async function verifyJdbcVersions(api, { configPath, javaHome, priorJar, currentJar }) {
  const base = path.dirname(configPath);
  const owner = JSON.parse(await fs.readFile(path.join(base, 'owner.json'), 'utf8'));
  const connection = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.ok(['RocketbrainDisposableOracleMysqlFixture-v1', 'RocketbrainDisposableMariaDbFixture-v1'].includes(owner.kind));
  assert.equal(connection.host, '127.0.0.1');
  const id = randomBytes(5).toString('hex');
  const folder = path.join(base, 'rb-jdbc-versions-' + id);
  await fs.mkdir(folder);
  const first = path.join(folder, 'prior.jar'), second = path.join(folder, 'current.jar');
  const credential = { url: `jdbc:mariadb://${connection.host}:${connection.port}/${connection.database}?sslMode=disable&allowPublicKeyRetrieval=true`,
    user: connection.user, password: connection.password };
  let profile;
  try {
    await Promise.all([fs.copyFile(priorJar, first), fs.copyFile(currentJar, second)]);
    const jar = await buildWrapper(javaHome, folder, first), driverClass = 'fixture.jdbc.FixtureDriver';
    const draft = { jar, driverClass };
    const proposal = await api.prepare({ ...draft, name: 'JDBC version fixture ' + id, libraries: [first] });
    profile = await api.save(proposal.id, true);
    assert.equal(profile.libraries.length, 1);
    assert.match(profile.libraries[0].sha256, /^[a-f0-9]{64}$/);
    const original = await api.open(profile.id, credential);
    assert.equal(original.connection.driverVersion, '3.5.7');
    const baseline = await api.query('SELECT COUNT(*) FROM people');
    assert.match(baseline.rows[0][0], /^[1-9][0-9]*$/);
    await assert.rejects(api.prepareVersion(profile.id, { ...draft, name: 'Duplicate classes', libraries: [first, second] }), /duplicate class definitions/);

    const upgraded = await api.prepareVersion(profile.id, { ...draft, name: '3.5.10', libraries: [second] });
    assert.notEqual(upgraded.classpathFingerprint, proposal.classpathFingerprint);
    assert.equal(upgraded.sha256, proposal.sha256);
    const saved = await api.saveVersion(upgraded.id, true);
    assert.equal(saved.selectedVersion, profile.selectedVersion);
    assert.equal(api.active().id, profile.id);
    await api.selectVersion(profile.id, upgraded.id);
    assert.equal(api.active(), null);
    await assert.rejects(api.query('SELECT 1'), /Open a saved JDBC connection/);
    const updated = await api.open(profile.id, credential);
    assert.equal(updated.connection.driverVersion, '3.5.10');
    assert.equal(updated.connection.catalog, original.connection.catalog);
    assert.deepEqual((await api.query('SELECT COUNT(*) FROM people')).rows, baseline.rows);
    await assert.rejects(api.removeVersion(profile.id, upgraded.id), /Select a different JDBC version/);

    const missing = await api.prepareVersion(profile.id, { ...draft, name: 'Unlisted dependency' });
    await api.saveVersion(missing.id, true);
    await api.selectVersion(profile.id, missing.id);
    await assert.rejects(api.open(profile.id, credential), { code: 'ROCKETBRAIN_JDBC_DRIVER' });
    await api.selectVersion(profile.id, profile.selectedVersion);
    const restored = await api.open(profile.id, credential);
    assert.equal(restored.connection.driverVersion, original.connection.driverVersion);
    await api.removeVersion(profile.id, missing.id);
    assert.equal(api.list().find(item => item.id === profile.id).versions.length, 2);
    await fs.appendFile(first, Buffer.from([82, 66]));
    await assert.rejects(api.query('SELECT 1'), { code: 'ROCKETBRAIN_JDBC_JAR' });
    return { original: original.connection.driverVersion, upgraded: updated.connection.driverVersion, rolledBack: true,
      sameDatabase: true, explicitAuxiliary: true, manifestIndirectionInert: true, duplicatesRefused: true,
      credentialsInvalidated: true, changedLibraryRefused: true };
  } finally {
    api.close();
    if (profile) await api.remove(profile.id);
    for (const file of [first, second, path.join(folder, 'wrapper.jar'), path.join(folder, 'jar.mf'), path.join(folder, 'fixture/jdbc/FixtureDriver.class')]) {
      await fs.unlink(file).catch(cause => { if (cause.code !== 'ENOENT') throw cause; });
    }
    for (const directory of ['fixture/jdbc', 'fixture', '.']) {
      await fs.rmdir(path.join(folder, directory)).catch(cause => { if (cause.code !== 'ENOENT') throw cause; });
    }
  }
}

async function runJdbcVersionChecks(api, vscode, checks) {
  const runtime = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const javaHome = vscode.workspace.getConfiguration('rocketbrain.java').get('javaHome');
  const priorJar = process.env.ROCKETBRAIN_JDBC_PRIOR_TEST_JAR, currentJar = process.env.ROCKETBRAIN_JDBC_CURRENT_TEST_JAR;
  assert.ok(priorJar && currentJar);
  const proof = await verifyJdbcVersions(api.jdbc, { configPath: runtime.dbConfigPath, javaHome, priorJar, currentJar });
  checks.push('per-profile JDBC connector upgrade/rollback with approved dependencies and inert manifest classpath');
  return proof;
}

module.exports = { verifyJdbcVersions, runJdbcVersionChecks };
