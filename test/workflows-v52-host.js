'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

exports.run = async (vscode = require('vscode')) => {
  const extension = vscode.extensions.getExtension('rocketbrain-local.rocketbrain');
  assert.equal(extension?.packageJSON.version, '0.52.0');
  const engine = process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE;
  assert.ok(['mysql', 'mariadb'].includes(engine));
  const prefix = process.env.ROCKETBRAIN_TEST_REPORT_PREFIX || 'v0.52';
  assert.match(prefix, /^v0\.52(?:-[a-z0-9-]+)?$/);
  const log = path.resolve(__dirname, '../test-output', `${prefix}-native-${engine}-progress.jsonl`);
  const checkpoint = (group, state) => fs.appendFileSync(log, JSON.stringify({ group, state, time: new Date().toISOString() }) + '\n');
  const api = await extension.activate();
  const checks = [];
  const details = {};
  const groups = {
    dbMcp: () => require('./db-mcp-host').runDbMcpChecks(api, vscode, checks),
    osv: () => require('./dependency-advisories-host').runDependencyAdvisoryChecks(api, vscode, checks),
    relatedRows: () => require('./db-related-scoped-host').runRelatedScopedChecks(api, vscode, checks),
    async quarkus() {
      try { return await require('./quarkus-host').runQuarkusChecks(api, vscode, checks); }
      finally { await api.java.stop(); }
    }
  };
  for (const [group, test] of Object.entries(groups)) {
    checkpoint(group, 'started');
    details[group] = await test();
    assert.ok(details[group], group + ' returned no proof.');
    checkpoint(group, 'completed');
  }
  const report = path.resolve(__dirname, '../test-output', `${prefix}-native-${engine}.json`);
  fs.writeFileSync(report, JSON.stringify({ version: extension.packageJSON.version, extensionPath: extension.extensionPath,
    vscode: vscode.version, engine, hostPid: process.pid, passed: Object.keys(details).length, checks, details }, null, 2) + '\n', { flag: 'wx' });
};
