'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { until, positionOf } = require('./helpers/stdio-lsp');
const { ownerFile, kotlinCaller, javaCaller, sameName, newName, populate, rebuild, runJdbc } = require('./helpers/mixed-type-rename-fixture');

async function runKotlinMixedTypeRenameChecks(api, vscode, checks) {
  const workspace = await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
  const project = await fs.mkdtemp(path.join(workspace, 'rb-mixed-type-rename-'));
  const uri = vscode.Uri.file(project);
  const javaSettings = vscode.workspace.getConfiguration('rocketbrain.java', uri);
  const kotlinSettings = vscode.workspace.getConfiguration('rocketbrain.kotlinEditor', uri);
  const tools = { javaHome: javaSettings.get('javaHome') || api.java.getState().javaHome,
    gradleHome: process.env.ROCKETBRAIN_MIXED_RENAME_GRADLE_HOME || javaSettings.get('gradleHome'),
    gradleUserHome: process.env.ROCKETBRAIN_KOTLIN_EDITOR_GRADLE_HOME || kotlinSettings.get('gradleUserHome') };
  const spring = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const config = JSON.parse(await fs.readFile(spring.dbConfigPath, 'utf8'));
  const saved = file => fs.readFile(path.join(project,file),'utf8');
  const open = file => vscode.workspace.openTextDocument(vscode.Uri.file(path.join(project, file)));
  const contains = file => {
    const relative=path.relative(project,file);
    return relative && relative!=='..' && !relative.startsWith('..'+path.sep) && !path.isAbsolute(relative);
  };
  try {
    await populate(project, tools);
    const baseline=await runJdbc(project,tools,config,spring.dbEngine);
    const shadow=await saved(sameName);
    const document=await open(ownerFile), caller=await open(javaCaller), kotlinUse=await open(kotlinCaller);
    await vscode.window.showTextDocument(caller,{preview:false});
    await vscode.window.showTextDocument(document,{preview:false});
    const position=positionOf(document.getText(),'class Invoice',7);
    const point=new vscode.Position(position.line,position.character);
    await api.java.start();
    await until(async()=>{
      const cp=await api.java.executeWorkspaceCommand('java.project.getClasspaths',uri.toString(),{scope:'runtime'});
      return cp?.projectRoot && cp.classpaths?.some(file=>file.endsWith('spring-jdbc-7.0.10.jar'));
    },100000);
    await api.java.kotlinEditor.start({document});
    const use=positionOf(kotlinUse.getText(),'Invoice(amount)',2);
    await until(async()=>{
      const definitions=await api.java.kotlinEditor.definition(kotlinUse,new vscode.Position(use.line,use.character));
      return definitions?.some(item=>String(item.targetUri||item.uri).endsWith('/Invoice.kt'));
    },65000);
    const plan=await api.java.kotlinEditor.rename.prepare({document,position:point,newName});
    assert.equal(plan.rename.scope,'mixed-public-class');
    assert.equal(plan.rename.kotlinAndJavacVerified,true);
    assert.equal(plan.rename.javaReferences,3);
    assert.equal(plan.documents.length,3);
    assert.deepEqual(plan.resourceOperations,[]);

    async function verify(side) {
      for(const file of plan.documents) {
        const current=await vscode.workspace.openTextDocument(vscode.Uri.parse(file.uri));
        assert.equal(current.getText(),file[side]);
      }
    }

    for(let index=0;index<plan.documents.length;index++){
      const file=plan.documents[index], ext=file.uri.endsWith('.kt')?'kt':'java';
      const rendered=await vscode.workspace.openTextDocument(vscode.Uri.parse('rocketbrain-java-refactor:/'+plan.id+'/'+index+'/after.'+ext));
      assert.equal(rendered.getText().replace(/\r\n/gu,'\n'),file.after.replace(/\r\n/gu,'\n'));
    }
    assert.equal((await api.java.refactoring.apply(plan.id)).state,'applied');
    await verify('after');
    await vscode.commands.executeCommand('undo');
    await verify('before');
    await vscode.commands.executeCommand('redo');
    await verify('after');
    for(const file of plan.documents)assert.equal(await (await vscode.workspace.openTextDocument(vscode.Uri.parse(file.uri))).save(),true);
    await rebuild(project,tools);
    const after=await runJdbc(project,tools,config,spring.dbEngine);
    assert.deepEqual(after,baseline);
    assert.equal(await saved(sameName),shadow);
    checks.push('One reviewed Kotlin public class rename updates attributed Java and Kotlin callers, with native previews and one WorkspaceEdit.');
    checks.push('Native Undo and Redo cover both languages. Rebuilt Kotlin and Java preserve the Spring JDBC result and unrelated same-name class.');
    return { ...plan.rename, nativeWorkspaceEdit:true,nativePreview:true,nativeUndo:true,nativeRedo:true,spring:after };
  } finally {
    await api.java.kotlinEditor.stop().catch(()=>{});
    for(const document of vscode.workspace.textDocuments.filter(value=>value.uri.scheme==='file' && contains(value.uri.fsPath))){
      if(!document.isDirty)continue;
      await vscode.window.showTextDocument(document,{preview:false});
      await vscode.commands.executeCommand('workbench.action.files.revert');
    }
    for(const editor of vscode.window.visibleTextEditors.filter(value=>value.document.uri.scheme==='file' && contains(value.document.uri.fsPath))) {
      await vscode.window.showTextDocument(editor.document);
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    }
    const real=await fs.realpath(project);
    assert.equal(path.relative(workspace,path.dirname(real)),'');
    assert.match(path.basename(real),/^rb-mixed-type-rename-[^/\\]+$/u);
    await fs.rm(real,{recursive:true,force:true,maxRetries:8,retryDelay:250});
  }
}

module.exports={runKotlinMixedTypeRenameChecks};
