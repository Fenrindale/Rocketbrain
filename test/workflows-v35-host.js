'use strict';

const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');

exports.run=async(vscode=require('vscode'))=>{
  const extension=vscode.extensions.getExtension('rocketbrain-local.rocketbrain');
  assert.ok(extension);
  const engine=process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE;
  assert.ok(['mysql','mariadb'].includes(engine));
  const prefix=process.env.ROCKETBRAIN_TEST_REPORT_PREFIX||'v0.35';
  assert.match(prefix,/^v0\.35(?:-[a-z0-9-]+)?$/);
  const api=await extension.activate(), checks=[], details={};
  if(process.env.ROCKETBRAIN_V35_PHASE==='seed'){
    const file=process.env.ROCKETBRAIN_TRANSFER_RESUME_SEED;
    const directory=path.resolve(__dirname,'../test-output');
    const relative=path.relative(directory,path.resolve(file));
    assert.match(relative,/^v0\.35-native-locks-[a-z0-9]+[\\/]resume-seed-(?:mysql|mariadb)\.json$/i);
    const seed=await require('./table-transfer-resume-host').seedRecoverableTransfer(api,checks);
    assert.equal(seed.format,'RocketbrainSavedTransferFixture');
    assert.equal(seed.version,1);
    assert.equal(seed.hostPid,process.pid);
    fs.writeFileSync(file,JSON.stringify({ ...seed, extensionPath:extension.extensionPath, packageVersion:extension.packageJSON.version },null,2)+'\n',{flag:'wx'});
    return;
  }
  const suites={
    explain:()=>require('./explain-series-host').runExplainSeriesChecks(api,vscode,checks),
    relationships:()=>require('./jpa-collection-relationships-host').runJpaCollectionRelationshipChecks(api,vscode,checks),
    stream:()=>require('./table-transfer-resume-host').runResumableTableTransferChecks(api,vscode,checks)
  };
  const selection=process.env.ROCKETBRAIN_V35_ONLY?.split(',')||Object.keys(suites);
  assert.ok(selection.length&&new Set(selection).size===selection.length);
  for(const name of selection){
    assert.ok(Object.hasOwn(suites,name),name);
    console.log('Running v0.35 workflow '+name);
    details[name]=await suites[name]();
  }
  const receipt={version:extension.packageJSON.version,extensionPath:extension.extensionPath,
    vscode:vscode.version,engine,passed:selection.length,checks,details};
  fs.writeFileSync(path.resolve(__dirname,'../test-output',prefix+'-native-'+engine+'.json'),
    JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
};
