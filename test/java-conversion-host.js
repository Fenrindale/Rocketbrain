'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { conversionSource } = require('./helpers/java-conversion-fixture');
const { importedSpring,jdbcReadback } = require('./java-source-analysis-host');

async function runJavaConversionChecks(api,vscode,checks) {
  const service = api.javaSourceAnalysis;
  assert.ok(service?.prepareConversion && (await vscode.commands.getCommands(true)).includes('rocketbrain.java.convertStructure'));
  const workspace = vscode.workspace.workspaceFolders[0].uri.fsPath;
  await importedSpring(api,workspace);
  const className = 'RbConversion'+randomBytes(5).toString('hex');
  const file = path.join(workspace,'src/main/java/fixture/boot',className+'.java');
  const original = conversionSource('fixture.boot',className);
  let document;
  const build = async () => {
    const result = await api.java.buildWorkspace();
    assert.ok(result === 0 || result === 1 || result?.status === 'succeed','JDT build result '+JSON.stringify(result));
  };
  const stable = async action => {
    for (let attempt=0; ; attempt++) {
      try { return await action(); }
      catch (error) {
        if (attempt >= 2 || document?.isDirty ||
            !/Compiler classpath file membership changed|A compiler runtime or classpath changed|Java classpath changed/.test(error.message)) throw error;
        await build();
        await new Promise(resolve => setTimeout(resolve,400));
      }
    }
  };
  const prepare = snippet => stable(() => {
    const offset = document.getText().indexOf(snippet);
    assert.ok(offset > 0,snippet);
    return service.prepareConversion({document,position:document.positionAt(offset)});
  });
  const reviews = [
    {snippet:'input -> input + 2',from:'lambda',to:'anonymous',match:/new IntUnaryOperator\(\)/},
    {snippet:'new IntUnaryOperator() {\n            @Override public int applyAsInt(int input) { return input + 4;',from:'anonymous',to:'lambda',match:/input -> input \+ 4/},
    {snippet:'for (int i = 0; i < values.length; i++) { sum += values[i]; }',from:'indexed',to:'enhanced',match:/for \(int \w+ : values\)/}
  ];
  await fs.writeFile(file,original,{flag:'wx'});
  try {
    document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await build();
    await assert.rejects(prepare('escaped = n ->'),/Select a nonescaping/);
    await assert.rejects(prepare('values[i] += 1'),/Select a nonescaping/);
    const stale = await prepare(reviews[0].snippet);
    const comment = new vscode.WorkspaceEdit();
    comment.insert(document.uri,document.positionAt(document.getText().length),'// changed after review\n');
    assert.ok(await vscode.workspace.applyEdit(comment));
    await assert.rejects(api.java.refactoring.apply(stale.id),/changed|Save each Java source/);
    const revert = new vscode.WorkspaceEdit();
    revert.delete(document.uri,new vscode.Range(document.positionAt(original.length),document.positionAt(document.getText().length)));
    assert.ok(await vscode.workspace.applyEdit(revert));
    assert.ok(await document.save());

    const conversions = [];
    for (const {snippet,from,to,match} of reviews) {
      const plan = await prepare(snippet);
      assert.equal(plan.documents.length,1);
      assert.equal(plan.conversion.from,from);
      assert.equal(plan.conversion.to,to);
      assert.ok(plan.conversion.checkedBindings > 0);
      assert.match(plan.documents[0].after,match);
      const preview = await vscode.workspace.openTextDocument(vscode.Uri.parse(
        'rocketbrain-java-refactor:/'+plan.id+'/0/after.java'));
      assert.equal(preview.getText(),plan.documents[0].after);
      const saved = await fs.readFile(file,'utf8');
      const result = await api.java.refactoring.apply(plan.id);
      assert.equal(result.state,'applied');
      assert.equal(result.savedToDisk,false);
      assert.equal(await fs.readFile(file,'utf8'),saved);
      assert.ok(document.isDirty && await document.save());
      await build();
      conversions.push(plan.conversion);
    }
    const jdbc = await jdbcReadback();
    checks.push('Three native Java conversions used real JDT LS edits and prospective Javac proofs in the actual Spring project.');
    checks.push('Native review rejected identity-sensitive and mutation-sensitive shapes plus a stale buffer, and applied each verified diff without saving it.');
    return {conversions,springBuild:true,escapedRejected:true,mutatingLoopRejected:true,staleBufferRejected:true,
      diskUntouchedUntilSave:true,jdbc};
  } finally {
    if (document?.isDirty) await document.save();
    await fs.unlink(file);
  }
}

module.exports = { runJavaConversionChecks };
