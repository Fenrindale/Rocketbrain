'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startLocalModel } = require('./helpers/local-sql-model-fixture');

exports.run = async (vscode = require('vscode')) => {
  const extension = vscode.extensions.getExtension('rocketbrain-local.rocketbrain');
  assert.equal(extension?.packageJSON.version, '0.54.0');
  const engine = process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE;
  assert.ok(['mysql', 'mariadb'].includes(engine));
  const prefix = process.env.ROCKETBRAIN_TEST_REPORT_PREFIX || 'v0.54';
  assert.match(prefix, /^v0\.54(?:-[a-z0-9-]+)?$/);
  const log = path.resolve(__dirname, '../test-output', `${prefix}-native-${engine}-progress.jsonl`);
  const checkpoint = (group, state) => fs.appendFileSync(log, JSON.stringify({ group, state, time: new Date().toISOString() }) + '\n');
  const api = await extension.activate();
  const checks = [];
  const details = {};
  const failures = [];
  const groups = {
    sql: () => require('./local-sql-assistant-host').runLocalSqlAssistantChecks(api, vscode, checks),
    async editor() {
      const model = await startLocalModel();
      try {
        process.env.ROCKETBRAIN_LOCAL_MODEL_ENDPOINT = model.endpoint;
        process.env.ROCKETBRAIN_LOCAL_MODEL_ID = model.model;
        return await require('./editor-model-host').runEditorModelChecks(api, vscode, checks);
      } finally { await model.close(); }
    },
    scala: () => require('./scala-sbt-host').runScalaSbtChecks(api, vscode, checks),
    kmp: () => require('./kotlin-multiplatform-host').runKotlinMultiplatformChecks(api, vscode, checks)
  };
  const names = process.env.ROCKETBRAIN_V54_ONLY?.split(',') || Object.keys(groups);
  assert.ok(names.length && names.every(name => Object.hasOwn(groups, name)) && new Set(names).size === names.length);
  try {
    for (const group of names) {
      checkpoint(group, 'started');
      try {
        details[group] = await groups[group]();
        assert.ok(details[group], group + ' returned no proof.');
        checkpoint(group, 'completed');
      } catch (error) {
        failures.push({ group, message: String(error.message || error).slice(0, 1400) });
        checkpoint(group, 'failed');
      }
    }
  } finally { await api.java.stop(); }
  const report = path.resolve(__dirname, '../test-output', `${prefix}-native-${engine}${failures.length ? '-failed' : ''}.json`);
  fs.writeFileSync(report, JSON.stringify({ version: extension.packageJSON.version, extensionPath: extension.extensionPath,
    vscode: vscode.version, engine, hostPid: process.pid, passed: Object.keys(details).length, checks, details, failures }, null, 2) + '\n', { flag: 'wx' });
  assert.equal(failures.length, 0, failures.map(({ group, message }) => `${group}: ${message}`).join('\n'));
};
