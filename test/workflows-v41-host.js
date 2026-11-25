'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

exports.run = async (vscode = require('vscode')) => {
  const extension = vscode.extensions.getExtension('rocketbrain-local.rocketbrain');
  assert.ok(extension);
  const engine = process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE;
  assert.ok(['mysql', 'mariadb'].includes(engine));
  const prefix = process.env.ROCKETBRAIN_TEST_REPORT_PREFIX || 'v0.41';
  assert.match(prefix, /^v0\.41(?:-[a-z0-9-]+)?$/);
  const api = await extension.activate(), checks = [], details = {};
  const suites = {
    notebook: () => require('./sql-notebook-host').runSqlNotebookChecks(api, vscode, checks),
    objects: () => require('./object-source-host').runObjectSourceChecks(api, vscode, checks),
    map: () => require('./result-map-host').runResultMapChecks(api, vscode, checks),
    structure: () => require('./java-structural-search-host').runJavaStructuralSearchChecks(api, vscode, checks)
  };
  const selection = process.env.ROCKETBRAIN_V41_ONLY?.split(',') || Object.keys(suites);
  assert.ok(selection.length && new Set(selection).size === selection.length);
  for (const name of selection) {
    assert.ok(Object.hasOwn(suites, name), name);
    console.log('Running Rocketbrain v0.41 workflow ' + name);
    details[name] = await suites[name]();
  }
  const report = path.resolve(__dirname, '../test-output', prefix + '-native-' + engine + '.json');
  const receipt = { version:extension.packageJSON.version, extensionPath:extension.extensionPath,
    vscode:vscode.version, engine, hostPid:process.pid, passed:selection.length, checks, details };
  fs.writeFileSync(report, JSON.stringify(receipt, null, 2) + '\n', { flag:'wx' });
};
