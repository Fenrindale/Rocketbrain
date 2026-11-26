'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { jdbcReadback } = require('./java-source-analysis-host');

exports.run = async (vscode = require('vscode')) => {
  const extension=vscode.extensions.getExtension('rocketbrain-local.rocketbrain');
  assert.equal(extension?.packageJSON.version,'0.108.0');
  const engine=process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE;
  assert.ok(['mysql','mariadb'].includes(engine));
  const prefix=process.env.ROCKETBRAIN_TEST_REPORT_PREFIX || 'v0.108';
  assert.match(prefix,/^v0\.108(?:-[a-z0-9-]+)?$/);
  const log=path.resolve(__dirname,'../test-output',`${prefix}-native-${engine}-progress.jsonl`);
  const mark=(group,state,details={})=>fs.appendFileSync(log,JSON.stringify({group,state,time:new Date().toISOString(),...details})+'\n');
  const api=await extension.activate();
  const checks=[],details={},failures=[];
  async function verifyDeployment(name, run) {
    const evidence={};
    await run(api,vscode,evidence);
    assert.ok(evidence[name]);
    checks.push('The installed deployment workbench verified '+name+' against owned real servers.');
    return evidence[name];
  }
  const groups={
    springMavenImports:()=>require('./spring-maven-imports-host').runSpringMavenImportChecks(api,vscode,checks),
    sqlFileProfiles:()=>require('./sql-file-profiles-host').runSqlFileProfilesChecks(api,vscode,checks),
    sftpDeployment:()=>verifyDeployment('sftpDeployment',require('./sftp-deployment-host').runSftpDeploymentChecks),
    namedTestNg:()=>require('./java-testing-named-testng-host').runJavaTestingNamedTestNgChecks(api,vscode,checks),
    javaModuleTests:()=>require('./java-testing-module-path-host').runJavaTestingModulePathChecks(api,vscode,checks),
    ftpsDeployment:()=>verifyDeployment('ftpsDeployment',require('./ftps-deployment-host').runFtpsDeploymentChecks),
    deploymentWatch:()=>verifyDeployment('deploymentWatch',require('./deployment-watch-host').runDeploymentWatchChecks)
  };
  const names=process.env.ROCKETBRAIN_V108_ONLY?.split(',') || Object.keys(groups);
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
