'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {until,positionOf}=require('./helpers/stdio-lsp');
const app=require('./helpers/kotlin-maven-editor');
const fixture=require('./helpers/kotlin-maven-reactor');

async function runKotlinMavenReactorChecks(api,vscode,checks) {
  const spring=JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG,'utf8'));
  const workspace=await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
  const root=await fs.mkdtemp(path.join(workspace,'rb-kotlin-reactor-'));
  const project=path.join(root,'app'),entry=path.join(project,app.source),service=api.java.kotlinEditor;
  const target=vscode.ConfigurationTarget.Global,changed=[];
  async function setting(section,name,value) {
    const config=vscode.workspace.getConfiguration(section);
    if (!value) return;
    changed.push([config,name,config.inspect(name)?.globalValue]);
    await config.update(name,value,target);
  }
  let editor,original,outside;
  try {
    await fs.cp(fixture.fixture,root,{recursive:true});
    await setting('rocketbrain.kotlinEditor','serverHome',process.env.ROCKETBRAIN_KOTLIN_EDITOR_HOME);
    await setting('rocketbrain.java','mavenHome',process.env.ROCKETBRAIN_KOTLIN_MAVEN_HOME);
    const settings=vscode.workspace.getConfiguration('rocketbrain.java');
    const javaHome=settings.get('javaHome')||api.java.getState().javaHome,mavenHome=settings.get('mavenHome');
    const siblingDocument=path.join(root,'unrelated','src','main','kotlin','PreviouslyOpened.kt');
    await fs.mkdir(path.dirname(siblingDocument),{recursive:true});
    await fs.writeFile(siblingDocument,'package unrelated\nval broken: String = 42\n',{flag:'wx'});
    outside=await vscode.workspace.openTextDocument(vscode.Uri.file(siblingDocument));
    await vscode.window.showTextDocument(outside,{preview:false});
    const text=await fs.readFile(entry,'utf8');
    await fs.writeFile(entry,fixture.invalid(text));
    const document=await vscode.workspace.openTextDocument(vscode.Uri.file(entry));
    editor=await vscode.window.showTextDocument(document,{preview:false});
    original=text.replace(/\r?\n/gu,document.eol===vscode.EndOfLine.CRLF?'\r\n':'\n');
    assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.kotlinEditor.startMavenReactor'));
    await assert.rejects(service.start({document}),/Start Kotlin Maven Reactor/u);
    const reviewed=service.reviewReactor({document});
    assert.deepEqual(reviewed.steps,['.','contract']);
    await assert.rejects(service.startReactor(reviewed,{allowProjectExecution:false}),/Approve the reviewed Maven/u);
    const sibling=path.join(root,fixture.moduleSource),dependency=await fs.readFile(sibling,'utf8');
    await fs.appendFile(sibling,'\n');
    await assert.rejects(service.startReactor(reviewed,{allowProjectExecution:true}),/reactor changed/u);
    await fs.writeFile(sibling,dependency);
    const prepared=await service.startReactor(service.reviewReactor({document}),{allowProjectExecution:true});
    assert.equal(prepared.state,'running');
    assert.equal(prepared.reactor.module,'app');
    assert.equal(prepared.reactor.dependencies[0].coordinates,'rocketbrain.fixture:inventory-contract:1.0.0');
    assert.equal(path.relative(project,vscode.Uri.parse(prepared.projectUri).fsPath),'');
    assert.equal(outside.isClosed,false);
    await fs.unlink(outside.uri.fsPath);
    await assert.rejects(fs.stat(path.join(project,'target')));
    await assert.rejects(fs.stat(path.join(root,'unrelated','target')));
    const mismatch=await until(()=>vscode.languages.getDiagnostics(document.uri).find(item=>
      item.severity===vscode.DiagnosticSeverity.Error&&fixture.mismatch(item)),65000);
    assert.equal(mismatch.range.start.line,9);
    assert.ok(!vscode.languages.getDiagnostics(outside.uri).some(item=>item.source==='kotlin'));
    const replace=text=>editor.edit(edit=>edit.replace(new vscode.Range(editor.document.positionAt(0),
      editor.document.positionAt(editor.document.getText().length)),text));
    const partial=fixture.partial(original);
    assert.ok(await replace(partial));
    const {line,character}=positionOf(partial,fixture.receiver,fixture.receiver.length);
    const completion=await until(async()=>{
      const result=await vscode.commands.executeCommand('vscode.executeCompletionItemProvider',document.uri,new vscode.Position(line,character));
      return result?.items.find(fixture.completion);
    },55000);
    assert.ok(await replace(original));
    await until(()=>!vscode.languages.getDiagnostics(document.uri).some(item=>item.severity===vscode.DiagnosticSeverity.Error),45000);
    assert.match(await fs.readFile(entry,'utf8'),/val number: Int/u);
    assert.ok(await document.save());
    const built=await app.build(project,{javaHome,mavenHome,repository:prepared.reactor.repository});
    const jdbc=await app.jdbc(project,built,spring.dbEngine,spring.dbConfigPath);
    await fs.appendFile(sibling,'\n');
    await until(()=>service.getState().state==='stopped',18000);
    await assert.rejects(fs.stat(prepared.reactor.repository));
    checks.push('The installed Kotlin editor prepared the reviewed Maven dependency only, resolved its typed member in an unbuildable application, and invalidated the editor session after the sibling source changed.');
    return {module:prepared.reactor.module,dependency:prepared.reactor.dependencies[0].coordinates,
      completion:completion.label.label||completion.label,diagnostic:{code:'TYPE_MISMATCH',line:10,unsavedFixCleared:true},
      jdbc,staleReviewRefused:true,unrelatedPreviouslyOpenIgnored:true,upstreamSavedChangeStopped:true,repositoryCleaned:true};
  } finally {
    await service.stop();
    if (editor) {
      await vscode.window.showTextDocument(editor.document);
      if (editor.document.isDirty) {
        const document=editor.document;
        await editor.edit(edit=>edit.replace(new vscode.Range(document.positionAt(0),document.positionAt(document.getText().length)),original));
        await document.save();
      }
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    }
    if (outside) {
      const tabs=vscode.window.tabGroups.all.flatMap(group=>group.tabs).filter(tab=>tab.input.uri?.toString()===outside.uri.toString());
      if (tabs.length) await vscode.window.tabGroups.close(tabs);
    }
    for (const [config,name,value] of changed.reverse()) await config.update(name,value,target);
    const owned=await fs.realpath(root);
    assert.equal(path.relative(workspace,path.dirname(owned)),'');
    assert.ok(path.basename(owned).startsWith('rb-kotlin-reactor-'));
    await fs.rm(owned,{recursive:true,force:true,maxRetries:8,retryDelay:250});
  }
}

module.exports={runKotlinMavenReactorChecks};
