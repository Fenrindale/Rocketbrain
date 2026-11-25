'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { importedSpring,jdbcReadback } = require('./java-source-analysis-host');
const { until } = require('./helpers/stdio-lsp');
const { qualifierFixture } = require('./helpers/spring-qualifier-fixture');

async function runSpringQualifierCompletionChecks(api,vscode,checks) {
  const root=vscode.workspace.workspaceFolders[0].uri.fsPath;
  await importedSpring(api,root);
  const name='RbQualifier'+randomBytes(5).toString('hex');
  const fixture=qualifierFixture('fixture.boot',name);
  const file=path.join(root,'src/main/java/fixture/boot',name+'.java');
  const uri=vscode.Uri.file(file), engine=process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE;
  assert.ok(['mysql','mariadb'].includes(engine));
  const configuration=vscode.workspace.getConfiguration('rocketbrain.spring',uri);
  const previous=configuration.inspect('activeProfiles')?.workspaceValue;
  const profiles=engine==='mysql'?fixture.names.mysql:fixture.names.maria;
  const draft=fixture.source.replace(fixture.names.draft+'"',name);
  let editor,document,created=false,configured=false;
  try {
    await fs.writeFile(file,fixture.source,{flag:'wx'});created=true;
    await configuration.update('activeProfiles',[engine],vscode.ConfigurationTarget.Workspace);configured=true;
    document=await vscode.workspace.openTextDocument(uri);
    editor=await vscode.window.showTextDocument(document,{preview:false});
    const replaceAll=text=>editor.edit(edit=>edit.replace(
      new vscode.Range(document.positionAt(0),document.positionAt(document.getText().length)),text),
      {undoStopBefore:true,undoStopAfter:true});
    assert.equal(await replaceAll(draft),true);
    assert.equal(document.isDirty,true);
    const liveDraft=document.getText(), prefix='@Qualifier(value = "'+name;
    const offset=liveDraft.indexOf(prefix)+prefix.length;
    const position=document.positionAt(offset);
    await api.java.spring.refresh();
    const completion=await until(async()=>{
      const list=await vscode.commands.executeCommand('vscode.executeCompletionItemProvider',uri,position);
      const items=list?.items?.filter(item=>item.detail?.startsWith('Rocketbrain Spring ·'))||[];
      return items.length?items:false;
    },55000);
    const labels=completion.map(item=>typeof item.label==='string'?item.label:item.label.label);
    assert.ok(labels.includes(profiles),JSON.stringify(labels));
    assert.ok(labels.includes(fixture.names.component));
    if(engine==='mysql') assert.ok(labels.includes(fixture.names.alias));
    for(const label of [fixture.names.hidden,fixture.names.wrong,fixture.names.repeated,fixture.names.observed,
      engine==='mysql'?fixture.names.maria:fixture.names.mysql]) assert.ok(!labels.includes(label),label);
    const item=completion.find(item=>item.label===profiles||item.label?.label===profiles);
    const documentation=typeof item.documentation==='string'?item.documentation:item.documentation?.value;
    assert.match(documentation,new RegExp('Declared candidate for profiles '+engine,'u'));
    const range=item.range.replacing||item.range;
    assert.equal(document.getText(range),name);
    assert.equal(item.insertText,profiles+'"');
    assert.equal(await editor.edit(edit=>edit.replace(range,item.insertText),{undoStopBefore:true,undoStopAfter:true}),true);
    assert.equal(document.getText().replace(/\r\n/g,'\n'),fixture.source.replace(fixture.names.draft,profiles));
    await vscode.commands.executeCommand('undo');
    await until(()=>document.getText()===liveDraft,5000);
    assert.equal(await replaceAll(fixture.source),true);
    const ordinary=await vscode.commands.executeCommand('vscode.executeCompletionItemProvider',uri,document.positionAt(document.getText().indexOf('public class')));
    assert.equal(ordinary?.items?.some(item=>item.detail?.startsWith('Rocketbrain Spring ·'))||false,false);
    const jdbc=await jdbcReadback();assert.ok(jdbc);
    checks.push('VS Code’s Java completion provider offered type-compatible Spring qualifiers and aliases for the current profile, repaired one missing quote, and restored the exact draft with Undo.');
    return {profile:engine,selected:profiles,constructorProvider:true,nativeUndo:true,missingQuoteRepaired:true,
      wrongTypeExcluded:true,inactiveExcluded:true,ambiguousExcluded:true,jdbc};
  } finally {
    if(document?.isDirty) {
      const edit=new vscode.WorkspaceEdit();
      edit.replace(uri,new vscode.Range(document.positionAt(0),document.positionAt(document.getText().length)),fixture.source);
      await vscode.workspace.applyEdit(edit);
      await document.save();
    }
    if(created)await fs.unlink(file);
    if(configured)await configuration.update('activeProfiles',previous,vscode.ConfigurationTarget.Workspace);
  }
}

module.exports={runSpringQualifierCompletionChecks};
