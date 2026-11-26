'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');

const fixtureSource = path.resolve(__dirname, '../fixtures/java/jpms-testing');
const testModule = 'fixture.jpms.tests';
const testClass = testModule + '.InvoiceModuleTest';
const testSource = 'src/test/java/fixture/jpms/tests/InvoiceModuleTest.java';
const reviewedInputs = ['src', 'build.gradle', 'settings.gradle', 'build/classes/java/main',
  'build/classes/java/test', 'build/jpms-test-path.txt'];

async function copyNamedTests(compiledRoot, project) {
  for (const entry of reviewedInputs) {
    const target = path.join(project, entry);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.cp(path.join(compiledRoot, entry), target, { recursive: true, errorOnExist: true, force: false });
  }
}

async function discoverCopiedNamedTests(javaTesting, profile) {
  async function fingerprint() {
    const digest = createHash('sha256');
    async function include(relative) {
      const file = path.join(profile.workspace, relative);
      const stat = await fs.lstat(file);
      if (stat.isDirectory()) {
        for (const entry of (await fs.readdir(file)).sort()) await include(path.join(relative, entry));
      } else {
        assert.ok(stat.isFile(), 'Only owned physical fixture files can be reviewed.');
        digest.update(JSON.stringify([relative, createHash('sha256').update(await fs.readFile(file)).digest('hex')]));
      }
    }
    for (const entry of reviewedInputs) await include(entry);
    return digest.digest('hex');
  }

  const expected = await fingerprint();
  for (const pause of [0, 250, 500, 1000]) {
    if (pause) await delay(pause);
    assert.equal(await fingerprint(), expected, 'The copied named test inputs changed during discovery.');
    try {
      const found = await javaTesting.discover({ projects: [profile], build: false });
      assert.equal(await fingerprint(), expected, 'The copied named test inputs changed during discovery.');
      return found;
    } catch (error) {
      // Windows can deliver creation notifications from the copied fixture during discovery.
      if (error.message !== 'Java sources or configuration changed during discovery. Discover again.' || pause === 1000) throw error;
    }
  }
}

async function namedTestProfile(workspace, javaHome, runtimePath, outputRoot) {
  const output = path.join(workspace, 'build/classes/java/test');
  const text = await fs.readFile(path.join(workspace, 'build/jpms-test-path.txt'), 'utf8');
  return {
    workspace, javaHome, runtimePath, outputRoot, testModule, testClassPaths: [output],
    sourceRoots: ['src/main/java', 'src/test/java'].map(root => path.join(workspace, root)),
    modulePath: [output, path.join(workspace, 'build/classes/java/main'), ...text.trim().split(/\r?\n/)],
    timeoutMs: 45000
  };
}

function jdbcEnvironment(engine, config) {
  assert.ok(engine === 'mysql' || engine === 'mariadb');
  assert.equal(config.host, '127.0.0.1');
  assert.ok(Number.isInteger(config.port) && config.port >= 1 && config.port <= 65535);
  assert.match(config.database, /^[a-z_]+$/u);
  return {
    RB_JPMS_EXPECTED_SERVER: engine === 'mysql' ? '8.4.' : '11.4.',
    RB_JPMS_JDBC_URL: 'jdbc:' + engine + '://127.0.0.1:' + config.port + '/' + config.database +
      (engine === 'mysql' ? '?allowPublicKeyRetrieval=true&sslMode=DISABLED' : ''),
    RB_JPMS_JDBC_USER: config.user, RB_JPMS_JDBC_PASSWORD: config.password
  };
}

module.exports = { fixtureSource, testModule, testClass, testSource, copyNamedTests, discoverCopiedNamedTests, namedTestProfile, jdbcEnvironment };
