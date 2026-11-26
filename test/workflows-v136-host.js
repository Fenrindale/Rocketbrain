'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { jdbcReadback } = require('./java-source-analysis-host');

const version = '0.136.0';
const hooks = Object.freeze({
  schemaRecovery: ['schema-recovery-host', 'runSchemaRecoveryChecks'],
  quarkusGradle: ['quarkus-gradle-host', 'runQuarkusGradleChecks'],
  kmpComposePreview: ['kmp-compose-preview-host', 'runKmpComposePreviewChecks'],
  jakartaMulti: ['jakarta-multi-host', 'runJakartaMultiChecks'],
  javafxPreview: ['javafx-preview-host', 'runJavaFxPreviewChecks'],
  scala2Language: ['scala-language-host', 'runScalaLanguageChecks', '2.13.18'],
  scala3Language: ['scala-language-host', 'runScalaLanguageChecks', '3.9.0'],
  scala2TestDebug: ['scala-test-debug-host', 'runScalaTestDebugChecks', '2.13.18'],
  scala3TestDebug: ['scala-test-debug-host', 'runScalaTestDebugChecks', '3.9.0']
});

function selectGroups(value) {
  const names = value === undefined ? Object.keys(hooks) : value.split(',');
  assert.ok(names.length && names.every(name => Object.hasOwn(hooks, name)) &&
    new Set(names).size === names.length, 'Select unique v0.136 workflow group names.');
  return names;
}

function scalaFixtureManifests(root, prefix, engine, groups) {
  assert.match(prefix, /^v0\.136(?:-[a-z0-9-]+)?$/u);
  assert.ok(['mysql', 'mariadb'].includes(engine));
  return Object.fromEntries(groups.filter(group => group === 'scala2Language' || group === 'scala3Language').map(group =>
    [group, path.resolve(root, 'test-output', `${prefix}-native-${engine}-${group}-fixture.json`)]));
}

exports.version = version;
exports.hooks = hooks;
exports.selectGroups = selectGroups;
exports.scalaFixtureManifests = scalaFixtureManifests;
exports.run = async (vscode = require('vscode')) => {
  const extension = vscode.extensions.getExtension('rocketbrain-local.rocketbrain');
  assert.equal(extension?.packageJSON.version, version);
  const engine = process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE;
  assert.ok(['mysql', 'mariadb'].includes(engine));
  const prefix = process.env.ROCKETBRAIN_TEST_REPORT_PREFIX || 'v0.136';
  assert.match(prefix, /^v0\.136(?:-[a-z0-9-]+)?$/u);
  const names = selectGroups(process.env.ROCKETBRAIN_V136_ONLY);
  const log = path.resolve(__dirname, '../test-output', `${prefix}-native-${engine}-progress.jsonl`);
  fs.writeFileSync(log, '', { flag: 'wx' });
  const mark = (group, state, details = {}) =>
    fs.appendFileSync(log, JSON.stringify({ group, state, time: new Date().toISOString(), ...details }) + '\n');
  const scalaFixtures = scalaFixtureManifests(path.resolve(__dirname, '..'), prefix, engine, names);
  const api = await extension.activate();
  const checks = [], details = {}, failures = [];
  for (const group of names) {
    mark(group, 'started');
    try {
      const [file, receiver, argument] = hooks[group];
      const hook = require('./' + file)[receiver];
      assert.equal(typeof hook, 'function', group + ' installed verification hook');
      let evidence;
      if (group === 'schemaRecovery') {
        const receipt = path.resolve(__dirname, '../test-output', `${prefix}-native-schema-recovery-${engine}.json`);
        assert.ok(!fs.existsSync(receipt), 'The schema recovery receipt already exists.');
        await hook(api, vscode, checks);
        evidence = JSON.parse(fs.readFileSync(receipt, 'utf8'));
        assert.equal(evidence.version, version);
        assert.equal(evidence.engine, engine);
        assert.equal(evidence.preflightRefusalWithoutRecoveryRecord, true);
      } else {
        const args = argument ? [argument] : [];
        if (scalaFixtures[group]) {
          const admitted = JSON.parse(process.env.ROCKETBRAIN_V136_SCALA_FIXTURE_CLEANUP || '{}');
          assert.equal(admitted[group], scalaFixtures[group], 'The native runner must register post-exit Scala fixture cleanup.');
          args.push({ cleanupManifest: scalaFixtures[group], progress: (stage, details) => mark(group, stage, details) });
        }
        evidence = await hook(api, vscode, checks, ...args);
      }
      assert.ok(evidence && typeof evidence === 'object', group + ' returned no proof.');
      details[group] = { ...evidence, jdbc: await jdbcReadback() };
      mark(group, 'completed');
    } catch (error) {
      const original = error instanceof AggregateError ? error.errors[0] : error;
      const failure = { group, message: String(error.message || error).slice(0, 1400),
        location: String(original.stack || '').split(/\r?\n/u).find(line => /test[\\/].+-host\.js:\d+/u.test(line))?.trim() };
      failures.push(failure);
      mark(group, 'failed', failure);
    }
  }
  const report = path.resolve(__dirname, '../test-output', `${prefix}-native-${engine}${failures.length ? '-failed' : ''}.json`);
  fs.writeFileSync(report, JSON.stringify({ version, extensionPath: extension.extensionPath, vscode: vscode.version,
    engine, hostPid: process.pid, requestedGroups: names, passed: Object.keys(details).length, checks, details, failures }, null, 2) + '\n',
  { flag: 'wx' });
  assert.equal(failures.length, 0, failures.map(({ group, message }) => `${group}: ${message}`).join('\n'));
};
