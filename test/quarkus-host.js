'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { importedSpring,jdbcReadback } = require('./java-source-analysis-host');

async function read(baseUrl,route,format='text') {
  const response = await fetch(baseUrl+route,{signal:AbortSignal.timeout(6000)});
  assert.equal(response.ok,true);
  return response[format]();
}

async function runQuarkusChecks(api,vscode,checks) {
  const service = api.java.quarkus;
  assert.ok(service?.create && service?.inspect && service?.startDev && service?.stopDev && service?.runTests);
  const workspace = await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
  await importedSpring(api,workspace);
  const commands = await vscode.commands.getCommands(true);
  for (const command of ['create','inspect','startDev','stopDev','runTests']) {
    assert.ok(commands.includes('rocketbrain.quarkus.'+command));
  }
  const name='rb-quarkus-'+randomBytes(4).toString('hex');
  const options={parent:workspace,name};
  await assert.rejects(service.create(options),/trusted workspace/);
  const fixture=await service.create({...options,allowProjectWrites:true});
  const projectUri=vscode.Uri.file(fixture.root).toString();
  const config=vscode.workspace.getConfiguration('rocketbrain.java');
  const previous=config.inspect('mavenHome')?.globalValue;
  let changed=false;
  try {
    if (process.env.ROCKETBRAIN_MAVEN_HOME) {
      await config.update('mavenHome',process.env.ROCKETBRAIN_MAVEN_HOME,vscode.ConfigurationTarget.Global);
      changed=true;
    }
    assert.ok(config.get('mavenHome'),'Set ROCKETBRAIN_MAVEN_HOME or configure the isolated profile.');
    if (process.env.ROCKETBRAIN_QUARKUS_MAVEN_REPO) {
      const repo=path.resolve(process.env.ROCKETBRAIN_QUARKUS_MAVEN_REPO);
      await fs.mkdir(path.join(fixture.root,'.mvn'));
      await fs.writeFile(path.join(fixture.root,'.mvn','maven.config'),'-Dmaven.repo.local='+repo+'\n');
    }
    const imported=await api.java.workbench.resyncProject({projectUri,allowProjectExecution:true});
    assert.ok(imported.projects.some(project => !path.relative(project.root,fixture.root) && project.tool==='maven'));
    const report=await service.inspect({projectUri});
    const configuration=report.configuration.map(item => ({key:item.key,type:item.type}));
    assert.deepEqual(configuration,[{key:'greeting.copies',type:'int'},
      {key:'greeting.suffix',type:'String'},{key:'greeting.text',type:'String'}]);
    const endpoints=report.endpoints.map(item => item.verb+' '+item.path);
    assert.deepEqual(endpoints,['GET /greeting','GET /greeting/page']);
    assert.equal(report.templates[0].name,'greeting.html');
    assert.ok(report.templates[0].uri);
    const props=await vscode.workspace.openTextDocument(vscode.Uri.file(report.propertiesFile));
    const position=props.positionAt(props.getText().indexOf('greeting.text')+7);
    const suggestions=await vscode.commands.executeCommand('vscode.executeCompletionItemProvider',props.uri,position);
    assert.ok(suggestions.items.some(item => item.label==='greeting.text' && item.detail==='Quarkus · String'));
    const targets=await vscode.commands.executeCommand('vscode.executeDefinitionProvider',props.uri,position);
    assert.ok(targets.some(item => path.basename((item.uri||item.targetUri)?.fsPath||'')==='GreetingConfig.java'));
    await assert.rejects(service.runTests({projectUri}),/Explicitly choose Quarkus tests/);
    const tested=await service.runTests({projectUri,allowProjectExecution:true});
    assert.equal(tested.state,'succeeded');
    const suite=await fs.readFile(path.join(fixture.root,'target','surefire-reports','TEST-demo.quarkus.GreetingResourceTest.xml'),'utf8');
    assert.match(suite,/<testsuite [^>]*tests="2"/);
    assert.match(suite,/<testsuite [^>]*failures="0"/);
    assert.match(suite,/<testsuite [^>]*errors="0"/);
    await assert.rejects(service.startDev({projectUri}),/Explicitly choose Quarkus dev mode/);
    const ready=await service.startDev({projectUri,allowProjectExecution:true});
    assert.match(ready.baseUrl,/^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(await read(ready.baseUrl,'/greeting'),'dev-world!;dev-world!;');
    assert.match(await read(ready.baseUrl,'/greeting/page'),/<p class="greeting">dev-world!<\/p>/);
    const health=await read(ready.baseUrl,'/q/health/ready','json');
    assert.equal(health.status,'UP');
    assert.equal((await service.stopDev()).state,'stopped');
    await assert.rejects(fetch(ready.baseUrl+'/greeting',{signal:AbortSignal.timeout(1000)}));
    const jdbc=await jdbcReadback();
    checks.push('Quarkus Maven scaffold imported into Java Projects, native properties completion and declaration navigation, 2 real Maven HTTP tests, dev profile REST/Qute and health, and owned listener shutdown.');
    return {createdFiles:fixture.files,version:report.version,configuration,endpoints,qute:true,tests:2,
      devProfile:ready.profile,health:health.status,stopped:true,completion:true,definition:true,springWorkspace:true,jdbc};
  } finally {
    try { await service.stopDev(); }
    finally {
      if (changed) await config.update('mavenHome',previous,vscode.ConfigurationTarget.Global);
      await api.java.executeWorkspaceCommand('java.project.changeImportedProjects',[],[],[projectUri]).catch(() => {});
      const verified=await fs.realpath(fixture.root);
      if (path.relative(path.dirname(verified),workspace) || path.basename(verified)!==name) {
        throw Error('Quarkus fixture ownership changed before cleanup.');
      }
      await fs.rm(verified,{recursive:true,force:true,maxRetries:8,retryDelay:300});
    }
  }
}

module.exports = { runQuarkusChecks };
