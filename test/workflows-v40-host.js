'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

exports.run = async (vscode = require('vscode')) => {
  const extension = vscode.extensions.getExtension('rocketbrain-local.rocketbrain');
  assert.ok(extension);
  const engine = process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE;
  assert.ok(['mysql', 'mariadb'].includes(engine));
  const prefix = process.env.ROCKETBRAIN_TEST_REPORT_PREFIX || 'v0.40';
  assert.match(prefix, /^v0\.40(?:-[a-z0-9-]+)?$/);
  const phase = process.env.ROCKETBRAIN_V40_PHASE || 'verify';
  const api = await extension.activate(), checks = [], details = {};
  const report = path.resolve(__dirname, '../test-output', prefix + '-native-' + engine + '.json');
  const suites = {
    explain: () => require('./explain-review-foreign-host').runExplainForeignReviewChecks(api, vscode, checks),
    relationships: () => require('./jpa-derived-identity-host').runJpaDerivedIdentityChecks(api, vscode, checks),
    stream: () => require('./table-transfer-checkpoint-host').runTableTransferCheckpointChecks(api, vscode, checks)
  };
  const transferCheckpoint = () => require('./table-transfer-checkpoint-host').checkTransferCheckpointRestart(api, vscode);
  const selection = process.env.ROCKETBRAIN_V40_ONLY?.split(',') || Object.keys(suites);
  assert.ok(selection.length && new Set(selection).size === selection.length);
  for (const name of selection) assert.ok(Object.hasOwn(suites, name), name);

  if (phase === 'reopen-history' || phase === 'receive-shared-review') {
    const previous = JSON.parse(fs.readFileSync(report, 'utf8'));
    assert.equal(previous.engine, engine);
    assert.equal(previous.extensionPath, extension.extensionPath);
    assert.equal(previous.version, extension.packageJSON.version);
    assert.notEqual(previous.hostPid, process.pid);
    await assert.rejects(api.databaseCatalog(), /Connect to MySQL or MariaDB/);
    if (phase === 'reopen-history') {
      assert.ok(previous.details.stream);
      details.stream = await transferCheckpoint();
      assert.deepEqual(details.stream, previous.transferEvidence);
    } else {
      assert.ok(previous.details.explain);
      details.explain = await require('./explain-review-foreign-host').checkForeignReviewReapproval(api, vscode);
    }
    const suffix = phase === 'reopen-history' ? '-reopened.json' : '-receiver.json';
    fs.writeFileSync(report.replace(/\.json$/, suffix), JSON.stringify({
      details, version:previous.version, engine, extensionPath:extension.extensionPath,
      hostPid:process.pid, previousHostPid:previous.hostPid, disconnected:true
    }, null, 2) + '\n', { flag:'wx' });
    return;
  }
  assert.equal(phase, 'verify');
  for (const name of selection) {
    console.log('Running Rocketbrain v0.40 workflow ' + name);
    details[name] = await suites[name]();
  }
  const receipt = { version:extension.packageJSON.version, extensionPath:extension.extensionPath,
    vscode:vscode.version, engine, hostPid:process.pid, passed:selection.length, checks, details };
  if (selection.includes('stream')) receipt.transferEvidence = await transferCheckpoint();
  fs.writeFileSync(report, JSON.stringify(receipt, null, 2) + '\n', { flag:'wx' });
};
