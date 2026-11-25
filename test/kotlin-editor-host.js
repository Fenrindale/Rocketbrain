'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { importedSpring,jdbcReadback }=require('./java-source-analysis-host');
const { until }=require('./helpers/stdio-lsp');

const fixture=path.join(__dirname,'fixtures','java','kotlin-editor');

async function runKotlinEditorChecks(api,vscode,checks) {
  const service=api.java.kotlinEditor;
  assert.ok(service?.start && service?.stop && service?.getState);
  const workspace=await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
  await importedSpring(api,workspace);
  const commands=await vscode.commands.getCommands(true);
  for (const name of ['start','stop','output']) assert.ok(commands.includes('rocketbrain.kotlinEditor.'+name));
  const root=await fs.mkdtemp(path.join(workspace,'rb-kotlin-editor-'));
  const config=vscode.workspace.getConfiguration('rocketbrain.kotlinEditor'), target=vscode.ConfigurationTarget.Global;
  const changes=[];
  let document,source;
  async function setting(name,value) {
    if (!value) return;
    const previous=config.inspect(name)?.globalValue;
    await config.update(name,value,target);
    changes.push([name,previous]);
  }
  async function replaceBuffer(text) {
    const edit=new vscode.WorkspaceEdit();
    edit.replace(document.uri,new vscode.Range(new vscode.Position(0,0),document.positionAt(document.getText().length)),text);
    assert.equal(await vscode.workspace.applyEdit(edit),true);
  }
  function at(needle,shift=0) {
    const position=document.getText().indexOf(needle);
    assert.ok(position>=0);
    return document.positionAt(position+shift);
  }
  function diagnosticCode(item) {return typeof item.code==='object' ? item.code.value : item.code;}
  try {
    await fs.cp(fixture,root,{recursive:true});
    await setting('serverHome',process.env.ROCKETBRAIN_KOTLIN_EDITOR_HOME);
    await setting('gradleUserHome',process.env.ROCKETBRAIN_KOTLIN_EDITOR_GRADLE_HOME);
    assert.ok(config.get('serverHome'),'Configure ROCKETBRAIN_KOTLIN_EDITOR_HOME for the release profile.');
    const starter=await service.start({projectUri:vscode.Uri.file(root).toString()});
    assert.equal(starter.state,'running');
    assert.equal(starter.serverVersion,'1.4.0-rc1');
    assert.equal(starter.windowsPathAdapter,process.platform==='win32');
    const sourceFile=path.join(root,'src/main/kotlin/editor/fixture/OrderSummary.kt'), targetFile=path.join(root,'src/main/kotlin/editor/fixture/Invoice.kt');
    document=await vscode.workspace.openTextDocument(vscode.Uri.file(sourceFile));
    source=document.getText();
    assert.equal(document.languageId,'kotlin');
    await vscode.window.showTextDocument(document,{preview:false});
    const status=await vscode.commands.executeCommand('rocketbrain.kotlinEditor.start');
    assert.equal(status.state,'running');
    const position=at('invoice.number',10);
    const reference=await until(async()=>{
      const sources=await vscode.commands.executeCommand('vscode.executeDefinitionProvider',document.uri,position);
      return sources?.find(item=>!path.relative((item.uri||item.targetUri)?.fsPath||'',targetFile));
    },70000);
    const anchor=reference.range||reference.targetSelectionRange;
    assert.equal(anchor.start.line,3);
    const hover=await vscode.commands.executeCommand('vscode.executeHoverProvider',document.uri,position);
    assert.match(JSON.stringify(hover),/number: String/);
    await replaceBuffer(source.replace('invoice.number','invoice.num'));
    const complete=await until(async()=>{
      const response=await vscode.commands.executeCommand('vscode.executeCompletionItemProvider',document.uri,at('invoice.num',11));
      return response?.items.find(item => (item.label.label||item.label)==='number' && /String/.test(item.detail));
    },60000);
    assert.ok(complete);
    await replaceBuffer(source.replace('val number = invoice.number','val number: String = 42'));
    const mismatch=await until(()=>vscode.languages.getDiagnostics(document.uri).find(item =>
      diagnosticCode(item)==='CONSTANT_EXPECTED_TYPE_MISMATCH' && item.severity===vscode.DiagnosticSeverity.Error),65000);
    assert.equal(mismatch.range.start.line,3);
    assert.ok(document.isDirty);
    assert.doesNotMatch(await fs.readFile(sourceFile,'utf8'),/number: String = 42/);
    await replaceBuffer(source);
    await until(()=>!vscode.languages.getDiagnostics(document.uri).some(item=>diagnosticCode(item)==='CONSTANT_EXPECTED_TYPE_MISMATCH'),45000);
    assert.equal((await vscode.commands.executeCommand('rocketbrain.kotlinEditor.stop')).state,'stopped');
    const jdbc=await jdbcReadback();
    checks.push('Connected an independent open Kotlin compiler language server in VS Code, navigated a Gradle JVM project, completed and hovered a typed property, got and cleared a real unsaved Kotlin compiler diagnostic, and stopped the owned process.');
    return {server:starter.serverVersion,compiler:starter.compilerVersion,completion:'number',hoverType:'String',
      definition:{name:path.basename(targetFile),line:anchor.start.line+1},diagnostic:{code:diagnosticCode(mismatch),line:4,unsaved:true,cleared:true},
      windowsPathAdapter:starter.windowsPathAdapter,stopped:true,springWorkspace:true,jdbc};
  } finally {
    if (document && source!==undefined && document.getText()!==source) await replaceBuffer(source);
    if (document?.isDirty) await document.save();
    await service.stop();
    for (const editor of vscode.window.visibleTextEditors.filter(item => item.document.uri.fsPath.startsWith(root+path.sep))) {
      await vscode.window.showTextDocument(editor.document);
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    }
    for (const [name,previous] of changes.reverse()) await config.update(name,previous,target);
    const owned=await fs.realpath(root);
    if (path.relative(path.dirname(owned),workspace) || !path.basename(owned).startsWith('rb-kotlin-editor-')) {
      throw Error('Kotlin editor fixture ownership changed before cleanup.');
    }
    await fs.rm(owned,{recursive:true,force:true,maxRetries:8,retryDelay:250});
  }
}

module.exports={runKotlinEditorChecks};
