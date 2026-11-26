'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {jdbcReadback}=require('./java-source-analysis-host');
const fixture=require('./helpers/kmp-compose-preview');

async function runKmpComposePreviewChecks(api,vscode,checks) {
  const service=api.java.kotlinMultiplatform;
  assert.ok(service?.composeCandidates&&service?.preview&&service?.showComposePreview);
  const workspace=await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
  const root=await fs.mkdtemp(path.join(workspace,'rb-kmp-compose-'));
  const projectUri=vscode.Uri.file(root).toString();
  const config=vscode.workspace.getConfiguration('rocketbrain.kotlin'),scope=vscode.ConfigurationTarget.Global;
  const changes=[];
  async function setting(name,value) {
    if (!value) return;
    changes.push([name,config.inspect(name)?.globalValue]);
    await config.update(name,value,scope);
  }
  const commands=await vscode.commands.getCommands(true);
  assert.ok(commands.includes('rocketbrain.kotlin.multiplatform.previewCompose'));
  assert.ok(commands.includes('rocketbrain.kotlin.multiplatform.refreshComposePreview'));
  let editor,document,panel,source;
  function setBuffer(next) {
    return editor.edit(edit=>edit.replace(new vscode.Range(document.positionAt(0),document.positionAt(document.getText().length)),next));
  }
  function png() {
    const match=/data:image\/png;base64,([A-Za-z0-9+/=]+)"/u.exec(panel.webview.html);
    assert.ok(match,'The Compose panel did not receive a PNG.');
    return Buffer.from(match[1],'base64');
  }
  try {
    await fs.cp(fixture.fixture,root,{recursive:true});
    await setting('gradleHome',process.env.ROCKETBRAIN_COMPOSE_GRADLE_HOME||process.env.ROCKETBRAIN_KMP_GRADLE_HOME);
    await setting('gradleUserHome',process.env.ROCKETBRAIN_COMPOSE_GRADLE_USER_HOME||process.env.ROCKETBRAIN_KMP_GRADLE_USER_HOME);
    const options={projectUri,allowProjectExecution:true};
    const model=await service.inspect(options);
    assert.ok(model.modules.some(module=>module.targets.some(target=>target.name==='desktop'&&target.platform==='jvm')));
    document=await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root,fixture.sourceFile)));
    editor=await vscode.window.showTextDocument(document,{preview:false});
    source=document.getText();
    const candidates=service.composeCandidates({...options,document});
    assert.equal(candidates.length,1);
    const [entry]=candidates,request={...options,...entry,document,width:96,height:72};
    await assert.rejects(service.preview({...request,allowProjectExecution:false}),/Explicitly choose/u);
    const rendered=await service.preview(request);
    panel=service.showComposePreview(rendered);
    assert.equal(panel.viewType,'rocketbrainComposePreview');
    assert.match(panel.webview.html,/Refresh Preview/u);
    assert.match(panel.webview.html,/previewfixture\.InventoryPreview/u);
    const before=fixture.verifyImage(png(),rendered,'initial');
    assert.ok(await setBuffer(fixture.updated(source)));
    await assert.rejects(service.preview(request),/Save modified Kotlin/u);
    assert.equal(rendered.imageSha256,before.imageSha256);
    assert.ok(await document.save());
    const refreshed=await vscode.commands.executeCommand('rocketbrain.kotlin.multiplatform.refreshComposePreview');
    const after=fixture.verifyImage(png(),refreshed,'updated');
    assert.notEqual(after.imageSha256,before.imageSha256);
    assert.notEqual(after.sourceSha256,before.sourceSha256);
    const jdbc=await jdbcReadback();
    assert.ok(jdbc);
    checks.push('The installed Kotlin Compose preview rendered genuine Skia pixels for the selected commonMain JVM function, rejected dirty input, and refreshed the existing image panel after a saved Kotlin change.');
    return {qualified:entry.qualified,target:entry.targetName,width:refreshed.width,height:refreshed.height,
      before,after,dirtyRefused:true,jdbc};
  } finally {
    panel?.dispose();
    await service.stop();
    if (editor) {
      await vscode.window.showTextDocument(document);
      if (document.isDirty) {
        await setBuffer(source);
        await document.save();
      }
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    }
    for (const [name,value] of changes.reverse()) await config.update(name,value,scope);
    const owned=await fs.realpath(root);
    assert.equal(path.relative(workspace,path.dirname(owned)),'');
    assert.ok(path.basename(owned).startsWith('rb-kmp-compose-'));
    await fs.rm(owned,{recursive:true,force:true,maxRetries:8,retryDelay:300});
  }
}

module.exports={runKmpComposePreviewChecks};
