'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { jdbcReadback } = require('./java-source-analysis-host');
const { until } = require('./helpers/stdio-lsp');
const { createFixture, buildFixture, exerciseCompletion, runtimeLoad } = require('./helpers/javafx-completion-fixture');

async function runJavaFxCompletionChecks(api, vscode, checks) {
  const libs=process.env.ROCKETBRAIN_FXML_COMPLETION_LIBS;
  assert.ok(path.isAbsolute(libs||''),'Set the owned OpenJFX completion fixture JAR directory.');
  const workspace=await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
  const root=await fs.mkdtemp(path.join(workspace,'rb-fxml-completion-'));
  const uri=vscode.Uri.file(root), projectUri=uri.toString();
  const config=vscode.workspace.getConfiguration('rocketbrain.java',uri);
  const javaHome=config.get('javaHome')||api.java.getState().javaHome;
  const gradleHome=config.get('gradleHome');
  const gradleCache=process.env.GRADLE_USER_HOME || path.join(root,'.owned-gradle');
  async function complete(item) {
    const document=await vscode.workspace.openTextDocument(vscode.Uri.file(item.file));
    const list=await vscode.commands.executeCommand('vscode.executeCompletionItemProvider',document.uri,
      document.positionAt(item.offset));
    return (list?.items||[]).filter(candidate=>candidate.detail?.startsWith('Rocketbrain FXML')).map(candidate=>{
      const range=candidate.range?.replacing||candidate.range;
      return {name:typeof candidate.label==='string'?candidate.label:candidate.label.label,
        text:typeof candidate.insertText==='string'?candidate.insertText:candidate.insertText.value,
        start:document.offsetAt(range.start),end:document.offsetAt(range.end)};
    });
  }
  try {
    const fixture=await createFixture(root,libs), compiled=await buildFixture(fixture,{javaHome,gradleHome,gradleCache});
    const result=await api.java.workbench.resyncProject({projectUri,allowProjectExecution:true});
    assert.ok(result.projects.some(project=>!path.relative(project.root,root)));
    await until(async()=> (await complete(fixture.files.get('custom-tag'))).some(item=>item.name==='RocketLabel'),25000);
    const hydrated=await exerciseCompletion(fixture,complete);
    await runtimeLoad(hydrated,fixture,compiled,javaHome);
    const jdbc=await jdbcReadback();
    assert.ok(jdbc);
    checks.push('The installed FXML provider used JDT-imported OpenJFX and built project members. Completed built-in and custom nodes loaded with the actual FXMLLoader.');
    return {runtime:'26.0.2+3',actualGradle:true,actualJdt:true,loadedCompletedBuiltIn:true,
      loadedCompletedCustom:true,exactRanges:true,booleanValue:true,readOnlyAndInvalidContextsRefused:true,
      nativeProvider:true,jdbc};
  } finally {
    const tabs=vscode.window.tabGroups.all.flatMap(group=>group.tabs).filter(tab=>{
      const value=tab.input?.uri, relative=value?.scheme==='file'&&path.relative(root,value.fsPath);
      return relative && relative!=='..' && !relative.startsWith('..'+path.sep) && !path.isAbsolute(relative);
    });
    if (tabs.length) await vscode.window.tabGroups.close(tabs);
    await api.java.executeWorkspaceCommand('java.project.changeImportedProjects',[],[],[projectUri]).catch(()=>{});
    const real=await fs.realpath(root);
    assert.equal(path.relative(path.dirname(real),workspace),'');
    assert.ok(path.basename(real).startsWith('rb-fxml-completion-'));
    await fs.rm(real,{recursive:true,force:true,maxRetries:10,retryDelay:350});
  }
}

module.exports = { runJavaFxCompletionChecks };
