'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

exports.run = async (vscode = require('vscode')) => {
  const extension = vscode.extensions.getExtension('rocketbrain-local.rocketbrain');
  assert.ok(extension);
  const engine = process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE;
  assert.ok(['mysql', 'mariadb'].includes(engine));
  const prefix = process.env.ROCKETBRAIN_TEST_REPORT_PREFIX || 'v0.39';
  assert.match(prefix, /^v0\.39(?:-[a-z0-9-]+)?$/);
  const api = await extension.activate(), checks = [], details = {};
  const report = path.resolve(__dirname, '../test-output', prefix + '-native-' + engine + '.json');
  const suites = {
    explain: () => require('./explain-review-persistence-host').runExplainReviewPersistenceChecks(api, vscode, checks),
    relationships: () => require('./jpa-embedded-unique-host').runJpaEmbeddedUniqueChecks(api, vscode, checks),
    stream: () => require('./table-transfer-full-host').runTableTransferFullChecks(api, vscode, checks)
  };
  const transferCheckpoint = () => require('./table-transfer-full-host').checkFullTransferRestart(api, vscode);
  const selection = process.env.ROCKETBRAIN_V39_ONLY?.split(',') || Object.keys(suites);
  assert.ok(selection.length && new Set(selection).size === selection.length);
  for (const name of selection) assert.ok(Object.hasOwn(suites, name), name);

  if (process.env.ROCKETBRAIN_V39_PHASE === 'reopen-history') {
    const previous = JSON.parse(fs.readFileSync(report, 'utf8'));
    assert.equal(previous.engine, engine);
    assert.equal(previous.extensionPath, extension.extensionPath);
    assert.equal(previous.version, extension.packageJSON.version);
    assert.notEqual(previous.hostPid, process.pid);
    await assert.rejects(api.databaseCatalog(), /Connect to MySQL or MariaDB/);
    for (const name of selection) assert.ok(previous.details[name], name);
    if (selection.includes('explain')) {
      details.explain = await require('./explain-review-persistence-host').checkReviewPersistenceRestart(api, vscode);
    }
    if (selection.includes('stream')) {
      details.stream = await transferCheckpoint();
      assert.deepEqual(details.stream, previous.transferEvidence);
    }
    fs.writeFileSync(report.replace(/\.json$/, '-reopened.json'), JSON.stringify({
      details, version:previous.version, engine, extensionPath:extension.extensionPath,
      hostPid:process.pid, previousHostPid:previous.hostPid, disconnected:true
    }, null, 2) + '\n', { flag:'wx' });
    return;
  }
  for (const name of selection) {
    console.log('Running Rocketbrain v0.39 workflow ' + name);
    details[name] = await suites[name]();
  }
  const receipt = { version:extension.packageJSON.version, extensionPath:extension.extensionPath,
    vscode:vscode.version, engine, hostPid:process.pid, passed:selection.length, checks, details };
  if (selection.includes('stream')) receipt.transferEvidence = await transferCheckpoint();
  fs.writeFileSync(report, JSON.stringify(receipt, null, 2) + '\n', { flag:'wx' });
};
