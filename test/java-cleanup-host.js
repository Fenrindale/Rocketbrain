'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomBytes}=require('node:crypto');
const {importedSpring,jdbcReadback}=require('./java-source-analysis-host');
const {until}=require('./helpers/stdio-lsp');
const {cleanupFixture,counts}=require('./helpers/java-cleanup-fixture');

async function runJavaCleanupChecks(api,vscode,checks) {
  const workspace=vscode.workspace.workspaceFolders[0].uri.fsPath;
  await importedSpring(api,workspace);
  assert.ok((await vscode.commands.getCommands()).includes('rocketbrain.java.cleanUpFile'));
  const name='RbCleanup'+randomBytes(5).toString('hex');
  const file=path.join(workspace,'src/main/java/fixture/boot',name+'.java'),uri=vscode.Uri.file(file);
  const source=cleanupFixture('fixture.boot',name,{spring:true});
  let document,created=false;
  try {
    await fs.writeFile(file,source,{flag:'wx'});created=true;
    document=await vscode.workspace.openTextDocument(uri);
    const editor=await vscode.window.showTextDocument(document,{preview:false});
    async function prepare() {
      for(let attempt=0;;attempt++) {
        try {return await api.javaSourceAnalysis.prepareCleanup({document});}
        catch(error) {
          if(attempt>=2||document.isDirty||!/Compiler classpath file membership changed|A compiler runtime or classpath changed|classpath changed/i.test(error.message))throw error;
          await new Promise(resolve=>setTimeout(resolve,600));
        }
      }
    }
    const stale=await prepare();
    assert.equal(await editor.edit(edit=>edit.insert(document.positionAt(source.length),'// invalidate cleanup review\n')),true);
    await assert.rejects(api.java.refactoring.apply(stale.id),/file or runtime changed|A refactoring source file changed/);
    await assert.rejects(api.javaSourceAnalysis.prepareCleanup({document}),/saved Java file/);
    await vscode.commands.executeCommand('undo');
    await until(()=>!document.isDirty&&document.getText()===source,10000);

    const plan=await prepare();
    assert.deepEqual(plan.cleanup,{counts,bindingsPreserved:true});
    assert.deepEqual(plan.resourceOperations,[]);
    assert.equal(plan.documents.length,1);
    assert.equal(plan.documents[0].edits.length,12);
    const expected=plan.documents[0].after;
    assert.doesNotMatch(expected,/import java\.time\.Instant/);
    assert.match(expected,/return score\(values\.getFirst\(\)\) \+ ":" \+ score\(0\.5d\) \+ ":" \+ \(2 \+ 3\) \* 4;/);
    for(const retained of ['import java.time.LocalDate;','import java.util.*;','import static java.lang.Math.max;',
      '@Component','// Keep this explanation.','if (value == 0);','for (; value < 0; value++);'])assert.ok(expected.includes(retained),retained);
    const preview=await vscode.workspace.openTextDocument(vscode.Uri.parse('rocketbrain-java-refactor:/'+plan.id+'/0/after.java'));
    assert.equal(preview.getText(),expected);
    assert.equal((await api.java.refactoring.apply(plan.id)).state,'applied');
    assert.equal(document.getText(),expected);
    assert.equal(await fs.readFile(file,'utf8'),source);
    await vscode.window.showTextDocument(document,{preview:false});
    await vscode.commands.executeCommand('undo');
    await until(()=>!document.isDirty&&document.getText()===source,10000);
    const jdbc=await jdbcReadback();
    assert.ok(jdbc,'Run with the owned Spring JDBC fixture.');
    checks.push('Reviewed twelve compiler-verified Java cleanup edits together in one imported Spring document.');
    checks.push('Java cleanup preserved Javadoc imports, loop bodies, overloads, comments and source bytes. A stale review was rejected and one Undo restored the editor.');
    return {springWorkspace:true,jdbc,counts,bindingsPreserved:true,edits:12,staleRejected:true,dirtyRejected:true,preview:true,diskUnchanged:true,undo:true};
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

module.exports={runJavaCleanupChecks};
