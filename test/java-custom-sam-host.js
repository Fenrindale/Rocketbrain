'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomBytes}=require('node:crypto');
const {conversionSource}=require('./helpers/java-conversion-fixture');
const {importedSpring,jdbcReadback}=require('./java-source-analysis-host');
const {until}=require('./helpers/stdio-lsp');

async function runJavaCustomSamChecks(api,vscode,checks) {
  const workspace=vscode.workspace.workspaceFolders[0].uri.fsPath;
  await importedSpring(api,workspace);
  const name='RbCustomSam'+randomBytes(5).toString('hex'),owner='fixture.boot.'+name;
  const file=path.join(workspace,'src/main/java/fixture/boot',name+'.java');
  const source=conversionSource('fixture.boot',name,{custom:true});
  let document,created=false;
  async function build() {
    const result=await api.java.buildWorkspace();
    assert.ok(result===0||result===1||result?.status==='succeed','JDT build '+JSON.stringify(result));
  }
  async function inspect(marker) {
    const position=document.getText().indexOf(marker);
    assert.ok(position>=0,marker);
    for (let attempt=0;;attempt++) {
      try {return await api.javaSourceAnalysis.prepareConversion({document,position:document.positionAt(position)});}
      catch(error) {
        if(attempt>=2||document.isDirty||!/Compiler classpath file membership changed|A compiler runtime or classpath changed|Java classpath changed/.test(error.message))throw error;
        await build();
        await new Promise(resolve=>setTimeout(resolve,400));
      }
    }
  }
  try {
    await fs.writeFile(file,source,{flag:'wx'});
    created=true;
    document=await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await vscode.window.showTextDocument(document,{preview:false});
    await build();
    assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.java.convertStructure'));
    await assert.rejects(inspect('unsafe = x ->'),/Select a nonescaping/);
    await assert.rejects(inspect('risky = x ->'),/Select a nonescaping/);

    const conversions=[];
    for (const [type,from,to,marker,rewrite] of [
      ['String','lambda','anonymous','input -> '+name+'.render',/new Formatter<String>\(\) \{/],
      ['Object','anonymous','lambda','new Formatter<Object>() {',/input -> .*\.render\(input, prefix\) \+ suffix/]
    ]) {
      const plan=await inspect(marker);
      const {conversion,documents}=plan;
      assert.equal(conversion.from,from);
      assert.equal(conversion.to,to);
      assert.equal(conversion.functionalType,owner+'.Formatter<java.lang.'+type+'>');
      assert.equal(conversion.sam,owner+'.Contract#apply(T)');
      assert.deepEqual(conversion.captures,['prefix','suffix']);
      assert.deepEqual(conversion.callTargets,[owner+'#render(java.lang.'+type+',java.lang.String)']);
      assert.equal(documents.length,1);
      assert.equal(documents[0].edits.length,1);
      assert.match(documents[0].after,rewrite);
      const diff=await vscode.workspace.openTextDocument(vscode.Uri.parse('rocketbrain-java-refactor:/'+plan.id+'/0/after.java'));
      assert.equal(diff.getText().replace(/\r\n/g,'\n'),documents[0].after.replace(/\r\n/g,'\n'));
      assert.equal((await api.java.refactoring.apply(plan.id)).state,'applied');
      assert.equal(await fs.readFile(file,'utf8'),source);
      assert.equal(document.isDirty,true);
      await vscode.window.showTextDocument(document,{preview:false});
      await vscode.commands.executeCommand('undo');
      await until(()=>!document.isDirty&&document.getText()===source,10000);
      conversions.push({from,to,captures:conversion.captures,overload:type,checkedBindings:conversion.checkedBindings});
    }
    const jdbc=await jdbcReadback();
    assert.ok(jdbc,'Run with the owned Spring JDBC fixture.');
    checks.push('The installed Java conversion resolved a generic project-defined inherited SAM in both directions. It preserved two exact captured declarations and distinct String and Object overloads.');
    checks.push('The project refused stateful interfaces and identity-sensitive uses. Both one-edit previews applied without writing to disk and were undone.');
    return {springWorkspace:true,jdbc,conversions,customInheritedSam:true,statefulInterfaceRefused:true,identityRefused:true,
      diskUntouched:true,nativeUndo:true};
  } finally {
    try {
      if(document?.isDirty) {
        await vscode.window.showTextDocument(document,{preview:false});
        if(vscode.window.activeTextEditor?.document===document)await vscode.commands.executeCommand('workbench.action.files.revert');
      }
    } finally {if(created)await fs.rm(file,{force:true});}
  }
}

module.exports={runJavaCustomSamChecks};
