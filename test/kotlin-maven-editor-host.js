'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {until,positionOf}=require('./helpers/stdio-lsp');
const fixture=require('./helpers/kotlin-maven-editor');

async function runKotlinMavenEditorChecks(api,vscode,checks) {
  const spring=JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG,'utf8'));
  const workspace=await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
  const root=await fs.mkdtemp(path.join(workspace,'rb-kotlin-maven-editor-'));
  const service=api.java.kotlinEditor, changes=[];
  const scope=vscode.ConfigurationTarget.Global;
  const configure=async (section,key,value)=>{
    if (!value) return;
    const config=vscode.workspace.getConfiguration(section);
    changes.push([config,key,config.inspect(key)?.globalValue]);
    await config.update(key,value,scope);
  };
  const javaSettings=vscode.workspace.getConfiguration('rocketbrain.java');
  const mavenHome=process.env.ROCKETBRAIN_KOTLIN_MAVEN_HOME||javaSettings.get('mavenHome');
  let editor,original;
  const setSource=text=>editor.edit(edit=>edit.replace(new vscode.Range(editor.document.positionAt(0),
    editor.document.positionAt(editor.document.getText().length)),text));
  const position=(text,needle,offset)=>{
    const result=positionOf(text,needle,offset);
    return new vscode.Position(result.line,result.character);
  };
  try {
    await fs.cp(fixture.fixture,root,{recursive:true});
    await configure('rocketbrain.kotlinEditor','serverHome',process.env.ROCKETBRAIN_KOTLIN_EDITOR_HOME);
    await configure('rocketbrain.java','mavenHome',process.env.ROCKETBRAIN_KOTLIN_MAVEN_HOME);
    const javaHome=javaSettings.get('javaHome')||api.java.getState().javaHome;
    const spec=await fixture.build(root,{javaHome,mavenHome});
    const entry=path.join(root,fixture.source), definition=path.join(root,fixture.definition);
    const document=await vscode.workspace.openTextDocument(vscode.Uri.file(entry));
    original=document.getText();
    editor=await vscode.window.showTextDocument(document,{preview:false});
    const started=await vscode.commands.executeCommand('rocketbrain.kotlinEditor.start');
    assert.equal(started?.state,'running');
    assert.equal(started.buildTool,'maven');
    assert.equal(path.relative(root,vscode.Uri.parse(started.projectUri).fsPath),'');
    const supplied=position(original,'invoice.number',10);
    const reference=await until(async()=>{
      const values=await vscode.commands.executeCommand('vscode.executeDefinitionProvider',document.uri,supplied);
      return values?.find(value=>!path.relative((value.uri||value.targetUri)?.fsPath||'',definition));
    },60000);
    const range=reference.range||reference.targetSelectionRange;
    assert.deepEqual([range.start.line,range.start.character],[2,23]);
    const hover=await vscode.commands.executeCommand('vscode.executeHoverProvider',document.uri,supplied);
    const text=hover.flatMap(entry=>entry.contents).map(content=>typeof content==='string'?content:content.value).join('\n');
    assert.match(text,/number: String/u);
    const partial=fixture.partial(original);
    assert.ok(await setSource(partial));
    const completion=await until(async()=>{
      const response=await vscode.commands.executeCommand('vscode.executeCompletionItemProvider',document.uri,
        position(partial,fixture.completeText,fixture.completeText.length));
      return response?.items.find(fixture.isTypedCompletion);
    },60000);
    const invalid=fixture.invalid(original);
    assert.ok(await setSource(invalid));
    const problem=await until(()=>vscode.languages.getDiagnostics(document.uri)
      .find(item=>item.severity===vscode.DiagnosticSeverity.Error&&fixture.findMismatch(item)),50000);
    assert.equal(problem.range.start.line,8);
    assert.ok(document.isDirty);
    assert.doesNotMatch(await fs.readFile(entry,'utf8'),/val amount: String/u);
    assert.ok(await setSource(original));
    await until(()=>!vscode.languages.getDiagnostics(document.uri).some(item=>item.severity===vscode.DiagnosticSeverity.Error),45000);
    if (document.isDirty) await document.save();
    assert.equal((await vscode.commands.executeCommand('rocketbrain.kotlinEditor.stop')).state,'stopped');
    const jdbc=await fixture.jdbc(root,spec,spring.dbEngine,spring.dbConfigPath);
    checks.push('The installed Kotlin editor imports the selected Maven POM, completes a Spring JDBC overload, navigates to the exact Kotlin declaration, and reports and clears a real unsaved type mismatch.');
    return {buildTool:started.buildTool,server:started.serverVersion,compiler:started.compilerVersion,
      completion:completion.label.label||completion.label,definition:{file:'Invoice.kt',line:3,column:24},
      diagnostic:{code:typeof problem.code==='object'?problem.code.value:problem.code,unsaved:true,cleared:true},
      jdbc,stopped:service.getState().state==='stopped'};
  } finally {
    if (editor && editor.document.getText()!==original) await setSource(original);
    if (editor?.document.isDirty) await editor.document.save();
    await service.stop();
    if (editor) {
      await vscode.window.showTextDocument(editor.document);
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    }
    for (const [config,key,value] of changes.reverse()) await config.update(key,value,scope);
    const owned=await fs.realpath(root);
    assert.equal(path.relative(workspace,path.dirname(owned)),'');
    assert.ok(path.basename(owned).startsWith('rb-kotlin-maven-editor-'));
    await fs.rm(owned,{recursive:true,force:true,maxRetries:8,retryDelay:250});
  }
}

module.exports={runKotlinMavenEditorChecks};
