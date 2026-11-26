'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { importedSpring,jdbcReadback } = require('./java-source-analysis-host');
const { populateScala,scala2,scala3 } = require('./helpers/scala-fixture');

async function runScalaSbtChecks(api,vscode,checks,version=scala3) {
  const service=api.java.scala;
  assert.ok(service?.discover && service?.compile && service?.test && service?.run && service?.definition && service?.references);
  const workspace=await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
  await importedSpring(api,workspace);
  const ids=await vscode.commands.getCommands(true);
  for (const id of ['discover','compile','test','run','definition','stop']) assert.ok(ids.includes('rocketbrain.scala.'+id));
  const root=await fs.mkdtemp(path.join(workspace,'rb-scala-'));
  const projectUri=vscode.Uri.file(root).toString();
  const config=vscode.workspace.getConfiguration('rocketbrain.scala'), target=vscode.ConfigurationTarget.Global;
  const changes=[];
  async function setting(name,value) {
    if (!value) return;
    const previous=config.inspect(name)?.globalValue;
    await config.update(name,value,target);
    changes.push([name,previous]);
  }
  try {
    await populateScala(root,version);
    await setting('sbtLauncher',process.env.ROCKETBRAIN_SBT_LAUNCHER);
    await setting('cacheDirectory',process.env.ROCKETBRAIN_SBT_CACHE);
    await setting('repositoryConfig',process.env.ROCKETBRAIN_SBT_REPOSITORIES);
    assert.ok(config.get('sbtLauncher'),'Configure the official launcher or set ROCKETBRAIN_SBT_LAUNCHER.');
    const input={projectUri,allowProjectExecution:true};
    await assert.rejects(service.discover({projectUri}),/Explicitly choose the sbt task/);
    const catalog=await service.discover(input);
    assert.equal(catalog.state,'succeeded',catalog.output);
    const projects=catalog.projects.map(item => item.id);
    assert.deepEqual(projects,['app','core','root']);
    await assert.rejects(service.compile({...input,projectId:'unknown-module'}),/Discover current sbt project IDs/);
    const app={...input,projectId:'app'};
    const compiled=await service.compile(app);
    assert.equal(compiled.state,'succeeded',compiled.output);
    assert.equal(compiled.indexedDocuments,2);
    const source=vscode.Uri.file(path.join(root,'app/src/main/scala/scalafixture/Application.scala'));
    const targetFile=path.join(root,'core/src/main/scala/scalafixture/Message.scala');
    const document=await vscode.workspace.openTextDocument(source);
    assert.equal(document.languageId,'scala');
    const definitions=[];
    for (const [line,character] of [[3,35],[4,32]]) {
      const position=new vscode.Position(line,character);
      const found=service.definition({document,position});
      assert.equal(found.range.start.line,line);
      assert.equal(path.relative(found.uri.fsPath,targetFile),'');
      const native=await vscode.commands.executeCommand('vscode.executeDefinitionProvider',document.uri,position);
      assert.ok(native.some(item => path.relative((item.uri||item.targetUri).fsPath,targetFile)==='' &&
        (item.range||item.targetSelectionRange).start.line===line));
      const references=service.references({document,position});
      assert.deepEqual(references.map(item=>item.range.start.line),[line]);
      const nativeReferences=await vscode.commands.executeCommand('vscode.executeReferenceProvider',document.uri,position);
      const callers=nativeReferences.filter(item=>path.relative(source.fsPath,item.uri.fsPath)==='');
      assert.deepEqual(callers.map(item=>item.range.start.line),[line]);
      definitions.push({symbol:found.symbol,line:line+1});
    }
    assert.notEqual(definitions[0].symbol,definitions[1].symbol);
    const editor=await vscode.window.showTextDocument(document,{preview:false});
    const position=new vscode.Position(3,35);
    editor.selection=new vscode.Selection(position,position);
    const navigated=await vscode.commands.executeCommand('rocketbrain.scala.definition');
    assert.equal(path.relative(navigated.document.uri.fsPath,targetFile),'');
    assert.equal(navigated.document.getText(navigated.selection),'hello');
    const original=await fs.readFile(targetFile);
    await fs.appendFile(targetFile,'// changed after SemanticDB\n');
    try {
      assert.throws(() => service.definition({document,position}),/compile and index again/i);
      assert.throws(() => service.references({document,position}),/compile and index again/i);
    }
    finally {await fs.writeFile(targetFile,original);}
    const tested=await service.test(app);
    assert.equal(tested.state,'succeeded',tested.output);
    assert.match(tested.output,/Passed: Total 2, Failed 0, Errors 0, Passed 2/);
    const run=await service.run({...app,mainClass:'scalafixture.Application'});
    assert.equal(run.state,'succeeded',run.output);
    assert.match(run.output,/Scala greets Rocketbrain \/ Scala counted 3/);
    const jdbc=await jdbcReadback();
    checks.push('Discovered actual sbt subprojects, compiled Scala and Java, navigated both distinct source overloads via compiler SemanticDB and rejected stale sources, ran MUnit and the observed Scala main.');
    return {sbt:compiled.sbtVersion,scala:version,projects,definitions,indexedDocuments:compiled.indexedDocuments,
      tests:2,runOutput:'Scala greets Rocketbrain / Scala counted 3',staleRejected:true,nativeDefinitions:true,
      nativeReferences:true,springWorkspace:true,jdbc};
  } finally {
    await service.stop();
    for (const editor of vscode.window.visibleTextEditors.filter(item => item.document.uri.fsPath.startsWith(root+path.sep))) {
      await vscode.window.showTextDocument(editor.document);
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    }
    for (const [name,previous] of changes.reverse()) await config.update(name,previous,target);
    const owned=await fs.realpath(root);
    if (path.relative(path.dirname(owned),workspace) || !path.basename(owned).startsWith('rb-scala-')) {
      throw Error('Scala sbt fixture ownership changed before cleanup.');
    }
    await fs.rm(owned,{recursive:true,force:true,maxRetries:8,retryDelay:250});
  }
}

const runScala2ReferencesChecks=(api,vscode,checks)=>runScalaSbtChecks(api,vscode,checks,scala2);

module.exports={runScalaSbtChecks,runScala2ReferencesChecks};
