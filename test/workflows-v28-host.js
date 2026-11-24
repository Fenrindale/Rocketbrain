'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const vscode = require('vscode');
const { runJavaBranchMove } = require('./java-move-v28-state-host');

exports.run = async () => {
  const extension = vscode.extensions.getExtension('rocketbrain-local.rocketbrain');
  assert.ok(extension);
  const group = process.env.ROCKETBRAIN_V28_GROUP;
  const engine = process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE;
  assert.ok(['mysql', 'mariadb'].includes(engine));
  const prefix = process.env.ROCKETBRAIN_TEST_REPORT_PREFIX || 'v0.28';
  assert.match(prefix, /^v0\.28(?:-[a-z0-9-]+)?$/);
  const startedAt = new Date().toISOString();
  const api = await extension.activate();
  const details = {};
  const checks = [];
  try {
    await api.java.start();
    if (group === 'state') {
      details.branchMove = await runJavaBranchMove(api, vscode);
      checks.push('JDT preserves conditional reference writes, both branches and the recorded Spring and DB outcomes.');
    } else if (group === 'workbench') {
      const workflows = {
        join: () => require('./db-foreign-key-joins-host').runForeignKeyJoinChecks(api, vscode),
        session: () => require('./db-session-tools-host').runDbSessionToolsChecks(api, vscode, checks),
        results: () => require('./db-results-v28-host').runDbResultsV28Checks(api, vscode, checks),
        java: () => require('./java-utilities-host').runJavaUtilitiesChecks(api, vscode, checks)
      };
      const selected = process.env.ROCKETBRAIN_V28_WORKBENCH_ONLY?.split(',') || Object.keys(workflows);
      for (const workflow of selected) {
        assert.ok(Object.hasOwn(workflows, workflow), workflow);
        details[workflow] = await workflows[workflow]();
      }
      if (selected.includes('join')) checks.push('Native SQL completion inserts a verified Spring schema foreign-key JOIN and executes it successfully.');
    } else {
      throw Error('Unknown v0.28 workflow group.');
    }
    assert.ok(Object.keys(details).length);
  } finally {
    await api.java.stop();
  }
  const report = {
    version: extension.packageJSON.version, extensionPath: extension.extensionPath, vscode: vscode.version,
    engine, group, startedAt, completedAt: new Date().toISOString(),
    passed: Object.keys(details).length, checks, details
  };
  fs.writeFileSync(path.resolve(__dirname, '../test-output', `${prefix}-native-${group}-${engine}.json`),
    JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ group, engine, passed: report.passed, version: report.version }));
};
