'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {importedSpring,jdbcReadback}=require('./java-source-analysis-host');
const {until}=require('./helpers/stdio-lsp');
const {kotlinFormatSource,assertKotlinFormat}=require('./helpers/kotlin-format-fixture');
const {editedText}=require('../src/java/refactoring');

async function runKotlinFormattingChecks(api,vscode,checks) {
  const engine=api.java.kotlinEditor,service=engine.formatting;
  assert.ok(service?.prepare);
  assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.kotlinEditor.previewFormatting'));
  const workspace=await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
  await importedSpring(api,workspace);
  const home=process.env.ROCKETBRAIN_KOTLIN_EDITOR_HOME,gradle=process.env.ROCKETBRAIN_KOTLIN_EDITOR_GRADLE_HOME;
  assert.ok(home,'Use the pinned owned Kotlin formatting runtime.');
  const root=await fs.mkdtemp(path.join(workspace,'rb-kotlin-format-'));
  const settings=vscode.workspace.getConfiguration('rocketbrain.kotlinEditor'),target=vscode.ConfigurationTarget.Global;
  const restore=[], documents=[];
  try {
    await fs.cp(path.join(__dirname,'fixtures/java/kotlin-editor'),root,{recursive:true});
    for (const [key,value] of [['serverHome',home],['gradleUserHome',gradle]]) {
      if (!value) continue;
      restore.push([key,settings.inspect(key)?.globalValue]);
      await settings.update(key,value,target);
    }
    const directory=path.join(root,'src/main/kotlin/editor/fixture'),nested=path.join(directory,'nested'),nestedConfig=path.join(nested,'.editorconfig');
    await fs.mkdir(nested);
    await fs.writeFile(path.join(root,'.editorconfig'),'root=true\n[*.{kt,java}]\nindent_style=space\nindent_size=2\nend_of_line=lf\n',{flag:'wx'});
    const savedNested='[*.kt]\nindent_style=tab\ntab_width=4\nend_of_line=crlf\n';
    await fs.writeFile(nestedConfig,savedNested,{flag:'wx'});
    const soft=kotlinFormatSource('editor.fixture','NativeSoft'),hard=kotlinFormatSource('editor.fixture.nested','NativeTabs');
    for (const [file,input] of [[path.join(directory,'NativeSoft.kt'),soft],[path.join(nested,'NativeTabs.kt'),hard]]) {
      await fs.writeFile(file,input.source,{flag:'wx'});
      documents.push(await vscode.workspace.openTextDocument(vscode.Uri.file(file)));
    }
    const [softDoc,hardDoc]=documents,original=hardDoc.getText(),options={tabSize:6,insertSpaces:true};
    const state=await engine.start({document:hardDoc});
    assert.equal(state.serverVersion,'1.4.0-rc1');
    const native=async document=>until(()=>vscode.commands.executeCommand('vscode.executeFormatDocumentProvider',document.uri,options)
      .then(result=>result?.length?result:undefined),55000);
    const softEdits=await native(softDoc);
    assertKotlinFormat(editedText(softDoc.getText(),softEdits),soft,{indentSize:2,tabWidth:2,insertSpaces:true});
    const shell=await vscode.window.showTextDocument(hardDoc,{preview:false});
    const range=new vscode.Range(hardDoc.positionAt(hard.rangeStart),hardDoc.positionAt(hard.rangeEnd));
    const rangePlan=await service.prepare({document:hardDoc,range,options});
    assert.equal(rangePlan.formatting.endOfLine,null);
    assert.equal(rangePlan.formatting.mode,'range');
    assertKotlinFormat(rangePlan.documents[0].after,hard,rangePlan.formatting.options);
    assert.ok(rangePlan.documents[0].after.startsWith(original.slice(0,hard.rangeStart)));
    assert.ok(rangePlan.documents[0].after.endsWith(original.slice(hard.rangeEnd)));
    const nativeRange=await vscode.commands.executeCommand('vscode.executeFormatRangeProvider',hardDoc.uri,range,options);
    assert.equal(editedText(original,nativeRange),rangePlan.documents[0].after);
    const undo=async stage=>{
      await vscode.window.showTextDocument(hardDoc,{preview:false,preserveFocus:false});
      await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
      assert.equal(vscode.window.activeTextEditor?.document,hardDoc);
      await vscode.commands.executeCommand('undo');
      try { await until(()=>hardDoc.getText()===original,10000); }
      catch {
        const observed=hardDoc.getText();
        throw Error(`Undo after ${stage} did not restore the original Kotlin buffer (EOL ${hardDoc.eol}, dirty ${hardDoc.isDirty}, `+
          `length ${observed.length}/${original.length}, text apart from line endings ${observed.replace(/\r\n/g,'\n')===original}).`);
      }
      assert.equal(hardDoc.eol,vscode.EndOfLine.LF);
      assert.equal(hardDoc.isDirty,false);
    };
    assert.equal((await api.java.refactoring.apply(rangePlan.id)).state,'applied');
    assert.equal(hardDoc.eol,vscode.EndOfLine.LF);
    await undo('reviewed range');
    const full=await service.prepare({document:hardDoc,options});
    assert.equal(full.formatting.configurationSources.length,2);
    assert.equal(full.formatting.endOfLine,'crlf');
    assertKotlinFormat(full.documents[0].after,hard,{insertSpaces:false,indentSize:2,tabWidth:4});
    const prior=await vscode.workspace.openTextDocument(vscode.Uri.parse('rocketbrain-java-refactor:/'+full.id+'/0/before.kt'));
    const preview=await vscode.workspace.openTextDocument(vscode.Uri.parse('rocketbrain-java-refactor:/'+full.id+'/0/after.kt'));
    assert.equal(prior.getText().replace(/\r\n/g,'\n'),original);
    assert.equal(preview.getText().replace(/\r\n/g,'\n'),full.documents[0].after.replace(/\r\n/g,'\n'));
    assert.equal((await api.java.refactoring.apply(full.id)).state,'applied');
    assert.equal(hardDoc.getText(),full.documents[0].after);
    assert.equal(hardDoc.eol,vscode.EndOfLine.CRLF);
    assert.equal(await fs.readFile(hardDoc.uri.fsPath,'utf8'),original);
    await undo('reviewed document');
    shell.selection=new vscode.Selection(0,0,0,0);
    await vscode.commands.executeCommand('editor.action.formatDocument');
    await until(()=>hardDoc.getText()===full.documents[0].after,12000);
    await undo('native document formatter');
    const stale=await service.prepare({document:hardDoc,options});
    await fs.writeFile(nestedConfig,savedNested.replace('tab_width=4','tab_width=8'));
    await assert.rejects(api.java.refactoring.apply(stale.id),/\.editorconfig files changed/);
    const jdbc=await jdbcReadback();
    assert.ok(jdbc,'Run with the owned Spring JDBC fixture.');
    checks.push('Pinned Kotlin native formatting obeyed inherited soft indentation and distinct hard tab stops, preserving raw and quoted literal content.');
    checks.push('The selected complete Kotlin lines preserved the surrounding buffer. A reviewed full CRLF edit used one Undo and reject-on-changed-config.');
    return {springWorkspace:true,jdbc,server:state.serverVersion,compiler:state.compilerVersion,nativeDocument:true,nativeRange:true,
      configurationFiles:2,softIndent:2,hardTabWidth:4,exactRange:true,rawAndQuotedLiterals:true,fullCrlf:true,nativeUndo:true,diskPreserved:true,changedConfigRefused:true};
  } finally {
    try {
      for (const document of documents.filter(item=>item.isDirty)) {
        await vscode.window.showTextDocument(document,{preview:false});
        if (vscode.window.activeTextEditor?.document===document) await vscode.commands.executeCommand('workbench.action.files.revert');
      }
      await engine.stop();
    } finally {
      for (const [key,value] of restore.reverse()) await settings.update(key,value,target);
      const real=await fs.realpath(root);
      assert.equal(path.relative(path.dirname(real),workspace),'');
      assert.match(path.basename(real),/^rb-kotlin-format-/);
      await fs.rm(real,{recursive:true,force:true,maxRetries:8,retryDelay:250});
    }
  }
}

module.exports={runKotlinFormattingChecks};
