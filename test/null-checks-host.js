'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomBytes}=require('node:crypto');
const {importedSpring,jdbcReadback}=require('./java-source-analysis-host');
const {until}=require('./helpers/stdio-lsp');
const {javaNullFixture,kotlinNullFixture,kotlinNullFixed,javaNullable,javaContract,javaResource,kotlinNullable}=require('./helpers/null-checks-fixture');

async function problems(vscode,document,predicate,source) {
  try {
    return await until(()=>{
      const diagnostics=vscode.languages.getDiagnostics(document.uri).filter(item=>item.source?.toLowerCase()===source);
      return predicate(diagnostics)?diagnostics:undefined;
    },60000);
  }catch(error) {
    throw Error(`VS Code ${source} diagnostics: ${JSON.stringify(vscode.languages.getDiagnostics(document.uri).map(item=>item.message))}`,{cause:error});
  }
}

async function editAndUndo(vscode,editor,sample,initial,fixed,source) {
  const {document}=editor;
  const range=()=>new vscode.Range(document.positionAt(0),document.positionAt(document.getText().length));
  try {
    assert.ok(await editor.edit(builder=>builder.replace(range(),sample.fixed),{undoStopBefore:true,undoStopAfter:true}));
    assert.ok(document.isDirty);
    await problems(vscode,document,fixed,source);
    assert.equal(await fs.readFile(sample.file,'utf8'),sample.source);
    await vscode.commands.executeCommand('undo');
    await until(()=>!document.isDirty&&document.getText()===sample.source,12000);
    await problems(vscode,document,initial,source);
  }finally {
    if(document.isDirty) {
      assert.ok(await editor.edit(builder=>builder.replace(range(),sample.source)));
      assert.ok(await document.save());
    }
  }
}

async function runJavaNullChecks(api,vscode,checks) {
  const workspace=vscode.workspace.workspaceFolders[0].uri.fsPath;
  await importedSpring(api,workspace);
  const segment='nullchecks'+randomBytes(5).toString('hex');
  const sample=await javaNullFixture(workspace,'fixture.boot.'+segment,'JavaNullProbe');
  const settings=vscode.workspace.getConfiguration('rocketbrain.java'),key='nullChecks',target=vscode.ConfigurationTarget.Workspace;
  const previous=settings.inspect(key)?.workspaceValue;
  const withoutNull=diagnostics=>diagnostics.some(javaResource)&&!diagnostics.some(javaNullable)&&!diagnostics.some(javaContract);
  const allWarnings=diagnostics=>diagnostics.some(javaNullable)&&diagnostics.some(javaContract)&&diagnostics.some(javaResource);
  const clean=diagnostics=>!diagnostics.some(item=>javaNullable(item)||javaContract(item)||javaResource(item));
  try {
    const commands=await vscode.commands.getCommands(true);
    assert.ok(commands.includes('rocketbrain.java.configureNullChecks'));
    await settings.update(key,{profile:'disabled'},target);
    await until(()=>api.java.getState().nullChecks==='disabled',20000);
    const document=await vscode.workspace.openTextDocument(vscode.Uri.file(sample.file));
    const editor=await vscode.window.showTextDocument(document,{preview:false});
    await api.java.buildWorkspace();
    await problems(vscode,document,withoutNull,'java');
    await settings.update(key,sample.profile,target);
    await until(()=>api.java.getState().nullChecks==='custom',20000);
    const active=await problems(vscode,document,allWarnings,'java');
    const witnesses=[javaNullable,javaContract,javaResource].map(predicate=>active.find(predicate));
    assert.deepEqual(witnesses.map(item=>document.getText(item.range)),['value','null','stream']);
    await editAndUndo(vscode,editor,sample,allWarnings,clean,'java');
    const jdbc=await jdbcReadback();
    assert.ok(jdbc,'Use the owned Spring JDBC fixture.');
    checks.push('The installed Java Problems view used the selected workspace annotation profile to diagnose a nullable receiver and invalid return, plus an unclosed resource. An unsaved fix and Undo refreshed the real JDT diagnostics.');
    return {springWorkspace:true,jdbc,source:'eclipse-jdt',profile:'custom',diagnosticCodes:witnesses.map(item=>String(item.code)),
      resourceLeak:true,exactSourceRanges:true,unsavedFixCleared:true,undoRestored:true};
  }finally{
    await settings.update(key,previous,target);
    for(const file of sample.files)await fs.rm(file,{force:true});
  }
}

async function runKotlinNullChecks(api,vscode,checks) {
  const workspace=await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
  const home=process.env.ROCKETBRAIN_KOTLIN_EDITOR_HOME,gradle=process.env.ROCKETBRAIN_KOTLIN_EDITOR_GRADLE_HOME;
  assert.ok(home,'Use the independent Kotlin editor provider.');
  const root=await fs.mkdtemp(path.join(workspace,'rb-kotlin-null-checks-'));
  const configuration=vscode.workspace.getConfiguration('rocketbrain.kotlinEditor'),target=vscode.ConfigurationTarget.Global,restore=[];
  try {
    await fs.cp(path.join(__dirname,'fixtures/java/kotlin-editor'),root,{recursive:true});
    for(const [key,value] of [['serverHome',home],['gradleUserHome',gradle]]) {
      if(!value)continue;
      restore.push([key,configuration.inspect(key)?.globalValue]);
      await configuration.update(key,value,target);
    }
    const sample={file:path.join(root,'src/main/kotlin/editor/fixture/KotlinNull.kt'),source:kotlinNullFixture,fixed:kotlinNullFixed};
    await fs.writeFile(sample.file,sample.source,{flag:'wx'});
    const document=await vscode.workspace.openTextDocument(vscode.Uri.file(sample.file));
    const editor=await vscode.window.showTextDocument(document,{preview:false});
    await api.java.kotlinEditor.start({document});
    const initial=diagnostics=>diagnostics.some(kotlinNullable);
    const diagnosed=await problems(vscode,document,initial,'kotlin');
    const diagnostic=diagnosed.find(kotlinNullable);
    assert.equal(document.getText(diagnostic.range),'.');
    assert.equal(diagnostic.code,'UNSAFE_CALL');
    await editAndUndo(vscode,editor,sample,initial,diagnostics=>!initial(diagnostics),'kotlin');
    checks.push('The installed Kotlin Gradle editor diagnosed the exact unsafe nullable receiver call and updated the issue through the unsaved safe-call edit and Undo.');
    return {kotlinProvider:true,diagnosticCode:diagnostic.code,exactSourceRange:true,unsavedFixCleared:true,undoRestored:true};
  }finally {
    try {await api.java.kotlinEditor.stop();}
    finally {
      for(const [key,value] of restore.reverse())await configuration.update(key,value,target);
      const physical=await fs.realpath(root);
      assert.equal(path.relative(path.dirname(physical),workspace),'');
      assert.match(path.basename(physical),/^rb-kotlin-null-checks-/);
      await fs.rm(physical,{recursive:true,force:true,maxRetries:8,retryDelay:250});
    }
  }
}

module.exports={runJavaNullChecks,runKotlinNullChecks};
