'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),vscode=require('vscode');
exports.run=async()=>{
 const extension=vscode.extensions.getExtension('rocketbrain-local.rocketbrain');assert.ok(extension);
 const api=await extension.activate(),checks=[],only=process.env.ROCKETBRAIN_REFACTOR_ONLY;
 if(only&&!['move','signature','safeDelete'].includes(only))throw Error('Unknown refactoring test scope.');
 try{
  await api.java.start();
  for(const [name,legacy,current]of [
   ['move',()=>require('./java-move-host').runJavaMoveChecks(api,vscode,checks),()=>require('./java-move-v20-host').runJavaMoveV20Checks(api,vscode,checks)],
   ['signature',()=>require('./java-change-signature-host').runJavaChangeSignatureChecks(api,vscode,checks),()=>require('./java-change-signature-v20-host').runJavaChangeSignatureV20Checks(api,vscode,checks)],
   ['safeDelete',()=>require('./java-safe-delete-host').runJavaSafeDeleteChecks(api,vscode,checks),()=>require('./java-safe-delete-v20-host').runJavaSafeDeleteV20Checks(api,vscode,checks)]
  ])if(!only||only===name){console.log('[v20 refactoring] '+name+' legacy');await legacy();console.log('[v20 refactoring] '+name+' expanded');await current();}
  const engine=process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE,report={asOf:new Date().toISOString(),version:extension.packageJSON.version,vscode:vscode.version,engine,extensionPath:extension.extensionPath,featureScope:only||'all',passed:checks.length,checks};
  fs.writeFileSync(path.resolve(__dirname,'../test-output/'+(process.env.ROCKETBRAIN_TEST_REPORT_PREFIX||'v0.20')+'-refactoring-host-'+engine+'.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
 }finally{await api.java.stop();}
};
