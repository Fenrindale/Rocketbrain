'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { importedSpring,jdbcReadback } = require('./java-source-analysis-host');

const fixture=path.join(__dirname,'fixtures','java','kotlin-multiplatform');

async function runKotlinMultiplatformChecks(api,vscode,checks) {
  const service=api.java.kotlinMultiplatform;
  assert.ok(service?.inspect && service?.compile && service?.test && service?.run && service?.definition);
  const workspace=await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
  await importedSpring(api,workspace);
  const commands=await vscode.commands.getCommands(true);
  for (const name of ['inspect','compile','test','run','definition','stop']) {
    assert.ok(commands.includes('rocketbrain.kotlin.multiplatform.'+name));
  }
  const root=await fs.mkdtemp(path.join(workspace,'rb-kmp-'));
  const projectUri=vscode.Uri.file(root).toString();
  const config=vscode.workspace.getConfiguration('rocketbrain.kotlin'), target=vscode.ConfigurationTarget.Global;
  const changes=[];
  async function setting(name,value) {
    if (!value) return;
    const previous=config.inspect(name)?.globalValue;
    await config.update(name,value,target);
    changes.push([name,previous]);
  }
  try {
    await fs.cp(fixture,root,{recursive:true});
    await setting('gradleHome',process.env.ROCKETBRAIN_KMP_GRADLE_HOME);
    await setting('gradleUserHome',process.env.ROCKETBRAIN_KMP_GRADLE_USER_HOME);
    await setting('nodeHome',process.env.ROCKETBRAIN_KMP_NODE_HOME);
    const options={projectUri,allowProjectExecution:true};
    await assert.rejects(service.inspect({projectUri}),/Explicitly choose/);
    const model=await service.inspect(options), [module]=model.modules;
    assert.deepEqual(module.targets.map(item => item.name),['js','jvm']);
    const targets={...options,modulePath:module.path,targetNames:['js','jvm']};
    const built=await service.compile(targets);
    assert.equal(built.state,'succeeded');
    assert.equal(built.linkedDeclarations,9);
    const common=vscode.Uri.file(path.join(root,'src/commonMain/kotlin/kmpfixture/Platform.kt'));
    const document=await vscode.workspace.openTextDocument(common);
    assert.equal(document.languageId,'kotlin');
    const position=new vscode.Position(3,12);
    const actuals=service.definition({document,position});
    assert.deepEqual(actuals.map(item => [item.sourceSet,item.range.start.line]),[['jsMain',3],['jvmMain',4]]);
    const definitions=await vscode.commands.executeCommand('vscode.executeDefinitionProvider',common,position);
    for (const found of actuals) assert.ok(definitions.some(item => (item.uri||item.targetUri)?.toString()===found.uri.toString()));
    const property=service.definition({document,position:new vscode.Position(2,13)});
    assert.deepEqual(property.map(item => item.sourceSet),['jsMain','jvmMain']);
    const jvm=await vscode.workspace.openTextDocument(actuals[1].uri);
    const back=service.definition({document:jvm,position:new vscode.Position(4,12)});
    assert.equal(back[0].uri.toString(),common.toString());
    assert.equal(back[0].range.start.line,3);
    const editor=await vscode.window.showTextDocument(jvm,{preview:false});
    editor.selection=new vscode.Selection(new vscode.Position(4,12),new vscode.Position(4,12));
    const navigated=await vscode.commands.executeCommand('rocketbrain.kotlin.multiplatform.definition');
    assert.equal(navigated.document.uri.toString(),common.toString());
    assert.equal(navigated.document.getText(navigated.selection),'describe');
    const jvmFile=jvm.uri.fsPath, original=await fs.readFile(jvmFile);
    await fs.appendFile(jvmFile,'// changed while reviewing Kotlin sources\n');
    try {assert.throws(() => service.definition({document,position}),/Inspect and build again/);}
    finally {await fs.writeFile(jvmFile,original);}
    assert.equal((await service.test(targets)).state,'succeeded');
    const tests={};
    for (const [platform,task] of [['jvm','jvmTest'],['js','jsNodeTest']]) {
      const directory=path.join(root,'build/test-results',task);
      const files=(await fs.readdir(directory)).filter(name => /^TEST-(?:jsNodeTest\.)?kmpfixture\.PlatformTest\.xml$/.test(name));
      assert.equal(files.length,1,JSON.stringify(files));
      const xml=await fs.readFile(path.join(directory,files[0]),'utf8');
      assert.match(xml,/<testsuite [^>]*tests="2"/);
      assert.match(xml,/<testsuite [^>]*errors="0"/);
      assert.match(xml,/<testsuite [^>]*failures="0"/);
      tests[platform]=2;
    }
    const runs=[];
    for (const platform of ['jvm','js']) {
      const ran=await service.run({...targets,targetNames:[platform]});
      assert.equal(ran.state,'succeeded');
      runs.push({platform,task:ran.tasks[0]});
    }
    const jdbc=await jdbcReadback();
    checks.push('Observed Gradle Kotlin modules/source sets, compiled both JVM and JS, linked expect/actual in both directions with VS Code, rejected stale source, and ran both real test and application targets.');
    return {targets:['jvm','js'],sourceSets:module.sourceSets.map(item => item.name),links:actuals.map(item => ({sourceSet:item.sourceSet,
      line:item.range.start.line+1})),propertyLinks:property.length,linkedDeclarations:built.linkedDeclarations,tests,runs,nativeDefinitions:true,staleRejected:true,springWorkspace:true,jdbc};
  } finally {
    await service.stop();
    for (const editor of vscode.window.visibleTextEditors.filter(item => item.document.uri.fsPath.startsWith(root+path.sep))) {
      await vscode.window.showTextDocument(editor.document);
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    }
    for (const [name,previous] of changes.reverse()) await config.update(name,previous,target);
    const owned=await fs.realpath(root);
    if (path.relative(path.dirname(owned),workspace) || !path.basename(owned).startsWith('rb-kmp-')) {
      throw Error('Kotlin Multiplatform fixture ownership changed before cleanup.');
    }
    await fs.rm(owned,{recursive:true,force:true,maxRetries:8,retryDelay:300});
  }
}

module.exports={runKotlinMultiplatformChecks};
