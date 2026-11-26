'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { importedSpring,jdbcReadback } = require('./java-source-analysis-host');
const { enhancedIterationSource,arrayLoop,referenceLoop,copiedListLoop,literalListLoop,negativeLoops } =
  require('./helpers/java-enhanced-iteration-fixture');

async function runJavaEnhancedIterationChecks(api,vscode,checks) {
  assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.java.convertStructure'));
  const workspace = vscode.workspace.workspaceFolders[0].uri.fsPath;
  await importedSpring(api,workspace);
  const className = 'RbEnhancedIterations'+randomBytes(5).toString('hex');
  const file = path.join(workspace,'src/main/java/fixture/boot',className+'.java');
  const original = enhancedIterationSource('fixture.boot',className,{spring:true});
  const build = async () => {
    const result = await api.java.buildWorkspace();
    assert.ok(result === 0 || result === 1 || result?.status === 'succeed','JDT build '+JSON.stringify(result));
  };
  let document;
  const prepare = async snippet => {
    for (let attempt = 1; ; attempt++) {
      const offset = document.getText().indexOf(snippet);
      assert.ok(offset > 0,snippet);
      try {
        return await api.javaSourceAnalysis.prepareConversion({document,position:document.positionAt(offset)});
      } catch (error) {
        if (attempt >= 3 || document.isDirty ||
          !/Compiler classpath file membership changed|A compiler runtime or classpath changed|Java classpath changed/u.test(error.message)) throw error;
        await build();
        await new Promise(resolve => setTimeout(resolve,400));
      }
    }
  };

  await fs.writeFile(file,original,{flag:'wx'});
  try {
    document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await vscode.window.showTextDocument(document,{preview:false,preserveFocus:true});
    await build();
    for (const index of [0,1,3]) {
      await assert.rejects(prepare(negativeLoops[index]),/supported indexed array or immutable List/u);
    }

    const stale = await prepare(arrayLoop);
    const edited = new vscode.WorkspaceEdit();
    edited.insert(document.uri,document.positionAt(document.getText().length),'// After review\n');
    assert.ok(await vscode.workspace.applyEdit(edited));
    await assert.rejects(api.java.refactoring.apply(stale.id),/changed|Save each Java source/u);
    const revert = new vscode.WorkspaceEdit();
    revert.delete(document.uri,new vscode.Range(document.positionAt(original.length),document.positionAt(document.getText().length)));
    assert.ok(await vscode.workspace.applyEdit(revert));
    assert.ok(await document.save());
    await build();

    const conversions = [];
    for (const [loop,expected] of [
      [arrayLoop,'for (final var value : values) {'],
      [referenceLoop,'for (final CharSequence code : codes) {'],
      [copiedListLoop,'for (final String label : entries) {'],
      [literalListLoop,'for (var letter : letters) {']
    ]) {
      const plan = await prepare(loop);
      assert.equal(plan.documents.length,1);
      assert.equal(plan.conversion.from,'indexed-elements');
      assert.equal(plan.conversion.to,'enhanced-elements');
      assert.ok(plan.documents[0].after.includes(expected));
      assert.ok(plan.documents[0].after.includes('break traverse;'));
      assert.ok(plan.documents[0].after.includes('// Preserve this trailing comment.'));
      const preview = await vscode.workspace.openTextDocument(
        vscode.Uri.parse('rocketbrain-java-refactor:/'+plan.id+'/0/after.java'));
      assert.equal(preview.getText(),plan.documents[0].after);
      const before = await fs.readFile(file,'utf8');
      const result = await api.java.refactoring.apply(plan.id);
      assert.equal(result.state,'applied');
      assert.equal(result.savedToDisk,false);
      assert.equal(await fs.readFile(file,'utf8'),before);
      assert.ok(document.isDirty && await document.save());
      await build();
      conversions.push(plan.conversion);
    }
    const jdbc = await jdbcReadback();
    assert.ok(jdbc);
    checks.push('Reviewed and applied array and immutable List enhanced loops in the imported Spring project, with stable source and classpath checks.');
    return {conversions,unsafeLoopsRejected:3,staleReviewRejected:true,springBuild:true,diskUntouchedBeforeSave:true,jdbc};
  } finally {
    if (document?.isDirty) await document.save();
    await fs.unlink(file);
  }
}

module.exports = { runJavaEnhancedIterationChecks };
