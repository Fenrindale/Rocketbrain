'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const vscode = require('vscode');

exports.run = async () => {
  const extension = vscode.extensions.getExtension('rocketbrain-local.rocketbrain');
  assert.ok(extension);
  const engine = process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE;
  assert.ok(['mysql','mariadb'].includes(engine));
  const prefix = process.env.ROCKETBRAIN_TEST_REPORT_PREFIX || 'v0.29';
  assert.match(prefix,/^v0\.29(?:-[a-z0-9-]+)?$/);
  const api = await extension.activate();
  const checks = [], details = {};
  const suites = {
    related: () => require('./db-related-rows-host').runRelatedRowsChecks(api,vscode,checks),
    erd: () => require('./schema-erd-host').runSchemaErdChecks(api,vscode,checks),
    results: () => require('./db-results-v29-host').runDbResultsV29Checks(api,vscode,checks),
    ddl: () => require('./schema-ddl-export-host').runSchemaDdlExportChecks(api,vscode,checks),
    async java() {
      try {
        return await require('./java-navigation-host').runJavaNavigationChecks(api,vscode,checks);
      } finally {
        await api.java.stop();
      }
    }
  };
  const selected = process.env.ROCKETBRAIN_V29_ONLY?.split(',') || Object.keys(suites);
  assert.ok(selected.length && new Set(selected).size === selected.length);
  for (const name of selected) {
    assert.ok(Object.hasOwn(suites,name),name);
    console.log('Running v0.29 workflow ' + name);
    details[name] = await suites[name]();
  }
  const receipt = { version:extension.packageJSON.version, extensionPath:extension.extensionPath,
    vscode:vscode.version, engine, passed:selected.length, checks, details };
  fs.writeFileSync(path.resolve(__dirname,'../test-output',prefix+'-native-'+engine+'.json'),
    JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
};
