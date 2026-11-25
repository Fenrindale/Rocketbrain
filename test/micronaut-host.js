'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { importedSpring,jdbcReadback } = require('./java-source-analysis-host');

const fixture=path.join(__dirname,'fixtures','java','micronaut');

async function read(base,route,format='text') {
  const response=await fetch(base+route,{signal:AbortSignal.timeout(6000)});
  assert.equal(response.status,200);
  return response[format]();
}

async function runMicronautChecks(api,vscode,checks) {
  const service=api.java.micronaut;
  assert.ok(service?.inspect && service?.run && service?.test && service?.stop);
  const workspace=await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
  await importedSpring(api,workspace);
  const commands=await vscode.commands.getCommands(true);
  for (const command of ['inspect','run','test','stop']) assert.ok(commands.includes('rocketbrain.micronaut.'+command));
  const root=await fs.mkdtemp(path.join(workspace,'rb-mn-'));
  const projectUri=vscode.Uri.file(root).toString();
  const config=vscode.workspace.getConfiguration('rocketbrain.java'), target=vscode.ConfigurationTarget.Global;
  const previous=config.inspect('mavenHome')?.globalValue;
  const resources=path.join(root,'src/main/resources');
  let changed=false;
  try {
    await fs.cp(fixture,root,{recursive:true});
    if (process.env.ROCKETBRAIN_MAVEN_HOME) {
      await config.update('mavenHome',process.env.ROCKETBRAIN_MAVEN_HOME,target);
      changed=true;
    }
    assert.ok(config.get('mavenHome'),'Set ROCKETBRAIN_MAVEN_HOME for the release profile.');
    if (process.env.ROCKETBRAIN_MICRONAUT_MAVEN_REPO) {
      await fs.mkdir(path.join(root,'.mvn'));
      await fs.writeFile(path.join(root,'.mvn/maven.config'),'-Dmaven.repo.local='+path.resolve(process.env.ROCKETBRAIN_MICRONAUT_MAVEN_REPO)+'\n');
    }
    const yamlFile=path.join(resources,'application-proof.yml');
    await fs.writeFile(yamlFile,'greeting:\n  repeat-count: 2\n');
    const view=await api.java.workbench.resyncProject({projectUri,allowProjectExecution:true});
    assert.ok(view.projects.some(project => !path.relative(project.root,root) && project.tool==='maven'));
    const model=await service.inspect({projectUri});
    const settings=model.settings.map(item => [item.key,item.type]);
    assert.deepEqual(settings,[['greeting.message','String'],['greeting.repeat-count','int'],['greeting.suffix','String']]);
    const routes=model.routes.map(item => item.verb+' '+item.path);
    assert.deepEqual(routes,['GET /greeting','GET /greeting/length']);
    assert.equal(model.bindings[0].state,'source-type');
    assert.match(model.bindings[0].type,/GreetingConfiguration$/);
    const properties=await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(resources,'application.properties')));
    const position=properties.positionAt(properties.getText().indexOf('greeting.message')+9);
    const completion=await vscode.commands.executeCommand('vscode.executeCompletionItemProvider',properties.uri,position);
    assert.ok(completion.items.some(item => item.label==='greeting.message' && item.detail==='Micronaut · String'));
    async function definitions(uri,at) {
      const locations=await vscode.commands.executeCommand('vscode.executeDefinitionProvider',uri,at);
      return locations.some(item => path.basename((item.uri||item.targetUri)?.fsPath||'')==='GreetingConfiguration.java');
    }
    assert.equal(await definitions(properties.uri,position),true);
    const yaml=await vscode.workspace.openTextDocument(vscode.Uri.file(yamlFile));
    assert.equal(await definitions(yaml.uri,new vscode.Position(1,5)),true);
    await fs.unlink(yamlFile);
    await assert.rejects(service.test({projectUri}),/Explicitly choose Micronaut tests/);
    assert.equal((await service.test({projectUri,allowProjectExecution:true})).state,'succeeded');
    const suite=await fs.readFile(path.join(root,'target/surefire-reports/TEST-micronautfixture.GreetingControllerTest.xml'),'utf8');
    assert.match(suite,/<testsuite [^>]*tests="2"/);
    assert.match(suite,/<testsuite [^>]*errors="0"/);
    assert.match(suite,/<testsuite [^>]*failures="0"/);
    const compiled=await fs.readdir(path.join(root,'target/classes/micronautfixture'));
    assert.ok(compiled.includes('$GreetingConfiguration$Definition.class') && compiled.includes('$GreetingController$Definition.class'));
    await assert.rejects(service.run({projectUri}),/Explicitly run/);
    const runtime=await service.run({projectUri,environment:'dev',allowProjectExecution:true});
    assert.equal(runtime.environment,'dev');
    const devResponse=await read(runtime.baseUrl,'/greeting');
    assert.equal(devResponse,'dev-world!;dev-world!;');
    const health=await read(runtime.baseUrl,'/health','json');
    assert.equal(health.status,'UP');
    assert.equal((await vscode.commands.executeCommand('rocketbrain.micronaut.stop')).state,'stopped');
    await assert.rejects(fetch(runtime.baseUrl+'/greeting',{signal:AbortSignal.timeout(1000)}));
    const jdbc=await jdbcReadback();
    checks.push('Imported a Micronaut Maven app, completed properties and followed properties/YAML settings to Java, inspected routes and constructor wiring, ran two real HTTP tests and stopped the packaged local dev app.');
    return {platform:model.platformVersion,settings,routes,sourceConstructor:true,completion:true,propertiesDefinition:true,
      yamlDefinition:true,compiledBeans:2,tests:2,environment:runtime.environment,devResponse,health:health.status,
      artifact:runtime.artifact,ownedShutdown:true,springWorkspace:true,jdbc};
  } finally {
    try {await service.stop();}
    finally {
      if (changed) await config.update('mavenHome',previous,target);
      await api.java.executeWorkspaceCommand('java.project.changeImportedProjects',[],[],[projectUri]).catch(() => {});
      const owned=await fs.realpath(root);
      if (path.relative(path.dirname(owned),workspace) || !path.basename(owned).startsWith('rb-mn-')) {
        throw Error('Micronaut fixture ownership changed before cleanup.');
      }
      await fs.rm(owned,{recursive:true,force:true,maxRetries:8,retryDelay:250});
    }
  }
}

module.exports={runMicronautChecks};
