'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { jdbcReadback } = require('./java-source-analysis-host');

exports.run = async (vscode = require('vscode')) => {
  const extension = vscode.extensions.getExtension('rocketbrain-local.rocketbrain');
  assert.equal(extension?.packageJSON.version, '0.55.0');
  const engine = process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE;
  assert.ok(['mysql','mariadb'].includes(engine));
  const prefix = process.env.ROCKETBRAIN_TEST_REPORT_PREFIX || 'v0.55';
  assert.match(prefix,/^v0\.55(?:-[a-z0-9-]+)?$/);
  const log = path.resolve(__dirname,'../test-output',`${prefix}-native-${engine}-progress.jsonl`);
  const mark = (group,state) => fs.appendFileSync(log,JSON.stringify({group,state,time:new Date().toISOString()})+'\n');
  const api = await extension.activate();
  const checks = [], details = {}, failures = [];
  const groups = {
    ssh: () => require('./ssh-workspace-host').runSshWorkspaceChecks(api,vscode,checks),
    review: () => require('./sql-proposal-review-host').runSqlProposalReviewChecks(api,vscode,checks),
    async vue() {
      const result=await require('./vue-workbench-host').runVueWorkbenchChecks(api,vscode,checks);
      return { ...result,jdbc:await jdbcReadback() };
    },
    kotlin: () => require('./kotlin-editor-host').runKotlinEditorChecks(api,vscode,checks)
  };
  const names=process.env.ROCKETBRAIN_V55_ONLY?.split(',') || Object.keys(groups);
  assert.ok(names.length && names.every(name=>Object.hasOwn(groups,name)) && new Set(names).size===names.length);
  try {
    for(const group of names) {
      mark(group,'started');
      try {
        details[group]=await groups[group]();
        assert.ok(details[group],group+' returned no proof.');
        mark(group,'completed');
      } catch(error) {
        failures.push({group,message:String(error.message||error).slice(0,1400)});
        mark(group,'failed');
      }
    }
  } finally { await api.java.stop(); }
  const report=path.resolve(__dirname,'../test-output',`${prefix}-native-${engine}${failures.length?'-failed':''}.json`);
  fs.writeFileSync(report,JSON.stringify({version:extension.packageJSON.version,extensionPath:extension.extensionPath,
    vscode:vscode.version,engine,hostPid:process.pid,passed:Object.keys(details).length,checks,details,failures},null,2)+'\n',{flag:'wx'});
  assert.equal(failures.length,0,failures.map(({group,message})=>`${group}: ${message}`).join('\n'));
};
