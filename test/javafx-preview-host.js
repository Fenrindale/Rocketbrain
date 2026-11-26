'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {jdbcReadback}=require('./java-source-analysis-host');
const fixture=require('./helpers/javafx-preview');

async function runJavaFxPreviewChecks(api,vscode,checks) {
  const workspace=await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
  const owned=await fs.mkdtemp(path.join(workspace,'rb-javafx-preview-'));
  const source=path.join(owned,fixture.source),stylesheet=path.join(owned,fixture.stylesheet);
  let panel,styleEditor,styleOriginal;
  function png() {
    const value=/data:image\/png;base64,([A-Za-z0-9+/=]+)"/u.exec(panel.webview.html);
    assert.ok(value,'JavaFX preview did not provide a PNG.');
    return Buffer.from(value[1],'base64');
  }
  try {
    await fs.cp(fixture.fixture,owned,{recursive:true});
    const original=await fs.readFile(source,'utf8');
    assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.javafx.preview'));
    assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.javafx.refreshPreview'));
    const document=await vscode.workspace.openTextDocument(vscode.Uri.file(source));
    await vscode.window.showTextDocument(document,{preview:false});
    const request={document,width:96,height:72,allowPreview:true};
    await assert.rejects(api.java.fx.preview({...request,allowPreview:false}),/trusted workspace/u);
    const first=await api.java.fx.preview(request);
    assert.equal(first.runtime,'26.0.2+3');
    assert.deepEqual([first.resourceCount,first.controllersOmitted,first.handlersOmitted],[3,1,1]);
    panel=api.java.fx.showPreview(first);
    assert.equal(panel.viewType,'rocketbrainFxmlPreview');
    assert.match(panel.webview.html,/controller and event hookups omitted/u);
    const initial=fixture.imageProof(png(),first);
    const css=await vscode.workspace.openTextDocument(vscode.Uri.file(stylesheet));
    styleOriginal=css.getText();
    styleEditor=await vscode.window.showTextDocument(css,{preview:false});
    assert.ok(await styleEditor.edit(edit=>edit.replace(new vscode.Range(css.positionAt(0),css.positionAt(css.getText().length)),
      fixture.changed(styleOriginal))));
    await assert.rejects(api.java.fx.preview(request),/Save the selected FXML/u);
    assert.ok(await css.save());
    const second=await vscode.commands.executeCommand('rocketbrain.javafx.refreshPreview');
    const refreshed=fixture.imageProof(png(),second,true);
    assert.notEqual(refreshed.imageSha256,initial.imageSha256);
    assert.equal(await fs.readFile(source,'utf8'),original);
    const jdbc=await jdbcReadback();
    assert.ok(jdbc);
    checks.push('The installed JavaFX panel rendered actual OpenJFX pixels, refreshed a saved stylesheet change, and preserved the original controller and handler resources.');
    return {runtime:second.runtime,width:second.width,height:second.height,initial,refreshed,
      omittedControllers:first.controllersOmitted,omittedHandlers:first.handlersOmitted,dirtyStylesheetRefused:true,jdbc};
  } finally {
    panel?.dispose();
    if (styleEditor?.document.isDirty) {
      const css=styleEditor.document;
      await styleEditor.edit(edit=>edit.replace(new vscode.Range(css.positionAt(0),css.positionAt(css.getText().length)),styleOriginal));
      await css.save();
    }
    const tabs=vscode.window.tabGroups.all.flatMap(group=>group.tabs).filter(tab=>{
      const uri=tab.input.uri;
      if (uri?.scheme!=='file'||uri.authority) return false;
      const relative=path.relative(owned,uri.fsPath);
      return Boolean(relative)&&!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith('..'+path.sep);
    });
    if (tabs.length) await vscode.window.tabGroups.close(tabs);
    const real=await fs.realpath(owned);
    assert.equal(path.relative(workspace,path.dirname(real)),'');
    assert.ok(path.basename(real).startsWith('rb-javafx-preview-'));
    await fs.rm(real,{recursive:true,force:true,maxRetries:8,retryDelay:350});
  }
}

module.exports={runJavaFxPreviewChecks};
