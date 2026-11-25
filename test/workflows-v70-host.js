'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { jdbcReadback } = require('./java-source-analysis-host');

exports.run = async (vscode = require('vscode')) => {
  const extension=vscode.extensions.getExtension('rocketbrain-local.rocketbrain');
  assert.equal(extension?.packageJSON.version,'0.70.0');
  const engine=process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE;
  assert.ok(['mysql','mariadb'].includes(engine));
  const prefix=process.env.ROCKETBRAIN_TEST_REPORT_PREFIX || 'v0.70';
  assert.match(prefix,/^v0\.70(?:-[a-z0-9-]+)?$/);
  const log=path.resolve(__dirname,'../test-output',`${prefix}-native-${engine}-progress.jsonl`);
  const mark=(group,state)=>fs.appendFileSync(log,JSON.stringify({group,state,time:new Date().toISOString()})+'\n');
  const api=await extension.activate();
  if (process.env.ROCKETBRAIN_V70_PHASE==='draft-seed') {
    await require('./console-draft-history-host').seedConsoleDraftHistory(api,vscode,process.env.ROCKETBRAIN_V70_DRAFT_RECEIPT);
    return;
  }
  const checks=[],details={},failures=[];
  const groups={
    javaInherited:()=>require('./java-inherited-structure-host').runJavaInheritedStructureChecks(api,vscode,checks),
    jpaMultiFetch:()=>require('./jpql-multi-fetch-host').runJpaMultiFetchChecks(api,vscode,checks),
    schemaOptions:()=>require('./schema-compare-options-host').runSchemaCompareOptionsChecks(api,vscode,checks),
    sqlDraftHistory:()=>require('./console-draft-history-host').runConsoleDraftHistoryChecks(api,vscode,checks,process.env.ROCKETBRAIN_V70_DRAFT_RECEIPT)
  };
  const names=process.env.ROCKETBRAIN_V70_ONLY?.split(',') || Object.keys(groups);
  assert.ok(names.length && names.every(name=>Object.hasOwn(groups,name)) && new Set(names).size===names.length);
  for(const group of names) {
    mark(group,'started');
    try {
      const evidence=await groups[group]();
      assert.ok(evidence,group+' returned no proof.');
      details[group]={...evidence,jdbc:await jdbcReadback()};
      mark(group,'completed');
    } catch(error) {
      failures.push({group,message:String(error.message||error).slice(0,1400),
        location:String(error.stack||'').split(/\r?\n/).find(line=>/test[\\/].+-host\.js:\d+/.test(line))?.trim()});
      mark(group,'failed');
    }
  }
  const report=path.resolve(__dirname,'../test-output',`${prefix}-native-${engine}${failures.length?'-failed':''}.json`);
  fs.writeFileSync(report,JSON.stringify({version:extension.packageJSON.version,extensionPath:extension.extensionPath,
    vscode:vscode.version,engine,hostPid:process.pid,passed:Object.keys(details).length,checks,details,failures},null,2)+'\n',{flag:'wx'});
  assert.equal(failures.length,0,failures.map(({group,message})=>`${group}: ${message}`).join('\n'));
};
