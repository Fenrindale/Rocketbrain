'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomBytes}=require('node:crypto');
const {javaInformationFixture,kotlinInformationFixture}=require('./helpers/code-information-fixture');
const {importedSpring,jdbcReadback}=require('./java-source-analysis-host');
const {until}=require('./helpers/stdio-lsp');

async function runCodeInformationChecks(api,vscode,checks) {
  const workspace=vscode.workspace.workspaceFolders[0].uri.fsPath;
  await importedSpring(api,workspace);
  const name='RbCodeInfo'+randomBytes(5).toString('hex'),file=path.join(workspace,'src/main/java/fixture/boot',name+'.java');
  const text=javaInformationFixture('fixture.boot',name,{spring:true,binary:false}),service=api.java.codeInformation;
  let document,panel,created=false;
  try {
    await fs.writeFile(file,text,{flag:'wx'});created=true;
    document=await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    const editor=await vscode.window.showTextDocument(document,{preview:false});
    await api.java.buildWorkspace();
    const docPoint=document.positionAt(text.indexOf('render("seed", 2)')+2);
    editor.selection=new vscode.Selection(docPoint,docPoint);
    const documentation=await until(async()=>await vscode.commands.executeCommand('rocketbrain.editor.quickDocumentation')||undefined,45000);
    assert.match(documentation.parts.map(part=>part.text).join('\n'),/Repeats the exact Java label/);
    panel=service.show(documentation);
    assert.equal(panel.viewType,'rocketbrainCodeInformation');
    assert.match(panel.webview.html,/Repeats the exact Java label/);
    assert.equal(panel.webview.options.enableScripts,false);
    const callPoint=document.positionAt(text.indexOf(', 2);')+2);
    await vscode.window.showTextDocument(document,{viewColumn:editor.viewColumn,preview:false});
    editor.selection=new vscode.Selection(callPoint,callPoint);
    const signatures=await vscode.commands.executeCommand('rocketbrain.editor.callSignatures');
    assert.ok(signatures.signatures.some(item=>/String suffix/.test(item.label)));
    const active=signatures.signatures.find(item=>item.active);
    assert.equal(active.activeParameter,1);
    assert.match(active.parameters[1].name,/int count/);
    assert.equal(service.show(signatures),panel);
    assert.match(panel.webview.html,/<mark>int count<\/mark>/);
    assert.equal(await editor.edit(edit=>edit.insert(document.positionAt(text.length),'// stale documentation\n')),true);
    assert.throws(()=>service.show(documentation),/source changed/);
    await vscode.window.showTextDocument(document,{preview:false});
    await vscode.commands.executeCommand('undo');
    await until(()=>!document.isDirty&&document.getText()===text,10000);
    const jdbc=await jdbcReadback();
    assert.ok(jdbc,'Run with the owned Spring JDBC fixture.');
    checks.push('The installed Code Documentation command displayed JDT Javadoc for the actual imported Spring method.');
    checks.push('The same read-only panel showed both overloads, highlighted the active second argument, and refused a stale source snapshot.');
    return {springWorkspace:true,jdbc,documentation:true,overloads:signatures.signatures.length,activeParameter:active.activeParameter,
      panelReused:true,staleSourceRefused:true,readOnly:true};
  }finally{
    try {
      panel?.dispose();
      if(document?.isDirty) {
        const editor=await vscode.window.showTextDocument(document,{preview:false});
        await editor.edit(edit=>edit.replace(new vscode.Range(document.positionAt(0),document.positionAt(document.getText().length)),text));
        await document.save();
      }
    }finally{if(created)await fs.rm(file,{force:true});}
  }
}

async function runKotlinCodeInformationChecks(api,vscode,checks) {
  const workspace=await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
  const home=process.env.ROCKETBRAIN_KOTLIN_EDITOR_HOME,gradle=process.env.ROCKETBRAIN_KOTLIN_EDITOR_GRADLE_HOME;
  assert.ok(home,'Use the independent configured Kotlin runtime.');
  const root=await fs.mkdtemp(path.join(workspace,'rb-kotlin-info-'));
  const config=vscode.workspace.getConfiguration('rocketbrain.kotlinEditor'),target=vscode.ConfigurationTarget.Global,originals=[];
  let panel;
  try {
    await fs.cp(path.join(__dirname,'fixtures/java/kotlin-editor'),root,{recursive:true});
    for(const [key,value] of [['serverHome',home],['gradleUserHome',gradle]]) {
      if(!value)continue;
      originals.push([key,config.inspect(key)?.globalValue]);
      await config.update(key,value,target);
    }
    const file=path.join(root,'src/main/kotlin/editor/fixture/KotlinInformation.kt');
    await fs.writeFile(file,kotlinInformationFixture,{flag:'wx'});
    const document=await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await vscode.window.showTextDocument(document,{preview:false});
    await api.java.kotlinEditor.start({document});
    const service=api.java.codeInformation;
    const read=(kind,offset)=>until(()=>service.inspect({document,kind,position:document.positionAt(offset)}),45000);
    const docs=await read('documentation',kotlinInformationFixture.indexOf('report("seed", 2)')+2);
    assert.match(docs.parts.map(part=>part.text).join('\n'),/distinct Kotlin KDoc test result/);
    const signatures=await read('signatures',kotlinInformationFixture.indexOf(', 2)')+2);
    assert.equal(signatures.signatures.length,2);
    const active=signatures.signatures.find(item=>item.active);
    assert.equal(active.activeParameter,1);
    assert.equal(active.parameters[1].name,'count: Int');
    assert.match(active.parameters[1].documentation,/how often/);
    panel=service.show(signatures);
    assert.match(panel.webview.html,/<mark>count: Int<\/mark>/);
    assert.match(panel.webview.html,/how often the value is repeated/);
    checks.push('The installed Kotlin Gradle provider showed both overloads and the active argument with exact KDoc from the resolved declaration.');
    return {kotlinProvider:true,kdoc:true,overloads:2,activeParameter:1,parameterDocumentation:true,readOnly:true};
  } finally {
    try {panel?.dispose();await api.java.kotlinEditor.stop();}
    finally {
      for(const [key,value] of originals.reverse())await config.update(key,value,target);
      const actual=await fs.realpath(root);
      assert.equal(path.relative(path.dirname(actual),workspace),'');assert.match(path.basename(actual),/^rb-kotlin-info-/);
      await fs.rm(actual,{recursive:true,force:true,maxRetries:8,retryDelay:250});
    }
  }
}

module.exports={runCodeInformationChecks,runKotlinCodeInformationChecks};
