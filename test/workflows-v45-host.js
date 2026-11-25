'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

exports.run = async (vscode = require('vscode')) => {
  const extension = vscode.extensions.getExtension('rocketbrain-local.rocketbrain');
  assert.ok(extension);
  const engine = process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE;
  assert.ok(['mysql', 'mariadb'].includes(engine));
  const prefix = process.env.ROCKETBRAIN_TEST_REPORT_PREFIX || 'v0.45';
  assert.match(prefix, /^v0\.45(?:-[a-z0-9-]+)?$/);
  const api = await extension.activate(), checks = [], details = {};
  const report = path.resolve(__dirname, '../test-output', prefix + '-native-' + engine + '.json');
  const suites = {
    duckdb: () => require('./duckdb-host').runDuckDbChecks(api, vscode, checks),
    breakpoints: () => require('./java-debug-breakpoints-host').runJavaBreakpointChecks(api, vscode, checks),
    protocols: () => require('./api-protocols-host').runApiProtocolsChecks(api, vscode, checks)
  };
  const selection = process.env.ROCKETBRAIN_V45_ONLY?.split(',') || Object.keys(suites);
  assert.ok(selection.length && new Set(selection).size === selection.length);
  for (const name of selection) {
    assert.ok(Object.hasOwn(suites, name), name);
    console.log('Running Rocketbrain v0.45 workflow ' + name);
    details[name] = await suites[name]();
  }
  const receipt = { version: extension.packageJSON.version, extensionPath: extension.extensionPath,
    vscode: vscode.version, engine, hostPid: process.pid, passed: selection.length, checks, details };
  fs.writeFileSync(report, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
};
