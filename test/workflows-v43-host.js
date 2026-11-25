'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

exports.run = async (vscode = require('vscode')) => {
  const extension = vscode.extensions.getExtension('rocketbrain-local.rocketbrain');
  assert.ok(extension);
  const engine = process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE;
  assert.ok(['mysql', 'mariadb'].includes(engine));
  const prefix = process.env.ROCKETBRAIN_TEST_REPORT_PREFIX || 'v0.43';
  assert.match(prefix, /^v0\.43(?:-[a-z0-9-]+)?$/);
  const api = await extension.activate(), checks = [], details = {};
  const report = path.resolve(__dirname, '../test-output', prefix + '-native-' + engine + '.json');
  const phase = process.env.ROCKETBRAIN_V43_PHASE || 'verify';
  if (phase === 'reopen-cache') {
    const previous = JSON.parse(fs.readFileSync(report, 'utf8'));
    assert.equal(previous.engine, engine);
    assert.equal(previous.version, extension.packageJSON.version);
    assert.equal(previous.extensionPath, extension.extensionPath);
    assert.notEqual(previous.hostPid, process.pid);
    await assert.rejects(api.databaseCatalog(), /Connect to MySQL or MariaDB/);
    details.cache = await require('./metadata-cache-host').checkMetadataCacheRestart(api, vscode, previous.details.cache.restart);
    fs.writeFileSync(report.replace(/\.json$/, '-reopened.json'), JSON.stringify({
      version:previous.version, extensionPath:extension.extensionPath, engine, details, hostPid:process.pid,
      previousHostPid:previous.hostPid, disconnected:true
    }, null, 2) + '\n', { flag:'wx' });
    return;
  }
  assert.equal(phase, 'verify');
  const suites = {
    fieldLists:() => require('./sql-field-lists-host').runSqlFieldListChecks(api, vscode, checks),
    hierarchy:() => require('./java-member-hierarchy-host').runJavaMemberHierarchyChecks(api, vscode, checks),
    transport:() => require('./local-transport-host').runLocalTransportChecks(api, vscode, checks),
    cache:() => require('./metadata-cache-host').runMetadataCacheChecks(api, vscode, checks),
    changelists:() => require('./changelists-host').runChangelistChecks(api, vscode, checks)
  };
  const selection = process.env.ROCKETBRAIN_V43_ONLY?.split(',') || Object.keys(suites);
  assert.ok(selection.length && new Set(selection).size === selection.length);
  for (const name of selection) {
    assert.ok(Object.hasOwn(suites, name), name);
    console.log('Running Rocketbrain v0.43 workflow ' + name);
    details[name] = await suites[name]();
  }
  const receipt = { version:extension.packageJSON.version, extensionPath:extension.extensionPath,
    vscode:vscode.version, engine, hostPid:process.pid, passed:selection.length, checks, details };
  fs.writeFileSync(report, JSON.stringify(receipt, null, 2) + '\n', { flag:'wx' });
};
