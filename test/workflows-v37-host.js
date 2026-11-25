'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

async function checkTransferHistory(api) {
  const records = await api.tableTransfer.listTransferVerificationHistory();
  assert.equal(records.length, 10);
  const byCapture = new Map(), statuses = {};
  for (const record of records) {
    assert.equal(record.historicalCommitConfirmed, false);
    assert.equal(record.replayBlocked, true);
    assert.match(record.captureId, /^[a-f0-9-]{36}$/i);
    assert.ok(Number.isFinite(Date.parse(record.recordedAt)));
    byCapture.set(record.captureId, (byCapture.get(record.captureId) || 0) + 1);
    statuses[record.status] = (statuses[record.status] || 0) + 1;
  }
  assert.deepEqual(statuses, { matching:2, mismatch:2, missing:2, inconclusive:4 });
  assert.deepEqual([...byCapture.values()].sort(), [1, 1, 4, 4]);
  const historySha256 = createHash('sha256').update(JSON.stringify(records.map(record => JSON.stringify(
    Object.entries(record).sort(([a], [b]) => a.localeCompare(b)))).sort())).digest('hex');
  return { observations:records.length, statuses, historySha256 };
}

exports.run = async (vscode = require('vscode')) => {
  const extension = vscode.extensions.getExtension('rocketbrain-local.rocketbrain');
  assert.ok(extension);
  const engine = process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE;
  assert.ok(['mysql', 'mariadb'].includes(engine));
  const prefix = process.env.ROCKETBRAIN_TEST_REPORT_PREFIX || 'v0.37';
  assert.match(prefix, /^v0\.37(?:-[a-z0-9-]+)?$/);
  const api = await extension.activate(), checks = [], details = {};
  const report = path.resolve(__dirname, '../test-output', prefix + '-native-' + engine + '.json');
  if (process.env.ROCKETBRAIN_V37_PHASE === 'reopen-history') {
    const previous = JSON.parse(fs.readFileSync(report, 'utf8'));
    assert.equal(previous.engine, engine);
    assert.equal(previous.extensionPath, extension.extensionPath);
    assert.equal(previous.version, extension.packageJSON.version);
    assert.notEqual(previous.hostPid, process.pid);
    await assert.rejects(api.databaseCatalog(), /Connect to MySQL or MariaDB/);
    const history = await checkTransferHistory(api);
    assert.deepEqual(history, previous.transferHistory);
    fs.writeFileSync(report.replace(/\.json$/, '-reopened.json'), JSON.stringify({
      ...history, version:previous.version, engine, extensionPath:extension.extensionPath,
      hostPid:process.pid, previousHostPid:previous.hostPid, disconnected:true
    }, null, 2) + '\n', { flag:'wx' });
    return;
  }
  const suites = {
    explain: () => require('./explain-saved-host').runExplainSavedChecks(api, vscode, checks),
    relationships: () => require('./jpa-existing-relationships-host').runJpaExistingRelationshipChecks(api, vscode, checks),
    stream: () => require('./table-transfer-history-host').runTableTransferHistoryChecks(api, vscode, checks)
  };
  const selection = process.env.ROCKETBRAIN_V37_ONLY?.split(',') || Object.keys(suites);
  assert.ok(selection.length && new Set(selection).size === selection.length);
  for (const name of selection) {
    assert.ok(Object.hasOwn(suites, name), name);
    console.log('Running Rocketbrain v0.37 workflow ' + name);
    details[name] = await suites[name]();
  }
  const receipt = { version:extension.packageJSON.version, extensionPath:extension.extensionPath,
    vscode:vscode.version, engine, hostPid:process.pid, passed:selection.length, checks, details };
  if (selection.includes('stream')) receipt.transferHistory = await checkTransferHistory(api);
  fs.writeFileSync(report, JSON.stringify(receipt, null, 2) + '\n', { flag:'wx' });
};
