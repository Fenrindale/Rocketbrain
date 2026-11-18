'use strict';
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const vscode=require('vscode');

exports.run=async()=>{
 const extension=vscode.extensions.getExtension('rocketbrain-local.rocketbrain');
 assert.ok(extension);
 const group=process.env.ROCKETBRAIN_V23_GROUP;
 const runs={
  state:()=>require('./java-move-v23-state-host').runJavaMoveV23StateChecks,
  package:()=>require('./java-package-move-v23-host').runJavaPackageMoveV23Checks,
  spring:()=>require('./java-spring-contract-v23-host').runJavaSpringContractV23Checks,
  build:()=>require('./java-build-contract-v23-host').runJavaBuildContractV23Checks
 };
 assert.ok(Object.hasOwn(runs,group));
 const engine=process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE;
 assert.ok(['mysql','mariadb'].includes(engine));
 const checks=[];
 const startedAt=new Date().toISOString();
 const api=await extension.activate();
 let details;
 try{
  await api.java.start();
  details=await runs[group]()(api,vscode,checks);
  assert.ok(checks.length);
 } finally {
  await api.java.stop();
 }
 const prefix=process.env.ROCKETBRAIN_TEST_REPORT_PREFIX||'v0.23';
 const report={version:extension.packageJSON.version,extensionPath:extension.extensionPath,vscode:vscode.version,
  engine,group,startedAt,completedAt:new Date().toISOString(),passed:checks.length,checks,details};
 fs.writeFileSync(path.resolve(__dirname,'../test-output',`${prefix}-native-${group}-${engine}.json`),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({group,engine,passed:checks.length,version:report.version}));
};
