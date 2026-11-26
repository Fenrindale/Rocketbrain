'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const fixtureSource = path.resolve(__dirname, '../fixtures/java/jpms-testing');
const testModule = 'fixture.jpms.tests';
const testClass = testModule + '.InvoiceModuleTest';
const testSource = 'src/test/java/fixture/jpms/tests/InvoiceModuleTest.java';

async function copyNamedTests(compiledRoot, project) {
  for (const entry of ['src', 'build.gradle', 'settings.gradle', 'build/classes/java/main',
    'build/classes/java/test', 'build/jpms-test-path.txt']) {
    const target = path.join(project, entry);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.cp(path.join(compiledRoot, entry), target, { recursive: true, errorOnExist: true, force: false });
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

module.exports = { fixtureSource, testModule, testClass, testSource, copyNamedTests, namedTestProfile, jdbcEnvironment };
