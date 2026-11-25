'use strict';

const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');

exports.run=async(vscode=require('vscode'))=>{
  const extension=vscode.extensions.getExtension('rocketbrain-local.rocketbrain');
  assert.ok(extension);
  assert.equal(extension.packageJSON.version,'0.47.0');
  const engine=process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE;
  assert.ok(['mysql','mariadb'].includes(engine));
  const prefix=process.env.ROCKETBRAIN_TEST_REPORT_PREFIX || 'v0.47';
  assert.match(prefix,/^v0\.47(?:-[a-z0-9-]+)?$/);
  const api=await extension.activate(),checks=[],details={};
  const suites={
    grpc:()=>require('./grpc-client-host').runGrpcChecks(api,vscode,checks),
    jdbc:()=>require('./jdbc-host').runJdbcChecks(api,vscode,checks),
    security:()=>require('./spring-security-host').runSpringSecurityChecks(api,vscode,checks)
  };
  const selected=process.env.ROCKETBRAIN_V47_ONLY?.split(',') || Object.keys(suites);
  assert.ok(selected.length && new Set(selected).size===selected.length);
  for (const name of selected) {
    assert.ok(Object.hasOwn(suites,name),name);
    console.log('Running Rocketbrain v0.47 workflow '+name);
    details[name]=await suites[name]();
  }
  const report=path.resolve(__dirname,'../test-output',prefix+'-native-'+engine+'.json');
  const receipt={version:extension.packageJSON.version,extensionPath:extension.extensionPath,
    vscode:vscode.version,engine,hostPid:process.pid,passed:selected.length,checks,details};
  fs.writeFileSync(report,JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
};
