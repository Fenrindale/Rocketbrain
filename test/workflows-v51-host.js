'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runCodeReviewChecks } = require('./code-review-host');
const { runGroovySpockChecks } = require('./groovy-spock-host');
const { runJavaFxChecks } = require('./javafx-host');
const { runSqlFormatScriptChecks } = require('./sql-format-script-host');

exports.run = async (vscode = require('vscode')) => {
  const extension = vscode.extensions.getExtension('rocketbrain-local.rocketbrain');
  assert.ok(extension);
  assert.equal(extension.packageJSON.version, '0.51.0');
  const engine = process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE;
  assert.ok(['mysql', 'mariadb'].includes(engine));
  const prefix = process.env.ROCKETBRAIN_TEST_REPORT_PREFIX || 'v0.51';
  assert.match(prefix, /^v0\.51(?:-[a-z0-9-]+)?$/);
  const api = await extension.activate();
  const checks = [], details = {};
  const suites = { codeReview: runCodeReviewChecks, groovySpock: runGroovySpockChecks,
    javaFx: runJavaFxChecks, sqlFormat: runSqlFormatScriptChecks };
  const selected = process.env.ROCKETBRAIN_V51_ONLY?.split(',') || Object.keys(suites);
  assert.ok(selected.length && new Set(selected).size === selected.length);
  const checkpoint = process.env.ROCKETBRAIN_V51_DRIVER_CHECKPOINT;
  const report = path.resolve(__dirname, '../test-output', prefix + '-native-' + engine + '.json');
  try {
    for (const name of selected) {
      assert.ok(Object.hasOwn(suites, name), name);
      if (checkpoint) fs.appendFileSync(checkpoint, name + ':started\n');
      details[name] = await suites[name](api, vscode, checks);
      if (checkpoint) fs.appendFileSync(checkpoint, name + ':passed\n');
    }
    const receipt = { version: extension.packageJSON.version, extensionPath: extension.extensionPath,
      vscode: vscode.version, engine, hostPid: process.pid, passed: selected.length, checks, details };
    fs.writeFileSync(report, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  } finally {
    await api.java.stop();
  }
};
