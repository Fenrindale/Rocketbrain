'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { jdbcReadback } = require('./java-source-analysis-host');

exports.run = async (vscode = require('vscode')) => {
  const extension=vscode.extensions.getExtension('rocketbrain-local.rocketbrain');
  assert.equal(extension?.packageJSON.version,'0.125.0');
  const engine=process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE;
  assert.ok(['mysql','mariadb'].includes(engine));
  const prefix=process.env.ROCKETBRAIN_TEST_REPORT_PREFIX || 'v0.125';
  assert.match(prefix,/^v0\.125(?:-[a-z0-9-]+)?$/);
  const log=path.resolve(__dirname,'../test-output',`${prefix}-native-${engine}-progress.jsonl`);
  const mark=(group,state,details={})=>fs.appendFileSync(log,JSON.stringify({group,state,time:new Date().toISOString(),...details})+'\n');
  const api=await extension.activate();
  const checks=[],details={},failures=[];
  const groups={
    javaReviewedBuild:async()=>{
      const {jdbc:applicationJdbc,...report}=await require('./java-source-target-host').runJavaSourceBuildExecutionChecks(api,vscode,checks);
      return {...report,applicationJdbc};
    },
    jpaTransactionOutcomes:()=>require('./spring-jpa-transaction-host').runSpringJpaTransactionChecks(api,vscode,checks),
    jupyterCellDebug:()=>require('./jupyter-debug-host').runJupyterDebugChecks(api,vscode,checks),
    javaCheckedThrows:()=>require('./java-signature-throws-host').runJavaCheckedThrowsChecks(api,vscode,checks),
    kubernetesOperations:async()=>{
      const declared=new Map(extension.packageJSON.contributes.commands.map(item=>[item.command,item]));
      const registered=await vscode.commands.getCommands(true);
      const commands=['rocketbrain.kubernetes.scaleDeployment','rocketbrain.kubernetes.reviewHelmRollback'];
      for(const name of commands){assert.equal(declared.get(name)?.enablement,'isWorkspaceTrusted');assert.ok(registered.includes(name));}
      assert.equal(extension.packageJSON.contributes.menus['view/item/context'].filter(item=>commands.includes(item.command)).length,2);
      checks.push('Installed Kubernetes Deployment Scale and Helm Rollback are reachable from the trusted explorer rows and command palette.');
      return {registered:commands,workspaceTrustRequired:true,rowContextActions:2};
    }
  };
  const names=process.env.ROCKETBRAIN_V125_ONLY?.split(',') || Object.keys(groups);
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
      mark(group,'failed',failures.at(-1));
    }
  }
  const report=path.resolve(__dirname,'../test-output',`${prefix}-native-${engine}${failures.length?'-failed':''}.json`);
  fs.writeFileSync(report,JSON.stringify({version:extension.packageJSON.version,extensionPath:extension.extensionPath,
    vscode:vscode.version,engine,hostPid:process.pid,passed:Object.keys(details).length,checks,details,failures},null,2)+'\n',{flag:'wx'});
  assert.equal(failures.length,0,failures.map(({group,message})=>`${group}: ${message}`).join('\n'));
};
