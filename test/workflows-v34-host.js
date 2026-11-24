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
  const prefix=process.env.ROCKETBRAIN_TEST_REPORT_PREFIX||'v0.34';
  assert.match(prefix,/^v0\.34(?:-[a-z0-9-]+)?$/);
  const api=await extension.activate(), checks=[], details={};
  const suites={
    explain:()=>require('./explain-measurement-host').runExplainMeasurementChecks(api,vscode,checks),
    relationships:()=>require('./jpa-relationships-host').runJpaRelationshipChecks(api,vscode,checks),
    stream:()=>require('./table-transfer-stream-host').runStreamingTableTransferChecks(api,vscode,checks)
  };
  const selection=process.env.ROCKETBRAIN_V34_ONLY?.split(',')||Object.keys(suites);
  assert.ok(selection.length&&new Set(selection).size===selection.length);
  for(const name of selection){
    assert.ok(Object.hasOwn(suites,name),name);
    console.log('Running v0.34 workflow '+name);
    details[name]=await suites[name]();
  }
  const receipt={version:extension.packageJSON.version,extensionPath:extension.extensionPath,
    vscode:vscode.version,engine,passed:selection.length,checks,details};
  fs.writeFileSync(path.resolve(__dirname,'../test-output',prefix+'-native-'+engine+'.json'),
    JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
};
