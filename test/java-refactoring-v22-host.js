'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),vscode=require('vscode');
exports.run=async()=>{
 const extension=vscode.extensions.getExtension('rocketbrain-local.rocketbrain');assert.ok(extension);
 const only=process.env.ROCKETBRAIN_V22_ONLY,prefix=process.env.ROCKETBRAIN_TEST_REPORT_PREFIX||'v0.22',engine=process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE,checks=[],legacyFile=path.resolve(__dirname,'../test-output/'+prefix+'-legacy-refactoring-host-'+engine+'.json'),reportFile=path.resolve(__dirname,'../test-output/'+prefix+'-refactoring-host-'+engine+'.json');
 if(only&&!['new','state','package','spring','build'].includes(only))throw Error('Unknown v0.22 refactoring test scope.');
 let legacy;
 if(!only){
  console.log('[v22 refactoring] all legacy/v20/v21 groups');await require('./java-refactoring-v21-host').run();legacy=JSON.parse(fs.readFileSync(reportFile,'utf8'));assert.equal(legacy.engine,engine);assert.equal(legacy.version,extension.packageJSON.version);assert.ok(Array.isArray(legacy.checks));assert.equal(legacy.passed,legacy.checks.length);fs.copyFileSync(reportFile,legacyFile,fs.constants.COPYFILE_EXCL);checks.push(...legacy.checks);
 }
 const api=await extension.activate(),groups=[];
 try{
  await api.java.start();
  for(const [name,run]of [
   ['state',()=>require('./java-move-v22-state-host').runJavaMoveV22StateChecks(api,vscode,checks)],
   ['package',()=>require('./java-package-move-v22-host').runJavaPackageMoveV22Checks(api,vscode,checks)],
   ['spring',()=>require('./java-spring-contract-v22-host').runJavaSpringContractV22Checks(api,vscode,checks)],
   ['build',()=>require('./java-build-contract-v22-host').runJavaBuildContractV22Checks(api,vscode,checks)]
  ])if(!only||only==='new'||only===name){console.log('[v22 refactoring] '+name);const before=checks.length;await run();groups.push({name,passed:checks.length-before});}
  const report={asOf:new Date().toISOString(),version:extension.packageJSON.version,vscode:vscode.version,engine,extensionPath:extension.extensionPath,featureScope:only||'all',legacy:legacy?{file:legacyFile,passed:legacy.passed,featureScope:legacy.featureScope}:null,newGroups:groups,passed:checks.length,checks};
  fs.writeFileSync(reportFile,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));return report;
 }finally{await api.java.stop();}
};
