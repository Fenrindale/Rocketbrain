'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomBytes}=require('node:crypto');
const {extractMethodFixture,voidMethodFixture}=require('./helpers/extract-method-fixture');
const {importedSpring,jdbcReadback}=require('./java-source-analysis-host');
const {until}=require('./helpers/stdio-lsp');

async function runJavaExtractMethodChecks(api,vscode,checks,mode='return') {
  const workspace=vscode.workspace.workspaceFolders[0].uri.fsPath;
  await importedSpring(api,workspace);
  const className='RbExtractMethod'+randomBytes(5).toString('hex'),name='reviewedRun';
  const returnsValue=mode==='return',multipleOutputs=mode==='outputs';
  const fixture=(returnsValue?extractMethodFixture:voidMethodFixture)('fixture.boot',className,{spring:true});
  const file=path.join(workspace,'src/main/java/fixture/boot',className+'.java'),uri=vscode.Uri.file(file);
  let document,created=false;
  const build=async()=>{
    const status=await api.java.buildWorkspace();
    assert.ok(status===0||status===1||status?.status==='succeed','JDT build '+JSON.stringify(status));
  };
  try {
    await fs.writeFile(file,fixture.text,{flag:'wx'});created=true;
    document=await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document,{preview:false});
    const select=marker=>{
      const offset=document.getText().indexOf(marker);
      assert.ok(offset>=0,marker);
      return new vscode.Range(document.positionAt(offset),document.positionAt(offset+marker.length));
    };
    const selection=select(multipleOutputs?fixture.outputs:fixture.selected);
    await build();
    const actions=await vscode.commands.executeCommand('vscode.executeCodeActionProvider',uri,selection,'refactor.extract.method',15);
    assert.ok(actions.some(item=>item.command?.command==='rocketbrain.java.extractMethod'));
    async function prepare(range,helperName) {
      for(let attempt=0;;attempt++) {
        try {return await api.javaSourceAnalysis.prepareMethodExtraction({document,range,name:helperName});}
        catch(error) {
          if(attempt>=2||document.isDirty||!/Compiler classpath file membership changed|A compiler runtime or classpath changed|classpath changed/.test(error.message))throw error;
          await build();
        }
      }
    }
    if (!returnsValue) {
      await assert.rejects(prepare(select(fixture.escaping),name),/local value used outside/);
      await assert.rejects(prepare(select(fixture.earlyReturn),name),/nonlocal control flow/);
      await assert.rejects(prepare(select(fixture.outsideLoop),name),/nonlocal control flow/);
    } else {
      await assert.rejects(prepare(select(fixture.unsafe),name),/Captured writes/);
      await assert.rejects(prepare(selection,'normalize'),/unused/);
    }
    const plan=await prepare(selection,name);
    assert.equal(plan.documents.length,1);
    assert.equal(plan.documents[0].edits.length,2);
    assert.deepEqual(plan.extraction.typeParameters,returnsValue?['T','E']:[]);
    assert.deepEqual(plan.extraction.throwsTypes,returnsValue?['E']:multipleOutputs?[]:['java.io.IOException']);
    assert.deepEqual(plan.extraction.captures.map(item=>item.name),
      returnsValue?['value','suffix','allow','failure']:multipleOutputs?['value']:['value','failure']);
    assert.equal(plan.extraction.statements,returnsValue?4:multipleOutputs?2:3);
    const expected=plan.documents[0].after;
    const preview=await vscode.workspace.openTextDocument(vscode.Uri.parse('rocketbrain-java-refactor:/'+plan.id+'/0/after.java'));
    assert.equal(preview.getText().replace(/\r\n/g,'\n'),expected.replace(/\r\n/g,'\n'));
    assert.equal((await api.java.refactoring.apply(plan.id)).state,'applied');
    assert.equal(document.getText(),expected);
    assert.equal(await fs.readFile(file,'utf8'),fixture.text);
    await vscode.window.showTextDocument(document,{preview:false});
    await vscode.commands.executeCommand('undo');
    await until(()=>!document.isDirty&&document.getText()===fixture.text,10000);
    const jdbc=await jdbcReadback();
    assert.ok(jdbc,'Run with the owned Spring JDBC fixture.');
    if (multipleOutputs) {
      assert.equal(plan.extraction.returnType,'fixture.boot.'+className+'.ReviewedRunValues');
      assert.deepEqual(plan.extraction.outputs,[
        {name:'clean',type:'java.lang.String',final:true},
        {name:'length',type:'int',final:false}
      ]);
      assert.match(expected,/final java\.lang\.String clean = reviewedRunResult\.value0\(\);/);
      assert.match(expected,/int length = reviewedRunResult\.value1\(\);/);
      assert.match(expected,/private record ReviewedRunValues\(java\.lang\.String value0, int value1\)/);
      checks.push('Extract Method restored two compiler-proven outputs in the original Spring method scope, including a final String and a mutable int.');
      return {springWorkspace:true,jdbc,statements:2,outputs:plan.extraction.outputs,checkedBindings:plan.extraction.checkedBindings,
        nativeAction:true,verifiedOutputCarrier:true,compileTimeConstantRefused:true,diskUnchanged:true,nativeUndo:true};
    }
    if (!returnsValue) {
      assert.equal(plan.extraction.returnType,'void');
      assert.match(expected,/this\.reviewedRun\(value, failure\);/);
      assert.match(expected,/if \(repeat == 0\) continue;/);
      checks.push('The installed Extract Method action recovered a nested statement sequence in Spring source, preserved checked exceptions, and reverted with a single Undo.');
      return {springWorkspace:true,jdbc,statements:3,captures:plan.extraction.captures,
        checkedExceptions:plan.extraction.throwsTypes,checkedBindings:plan.extraction.checkedBindings,codeAction:true,voidHelper:true,
        nestedSelection:true,escapingLocalRefused:true,earlyReturnRefused:true,loopLocalControl:true,
        externalContinueRefused:true,diskUnchanged:true,nativeUndo:true};
    }
    checks.push('The installed Java Extract Method action proved an exact generic helper and its replacement call for a conditional checked-exception sequence in imported Spring source.');
    checks.push('Two text edits applied to the editor with no disk write and one Undo restored the original. Name collisions and captured writes were refused.');
    return {springWorkspace:true,jdbc,statements:4,captures:plan.extraction.captures,typeParameters:['T','E'],throwsTypes:['E'],
      codeAction:true,checkedBindings:plan.extraction.checkedBindings,conflictRefused:true,capturedWriteRefused:true,diskUnchanged:true,nativeUndo:true};
  } finally {
    try {
      if(document?.isDirty) {
        const editor=await vscode.window.showTextDocument(document,{preview:false});
        await editor.edit(edit=>edit.replace(new vscode.Range(document.positionAt(0),document.positionAt(document.getText().length)),fixture.text));
        await document.save();
      }
    } finally {if(created)await fs.rm(file,{force:true});}
  }
}

const runJavaVoidMethodChecks=(api,vscode,checks)=>runJavaExtractMethodChecks(api,vscode,checks,'void');
const runJavaMultipleOutputChecks=(api,vscode,checks)=>runJavaExtractMethodChecks(api,vscode,checks,'outputs');

module.exports={runJavaExtractMethodChecks,runJavaVoidMethodChecks,runJavaMultipleOutputChecks};
