'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

exports.run = async (vscode = require('vscode')) => {
  const extension = vscode.extensions.getExtension('rocketbrain-local.rocketbrain');
  assert.ok(extension);
  const engine = process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE;
  assert.ok(['mysql', 'mariadb'].includes(engine));
  const prefix = process.env.ROCKETBRAIN_TEST_REPORT_PREFIX || 'v0.38';
  assert.match(prefix, /^v0\.38(?:-[a-z0-9-]+)?$/);
  const api = await extension.activate(), checks = [], details = {};
  const report = path.resolve(__dirname, '../test-output', prefix + '-native-' + engine + '.json');
  const reviewProof = () => require('./table-transfer-review-host').checkTransferReviewRestart(api, vscode);
  if (process.env.ROCKETBRAIN_V38_PHASE === 'reopen-history') {
    const previous = JSON.parse(fs.readFileSync(report, 'utf8'));
    assert.equal(previous.engine, engine);
    assert.equal(previous.extensionPath, extension.extensionPath);
    assert.equal(previous.version, extension.packageJSON.version);
    assert.notEqual(previous.hostPid, process.pid);
    await assert.rejects(api.databaseCatalog(), /Connect to MySQL or MariaDB/);
    const transferReview = await reviewProof();
    assert.deepEqual(transferReview, previous.transferReview);
    fs.writeFileSync(report.replace(/\.json$/, '-reopened.json'), JSON.stringify({
      transferReview, version:previous.version, engine, extensionPath:extension.extensionPath,
      hostPid:process.pid, previousHostPid:previous.hostPid, disconnected:true
    }, null, 2) + '\n', { flag:'wx' });
    return;
  }
  const suites = {
    explain: () => require('./explain-review-host').runExplainReviewChecks(api, vscode, checks),
    relationships: () => require('./jpa-composite-join-host').runJpaCompositeJoinChecks(api, vscode, checks),
    stream: () => require('./table-transfer-review-host').runTableTransferReviewChecks(api, vscode, checks)
  };
  const selection = process.env.ROCKETBRAIN_V38_ONLY?.split(',') || Object.keys(suites);
  assert.ok(selection.length && new Set(selection).size === selection.length);
  for (const name of selection) {
    assert.ok(Object.hasOwn(suites, name), name);
    console.log('Running Rocketbrain v0.38 workflow ' + name);
    details[name] = await suites[name]();
  }
  const receipt = { version:extension.packageJSON.version, extensionPath:extension.extensionPath,
    vscode:vscode.version, engine, hostPid:process.pid, passed:selection.length, checks, details };
  if (selection.includes('stream')) receipt.transferReview = await reviewProof();
  fs.writeFileSync(report, JSON.stringify(receipt, null, 2) + '\n', { flag:'wx' });
};
