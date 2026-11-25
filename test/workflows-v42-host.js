'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

exports.run = async (vscode = require('vscode')) => {
  const extension = vscode.extensions.getExtension('rocketbrain-local.rocketbrain');
  assert.ok(extension);
  const engine = process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE;
  assert.ok(['mysql', 'mariadb'].includes(engine));
  const prefix = process.env.ROCKETBRAIN_TEST_REPORT_PREFIX || 'v0.42';
  assert.match(prefix, /^v0\.42(?:-[a-z0-9-]+)?$/);
  const api = await extension.activate(), checks = [], details = {};
  const suites = {
    extract:() => require('./java-extract-interface-host').runJavaExtractInterfaceChecks(api, vscode, checks),
    transport:() => require('./local-transport-host').runLocalTransportChecks(api, vscode, checks),
    dml:() => require('./sql-dml-scope-host').runSqlDmlScopeChecks(api, vscode, checks),
    springGraph:() => require('./spring-bean-graph-host').runSpringBeanGraphChecks(api, vscode, checks),
    actuatorHealth:() => require('./spring-actuator-health-host').runSpringActuatorHealthChecks(api, vscode, checks)
  };
  const selection = process.env.ROCKETBRAIN_V42_ONLY?.split(',') || Object.keys(suites);
  assert.ok(selection.length && new Set(selection).size === selection.length);
  for (const name of selection) {
    assert.ok(Object.hasOwn(suites, name), name);
    console.log('Running Rocketbrain v0.42 workflow ' + name);
    details[name] = await suites[name]();
  }
  const report = path.resolve(__dirname, '../test-output', prefix + '-native-' + engine + '.json');
  const receipt = { version:extension.packageJSON.version, extensionPath:extension.extensionPath,
    vscode:vscode.version, engine, hostPid:process.pid, passed:selection.length, checks, details };
  fs.writeFileSync(report, JSON.stringify(receipt, null, 2) + '\n', { flag:'wx' });
};
