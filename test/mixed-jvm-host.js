'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { importedSpring,jdbcReadback } = require('./java-source-analysis-host');
const { copyMixedProject,mixedFile,EXPECTED } = require('./helpers/mixed-jvm-fixture');

async function runMixedJvmChecks(api,vscode,checks) {
  const service = api.java.workbench.mixedJvm;
  assert.ok(service?.buildAndIndex && service?.definition && service?.run);
  const workspace = await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
  await importedSpring(api,workspace);
  const commands = await vscode.commands.getCommands(true);
  for (const id of ['rocketbrain.java.mixed.build','rocketbrain.java.mixed.definition','rocketbrain.java.mixed.run']) {
    assert.ok(commands.includes(id));
  }
  const fixture = await fs.mkdtemp(path.join(workspace,'rb-mixed-jvm-'));
  const uri = vscode.Uri.file(fixture), projectUri = uri.toString();
  const owned = new Map();
  try {
    await copyMixedProject(fixture,'gradle');
    const view = await api.java.workbench.resyncProject({projectUri,allowProjectExecution:true});
    const project = view.projects.find(item => !path.relative(item.root,fixture));
    assert.deepEqual(project.languages,['java','kotlin']);
    const roots = project.sourceRoots.flatMap(root => root.packages);
    assert.ok(roots.some(pkg => pkg.name === 'mixed.fixture' && pkg.files.some(file => file.name === 'KotlinGateway.kt')));
    const document = async name => {
      if (!owned.has(name)) owned.set(name,await vscode.workspace.openTextDocument(vscode.Uri.file(mixedFile(fixture,name))));
      return owned.get(name);
    };
    const java = await document('JavaApplication.java'), kotlin = await document('KotlinGateway.kt');
    assert.equal(kotlin.languageId,'kotlin');
    await vscode.window.showTextDocument(java,{preview:false});
    await assert.rejects(service.buildAndIndex({projectUri}),/before executing project code/);
    const built = await vscode.commands.executeCommand('rocketbrain.java.mixed.build');
    assert.ok(built?.classes >= 3);
    assert.deepEqual(built.languages,['java','kotlin']);

    const references = [];
    for (const proof of EXPECTED) {
      const selected = await document(proof.source), target = await document(proof.target);
      const raw = selected.getText().indexOf(proof.marker);
      assert.ok(raw >= 0);
      const position = selected.positionAt(raw+proof.advance);
      const found = await service.definition({document:selected,position});
      assert.equal(found.uri.toString(),target.uri.toString());
      assert.equal(found.descriptor,proof.descriptor);
      assert.equal(found.member,proof.member);
      assert.equal(found.kind,proof.kind);
      assert.equal(target.getText(found.selection),proof.anchor);
      const definitions = await vscode.commands.executeCommand('vscode.executeDefinitionProvider',selected.uri,position);
      assert.ok(definitions.some(item => (item.targetUri || item.uri)?.toString() === target.uri.toString()));
      references.push({from:proof.source,to:proof.target,kind:proof.kind,descriptor:proof.descriptor});
    }

    const javaEditor = await vscode.window.showTextDocument(java,{preview:false});
    const caller = java.positionAt(java.getText().indexOf('transform(number)')+1);
    javaEditor.selection = new vscode.Selection(caller,caller);
    const target = await vscode.commands.executeCommand('rocketbrain.java.mixed.definition');
    assert.equal(target.document.uri.toString(),kotlin.uri.toString());
    assert.equal(target.document.getText(target.selection),'transform');

    const helper = mixedFile(fixture,'JavaHelper.java'), original = await fs.readFile(helper,'utf8');
    await fs.appendFile(helper,'// edited after index\n');
    try {
      await assert.rejects(service.definition({document:kotlin,position:kotlin.positionAt(kotlin.getText().indexOf('render(number')+1)}),
        /source, build or output files changed/);
    } finally { await fs.writeFile(helper,original); }
    const result = await service.run({projectUri,allowProjectExecution:true});
    assert.equal(result.state,'succeeded');
    assert.match(result.task,/(^|:)run$/);
    const jdbc = await jdbcReadback();
    checks.push('Mixed JVM workbench built and ran a real Gradle Java/Kotlin app, browsed Kotlin packages, navigated exact JVM calls, getters and inheritance in both languages, and refused stale sources.');
    return {languages:built.languages,classes:built.classes,sourceFiles:built.sourceFiles,references,nativeDefinition:true,
      staleSourceRejected:true,gradleRun:true,springWorkspace:true,jdbc};
  } finally {
    for (const editor of vscode.window.visibleTextEditors.filter(value => value.document.uri.scheme === 'file' &&
      value.document.uri.fsPath.startsWith(fixture+path.sep))) {
      await vscode.window.showTextDocument(editor.document);
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    }
    await api.java.executeWorkspaceCommand('java.project.changeImportedProjects',[],[],[projectUri]).catch(() => {});
    const verified = await fs.realpath(fixture);
    if (path.dirname(verified) !== workspace || !path.basename(verified).startsWith('rb-mixed-jvm-')) {
      throw Error('Mixed JVM fixture ownership changed before cleanup.');
    }
    await fs.rm(verified,{recursive:true,force:true,maxRetries:8,retryDelay:300});
  }
}

module.exports = { runMixedJvmChecks };
