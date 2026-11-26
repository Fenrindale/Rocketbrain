'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {jdbcReadback} = require('./java-source-analysis-host');
const {until} = require('./helpers/stdio-lsp');
const {kotlinPath,kotlinOnly,populate} = require('./helpers/kotlin-rename-fixture');

async function runKotlinRenameChecks(api,vscode,checks) {
  const service = api.java.kotlinEditor;
  assert.ok(service?.rename?.prepare && (await vscode.commands.getCommands(true)).includes('rocketbrain.kotlinEditor.previewRename'));
  const workspace = await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
  const owned = await fs.mkdtemp(path.join(workspace,'rb-krename-'));
  const root = path.join(owned,'primary'), other = path.join(owned,'neighbor');
  const config = vscode.workspace.getConfiguration('rocketbrain.kotlinEditor'), target = vscode.ConfigurationTarget.Global;
  const settings = [['serverHome',process.env.ROCKETBRAIN_KOTLIN_EDITOR_HOME],
    ['gradleUserHome',process.env.ROCKETBRAIN_KOTLIN_EDITOR_GRADLE_HOME]];
  const originals = [];
  try {
    await populate(root);
    await populate(other);
    for (const [name,value] of settings) {
      assert.ok(value,'Configure '+name+' for native Kotlin rename.');
      originals.push([name,config.inspect(name)?.globalValue]);
      await config.update(name,value,target);
    }
    const start = await service.start({projectUri:vscode.Uri.file(root).toString()});
    assert.equal(start.serverVersion,'1.4.0-rc1');
    const source = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root,kotlinOnly.begins[0])));
    const declaration = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root,kotlinPath('Invoice.kt'))));
    const observedNeighbor = path.join(other,kotlinPath('Invoice.kt')), originalNeighbor = await fs.readFile(observedNeighbor,'utf8');
    const documents = [source,declaration], originalsText = documents.map(document=>document.getText());
    await vscode.window.showTextDocument(source,{preview:false});
    const [,needle,shift] = kotlinOnly.begins;
    const position = source.positionAt(source.getText().indexOf(needle)+shift);
    await until(async()=>{
      const found = await service.definition(source,position);
      return found?.some(item=>{
        const uri = vscode.Uri.parse(item.targetUri||item.uri);
        return !path.relative(uri.fsPath,declaration.uri.fsPath);
      });
    },65000);
    const prepare = newName=>service.rename.prepare({document:source,position,newName});
    await assert.rejects(prepare('cents'),/already appears/u);
    const stale = await prepare(kotlinOnly.newName);
    await vscode.window.showTextDocument(declaration,{preview:false});
    const change = new vscode.WorkspaceEdit();
    change.insert(declaration.uri,declaration.positionAt(declaration.getText().length),'// changed after review\n');
    assert.ok(await vscode.workspace.applyEdit(change));
    await assert.rejects(api.java.refactoring.apply(stale.id),/Kotlin.*(?:changed|source buffers)|source file changed/u);
    await vscode.commands.executeCommand('undo');
    await until(()=>declaration.getText()===originalsText[1]&&!declaration.isDirty,10000);

    const plan = await prepare(kotlinOnly.newName);
    assert.equal(plan.documents.length,2);
    assert.equal(plan.rename.scope,'kotlin-project');
    assert.equal(plan.rename.referenceCount,1);
    assert.equal(plan.resourceOperations.length,0);
    for (let index=0;index<plan.documents.length;index++) {
      const file = plan.documents[index];
      const after = await vscode.workspace.openTextDocument(vscode.Uri.parse('rocketbrain-java-refactor:/'+plan.id+'/'+index+'/after.kt'));
      assert.equal(after.getText(),file.after);
    }
    const saved = await Promise.all(documents.map(document=>fs.readFile(document.uri.fsPath,'utf8')));
    const applied = await api.java.refactoring.apply(plan.id);
    assert.equal(applied.state,'applied');
    assert.equal(applied.savedToDisk,false);
    assert.match(source.getText(),/val number = invoice\.invoiceNumber/u);
    assert.match(declaration.getText(),/val invoiceNumber: String/u);
    assert.deepEqual(await Promise.all(documents.map(document=>fs.readFile(document.uri.fsPath,'utf8'))),saved);
    assert.equal(await fs.readFile(observedNeighbor,'utf8'),originalNeighbor);
    const edited = documents.map(document=>document.getText());
    await vscode.window.showTextDocument(source,{preview:false});
    await vscode.commands.executeCommand('undo');
    await until(()=>documents.every((document,index)=>document.getText()===originalsText[index]),10000);
    await vscode.commands.executeCommand('redo');
    await until(()=>documents.every((document,index)=>document.getText()===edited[index]),10000);
    await vscode.commands.executeCommand('undo');
    await until(()=>documents.every((document,index)=>document.getText()===originalsText[index]),10000);
    const jdbc = await jdbcReadback();
    assert.ok(jdbc);
    checks.push('Native Kotlin symbol review applied compiler-linked text edits to two files with one Undo/Redo and refused a stale candidate, a collision and changes to the neighboring project.');
    return {server:start.serverVersion,files:2,references:1,neighborUnchanged:true,collisionRefused:true,
      staleBufferRefused:true,nativeUndoRedo:true,diskUntouched:true,jdbc};
  } finally {
    await service.stop();
    for (const document of vscode.workspace.textDocuments) {
      if (document.uri.scheme==='file' && document.uri.fsPath.startsWith(owned+path.sep) && document.isDirty) await document.save();
    }
    for (const [name,previous] of originals.reverse()) await config.update(name,previous,target);
    const physical = await fs.realpath(owned);
    if (path.relative(path.dirname(physical),workspace) || !path.basename(physical).startsWith('rb-krename-')) {
      throw Error('The owned native Kotlin rename fixture changed identity.');
    }
    await fs.rm(physical,{recursive:true,force:true,maxRetries:8,retryDelay:250});
  }
}

module.exports = {runKotlinRenameChecks};
