'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { jdbcReadback } = require('./java-source-analysis-host');

const version = '0.140.0';
const hooks = Object.freeze({
  springAutowireHierarchy: ['spring-autowire-hierarchy-host', 'runSpringAutowireHierarchyChecks'],
  javaSignatureArity: ['java-signature-arity-host', 'runJavaSignatureArityChecks'],
  spockSpecification: ['spock-specification-host', 'runSpockSpecificationChecks'],
  reactProps: ['react-props-host', 'runReactPropsChecks'],
  angularTemplateTools: ['angular-workbench-host', 'runAngularWorkbenchChecks'],
  sshMaven: ['ssh-maven-host', 'runSshMavenChecks'],
  sshGradle: ['ssh-gradle-host', 'runSshGradleChecks'],
  javafxHierarchy: ['javafx-hierarchy-host', 'runJavaFxHierarchyChecks']
});

function selectGroups(value) {
  const names = value === undefined ? Object.keys(hooks) : value.split(',');
  assert.ok(names.length && names.every(name => Object.hasOwn(hooks, name)) &&
    new Set(names).size === names.length, 'Select unique v0.140 workflow group names.');
  return names;
}

exports.version = version;
exports.hooks = hooks;
exports.selectGroups = selectGroups;
exports.run = async (vscode = require('vscode')) => {
  const extension = vscode.extensions.getExtension('rocketbrain-local.rocketbrain');
  assert.equal(extension?.packageJSON.version, version);
  const engine = process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE;
  assert.ok(['mysql', 'mariadb'].includes(engine));
  const prefix = process.env.ROCKETBRAIN_TEST_REPORT_PREFIX || 'v0.140';
  assert.match(prefix, /^v0\.140(?:-[a-z0-9-]+)?$/u);
  const names = selectGroups(process.env.ROCKETBRAIN_V140_ONLY);
  const log = path.resolve(__dirname, '../test-output', `${prefix}-native-${engine}-progress.jsonl`);
  fs.writeFileSync(log, '', { flag: 'wx' });
  const mark = (group, state, details = {}) =>
    fs.appendFileSync(log, JSON.stringify({ group, state, time: new Date().toISOString(), ...details }) + '\n');
  const api = await extension.activate();
  const checks = [], details = {}, failures = [];
  for (const group of names) {
    mark(group, 'started');
    try {
      const [file, receiver, argument] = hooks[group];
      const hook = require('./' + file)[receiver];
      assert.equal(typeof hook, 'function', group + ' installed verification hook');
      const result = await hook(api, vscode, checks, ...(argument ? [argument] : []));
      const evidence = result ?? checks[group];
      if (result === undefined && evidence) checks.push('Verified the installed ' + group + ' workflow.');
      assert.ok(evidence && typeof evidence === 'object', group + ' returned no proof.');
      details[group] = { ...evidence, jdbc: await jdbcReadback() };
      mark(group, 'completed');
    } catch (error) {
      const failure = { group, message: String(error.message || error).slice(0, 1400),
        location: String(error.stack || '').split(/\r?\n/u).find(line => /test[\\/].+-host\.js:\d+/u.test(line))?.trim() };
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
