'use strict';

const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');

exports.run=async(vscode=require('vscode'))=>{
  const extension=vscode.extensions.getExtension('rocketbrain-local.rocketbrain');
  assert.ok(extension);
  assert.equal(extension.packageJSON.version,'0.50.0');
  const engine=process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE;
  assert.ok(['mysql','mariadb'].includes(engine));
  const prefix=process.env.ROCKETBRAIN_TEST_REPORT_PREFIX || 'v0.50';
  assert.match(prefix,/^v0\.50(?:-[a-z0-9-]+)?$/);
  const progress=path.resolve(__dirname,'../test-output',prefix+'-native-'+engine+'-progress.jsonl');
  const checkpoint=(group,step)=>fs.appendFileSync(progress,JSON.stringify({group,step,time:new Date().toISOString()})+'\n');
  const api=await extension.activate(),checks=[],details={};
  const suites={
    mcp:()=>require('./ide-mcp-host').runIdeMcpChecks(api,vscode,checks),
    async kotlin() {
      try { return await require('./mixed-jvm-host').runMixedJvmChecks(api,vscode,checks,step=>checkpoint('kotlin',step)); }
      finally { await api.java.stop(); }
    },
    async mongo() {
      const observations={};
      await require('./mongodb-host').runMongoDbChecks(api,vscode,observations);
      assert.ok(observations.mongoDb);
      checks.push('The MongoDB workbench verified actual authenticated catalog and bounded typed find, cancellation, and vendor read-role protection.');
      return observations.mongoDb;
    }
  };
  const selected=process.env.ROCKETBRAIN_V50_ONLY?.split(',') || Object.keys(suites);
  assert.ok(selected.length && new Set(selected).size===selected.length);
  for (const name of selected) {
    assert.ok(Object.hasOwn(suites,name),name);
    checkpoint(name,'started');
    console.log('Running Rocketbrain v0.50 workflow '+name);
    details[name]=await suites[name]();
    checkpoint(name,'completed');
  }
  const report=path.resolve(__dirname,'../test-output',prefix+'-native-'+engine+'.json');
  const receipt={version:extension.packageJSON.version,extensionPath:extension.extensionPath,
    vscode:vscode.version,engine,hostPid:process.pid,passed:selected.length,checks,details};
  fs.writeFileSync(report,JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
};
