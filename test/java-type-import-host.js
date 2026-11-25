'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomBytes}=require('node:crypto');
const {typeImportFixture}=require('./helpers/type-import-fixture');
const {importedSpring,jdbcReadback}=require('./java-source-analysis-host');
const {until}=require('./helpers/stdio-lsp');

async function runJavaTypeImportChecks(api,vscode,checks) {
  const workspace=vscode.workspace.workspaceFolders[0].uri.fsPath;
  await importedSpring(api,workspace);
  const name='RbImport'+randomBytes(5).toString('hex');
  const file=path.join(workspace,'src/main/java/fixture/boot',name+'.java'),uri=vscode.Uri.file(file);
  const source=typeImportFixture('fixture.boot',name,{spring:true}),service=api.javaSourceAnalysis;
  let document,created=false;
  try {
    await fs.writeFile(file,source,{flag:'wx'});created=true;
    document=await vscode.workspace.openTextDocument(uri);
    const editor=await vscode.window.showTextDocument(document,{preview:false});
    const at=source.indexOf('Date');
    const range=new vscode.Range(document.positionAt(at),document.positionAt(at+4));
    await until(()=>vscode.languages.getDiagnostics(uri).some(diagnostic=>diagnostic.source==='Java'&&
      String(diagnostic.code?.value??diagnostic.code)==='16777218'),65000);
    const actions=await vscode.commands.executeCommand('vscode.executeCodeActionProvider',uri,range,'quickfix',14);
    assert.ok(actions.some(action=>action.command?.command==='rocketbrain.java.addTypeImport'));
    const inspect=()=>service.inspectTypeImport({document,range});
    const seen=await inspect();
    assert.ok(seen.candidates.includes('java.sql.Date')&&seen.candidates.includes('java.util.Date'));
    await assert.rejects(service.prepareTypeImport(seen,{fqn:'java.time.LocalDate'}),/known Java import candidate/);
    assert.equal(await editor.edit(edit=>edit.insert(document.positionAt(source.length),'// invalidate import review\n')),true);
    await assert.rejects(service.prepareTypeImport(seen,{fqn:'java.sql.Date'}),/source or runtime changed/);
    await vscode.commands.executeCommand('undo');
    await until(()=>!document.isDirty&&document.getText()===source,10000);
    let plan;
    for(let attempt=0;;attempt++) {
      try {plan=await service.prepareTypeImport(await inspect(),{fqn:'java.sql.Date'});break;}
      catch(error){
        if(attempt>=2||document.isDirty||!/Compiler classpath file membership changed|A compiler runtime or classpath changed|classpath changed/.test(error.message))throw error;
        await new Promise(resolve=>setTimeout(resolve,600));
      }
    }
    assert.equal(plan.import.type,'java.sql.Date');
    assert.equal(plan.import.occurrences,2);
    assert.equal(plan.documents.length,1);
    assert.equal(plan.documents[0].edits.length,1);
    const expected=plan.documents[0].after;
    assert.equal(expected.replace(plan.documents[0].edits[0].newText,''),source);
    const diff=await vscode.workspace.openTextDocument(vscode.Uri.parse('rocketbrain-java-refactor:/'+plan.id+'/0/after.java'));
    assert.equal(diff.getText().replace(/\r\n/g,'\n'),expected.replace(/\r\n/g,'\n'));
    assert.equal((await api.java.refactoring.apply(plan.id)).state,'applied');
    assert.equal(document.getText(),expected);
    assert.equal(await fs.readFile(file,'utf8'),source);
    await until(()=>!vscode.languages.getDiagnostics(uri).some(diagnostic=>diagnostic.source==='Java'&&
      String(diagnostic.code?.value??diagnostic.code)==='16777218'),55000);
    await vscode.window.showTextDocument(document,{preview:false});
    await vscode.commands.executeCommand('undo');
    await until(()=>!document.isDirty&&document.getText()===source,10000);
    const jdbc=await jdbcReadback();
    assert.ok(jdbc,'Run with the owned Spring JDBC fixture.');
    checks.push('The installed Java import action offered the actual JDT Date candidates and resolved two uses to the selected java.sql.Date.');
    checks.push('The confirmed import cleared the Java diagnostic, preserved the wildcard, static import and original disk bytes, and reverted in one Undo.');
    return {springWorkspace:true,jdbc,candidates:seen.candidates.length,selected:plan.import.type,occurrences:plan.import.occurrences,
      nativeCodeAction:true,forgedCandidateRefused:true,staleSourceRefused:true,diagnosticCleared:true,staticAndWildcardRetained:true,
      diskUnchanged:true,nativeUndo:true};
  } finally {
    try {
      if(document?.isDirty) {
        const editor=await vscode.window.showTextDocument(document,{preview:false});
        await editor.edit(edit=>edit.replace(new vscode.Range(document.positionAt(0),document.positionAt(document.getText().length)),source));
        await document.save();
      }
    } finally {if(created)await fs.rm(file,{force:true});}
  }
}

module.exports={runJavaTypeImportChecks};
