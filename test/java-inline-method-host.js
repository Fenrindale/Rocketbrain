'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomBytes}=require('node:crypto');
const {importedSpring,jdbcReadback}=require('./java-source-analysis-host');
const {until}=require('./helpers/stdio-lsp');
const {inlineFixture}=require('./helpers/inline-method-fixture');

async function runJavaInlineMethodChecks(api,vscode,checks) {
  const service=api.javaSourceAnalysis;
  assert.ok(service?.prepareInlineMethod);
  assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.java.inlineMethod'));
  const workspace=vscode.workspace.workspaceFolders[0].uri.fsPath;
  await importedSpring(api,workspace);
  const name='RbInline'+randomBytes(5).toString('hex'),fixture=inlineFixture('fixture.boot',name,{spring:true});
  const file=path.join(workspace,'src/main/java/fixture/boot',name+'.java'),uri=vscode.Uri.file(file);
  let document,created=false;
  try {
    await fs.writeFile(file,fixture.source,{flag:'wx'});
    created=true;
    document=await vscode.workspace.openTextDocument(uri);
    const editor=await vscode.window.showTextDocument(document,{preview:false}),original=document.getText();
    const range=(marker,after=0)=>{
      const start=original.indexOf(marker,after);
      assert.ok(start>=0,marker);
      return new vscode.Range(document.positionAt(start),document.positionAt(start+marker.length));
    };
    await api.java.buildWorkspace();
    const selected=range(fixture.call);
    const action=await until(async()=>{
      const actions=await vscode.commands.executeCommand('vscode.executeCodeActionProvider',uri,selected,'refactor.inline',25);
      return actions?.find(item=>item.command?.command==='rocketbrain.java.inlineMethod');
    },35000);
    assert.equal(action.edit,undefined);
    assert.equal(action.command.arguments[0].version,document.version);
    const preview=()=>service.prepareInlineMethod({document,range:selected});
    const plan=await preview();
    assert.deepEqual(plan.inline,{method:'score',owner:'fixture.boot.'+name,returnType:'int',arguments:3,parameterReferences:3,selectedCalls:1});
    assert.equal(plan.documents.length,1);
    assert.equal(plan.documents[0].edits.length,1);
    assert.equal(plan.resourceOperations.length,0);
    const after=plan.documents[0].after;
    assert.deepEqual(after.match(/rbInlineArgument[2-4] = take\([1-3]\)/g),[
      'rbInlineArgument2 = take(1)','rbInlineArgument3 = take(2)','rbInlineArgument4 = take(3)']);
    assert.match(after,/private static int score\(int first, int second, int ignored\)/);
    assert.match(after,/return score\("other"\);/);
    assert.equal(after.split(fixture.call).length,3);
    const diff=await vscode.workspace.openTextDocument(vscode.Uri.parse('rocketbrain-java-refactor:/'+plan.id+'/0/after.java'));
    assert.equal(diff.getText().replace(/\r\n/g,'\n'),after.replace(/\r\n/g,'\n'));
    assert.equal((await api.java.refactoring.apply(plan.id)).state,'applied');
    assert.equal(document.getText(),after);
    assert.equal(await fs.readFile(file,'utf8'),fixture.source);
    const undo=async()=>{
      await vscode.window.showTextDocument(document,{preview:false});
      await vscode.commands.executeCommand('undo');
      await until(()=>document.getText()===original,10000);
      assert.equal(document.isDirty,false);
    };
    await undo();

    await assert.rejects(service.prepareInlineMethod({document,range:range(fixture.call,original.indexOf('int nested()'))}),/whole return expression/);
    const stale=await preview();
    assert.equal(await editor.edit(change=>change.insert(document.positionAt(document.getText().length),'\n// owned stale review\n')),true);
    await assert.rejects(api.java.refactoring.apply(stale.id),/changed/);
    await undo();
    const jdbc=await jdbcReadback();
    assert.ok(jdbc,'Run with the owned Spring JDBC fixture.');
    checks.push('The Java inline code action opened a compiler-verified preview for a selected method overload in imported Spring source.');
    checks.push('One unsaved edit preserved all argument evaluations in order, kept the other calls and declaration, and refused a stale review.');
    return {springWorkspace:true,jdbc,nativeCodeAction:true,exactOverload:true,selectedCalls:1,argumentOrder:[1,2,3],parameterReferences:3,
      unusedArgumentEvaluated:true,originalDeclaration:true,nestedCallRefused:true,staleReviewRefused:true,nativeUndo:true,diskPreserved:true};
  } finally {
    try {if (document?.isDirty) {
      await vscode.window.showTextDocument(document,{preview:false});
      if (vscode.window.activeTextEditor?.document===document) await vscode.commands.executeCommand('workbench.action.files.revert');
    }} finally {if(created)await fs.rm(file,{force:true});}
  }
}

module.exports={runJavaInlineMethodChecks};
