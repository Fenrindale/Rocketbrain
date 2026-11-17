'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),vscode=require('vscode');
exports.run=async()=>{const extension=vscode.extensions.getExtension('rocketbrain-local.rocketbrain');assert.ok(extension);const api=await extension.activate(),checks=[];try{
 await api.java.start();const only=process.env.ROCKETBRAIN_REFACTOR_ONLY;if(only&&!['move','signature','safeDelete'].includes(only))throw Error('Unknown refactoring test scope.');
 if(!only||only==='move'){console.log('[v19refactor] move');await require('./java-move-host').runJavaMoveChecks(api,vscode,checks);}
 if(!only||only==='signature'){console.log('[v19refactor] signature');await require('./java-change-signature-host').runJavaChangeSignatureChecks(api,vscode,checks);}
 if(!only||only==='safeDelete'){console.log('[v19refactor] safeDelete');await require('./java-safe-delete-host').runJavaSafeDeleteChecks(api,vscode,checks);}
 const engine=process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE,report={asOf:new Date().toISOString(),version:extension.packageJSON.version,vscode:vscode.version,engine,extensionPath:extension.extensionPath,featureScope:only||'all',passed:checks.length,checks};fs.writeFileSync(path.resolve(__dirname,'../test-output/v0.19-refactoring-host-'+engine+'.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
 }finally{await api.java.stop();}};
