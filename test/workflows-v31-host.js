'use strict';

const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const vscode=require('vscode');

exports.run=async()=>{
  const extension=vscode.extensions.getExtension('rocketbrain-local.rocketbrain');
  assert.ok(extension);
  const engine=process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE;
  assert.ok(['mysql','mariadb'].includes(engine));
  const prefix=process.env.ROCKETBRAIN_TEST_REPORT_PREFIX||'v0.31';
  assert.match(prefix,/^v0\.31(?:-[a-z0-9-]+)?$/);
  const api=await extension.activate(),checks=[],details={};
  const suites={
    sql:()=>require('./sql-editing-host').runSqlEditingChecks(api,vscode,checks),
    datasets:()=>require('./db-datasets-v31-host').runDbDatasetsV31Checks(api,vscode,checks),
    transfer:()=>require('./table-transfer-host').runTableTransferChecks(api,vscode,checks),
    jvm:()=>require('./jvm-diagnostics-host').runJvmDiagnosticsChecks(api,vscode,checks)
  };
  const selected=process.env.ROCKETBRAIN_V31_ONLY?.split(',')||Object.keys(suites);
  assert.ok(selected.length&&new Set(selected).size===selected.length);
  for(const workflow of selected) {
    assert.ok(Object.hasOwn(suites,workflow),workflow);
    console.log('Running v0.31 workflow '+workflow);
    details[workflow]=await suites[workflow]();
  }
  const receipt={version:extension.packageJSON.version,extensionPath:extension.extensionPath,
    vscode:vscode.version,engine,passed:selected.length,checks,details};
  fs.writeFileSync(path.resolve(__dirname,'../test-output',prefix+'-native-'+engine+'.json'),
    JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
};
