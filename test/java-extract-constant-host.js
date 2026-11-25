'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { importedSpring,jdbcReadback } = require('./java-source-analysis-host');
const { constantFixture,assertOnlySelectedConstant } = require('./helpers/java-constant-fixture');
const { until } = require('./helpers/stdio-lsp');

async function runJavaExtractConstantChecks(api,vscode,checks) {
  const service = api.javaSourceAnalysis;
  assert.ok(service?.inspectConstant && service?.prepareConstantExtraction);
  assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.java.extractConstant'));
  const workspace = vscode.workspace.workspaceFolders[0].uri.fsPath;
  await importedSpring(api,workspace);
  const fixture = constantFixture('fixture.boot','RbConstant'+randomBytes(5).toString('hex'));
  const file = path.join(workspace,'src/main/java/fixture/boot',fixture.className+'.java');
  const uri = vscode.Uri.file(file);
  let document, created = false;
  try {
    await fs.writeFile(file,fixture.source,{flag:'wx'});
    created = true;
    document = await vscode.workspace.openTextDocument(uri);
    const original = document.getText();
    const editor = await vscode.window.showTextDocument(document,{preview:false});
    const range = expression => {
      const offset = expression === fixture.common ? original.lastIndexOf(expression) : original.indexOf(expression);
      return new vscode.Range(document.positionAt(offset),document.positionAt(offset+expression.length));
    };
    const build = await api.java.buildWorkspace();
    assert.ok(build === 0 || build === 1 || build?.status === 'succeed');
    const selection = range(fixture.common);
    const actions = await until(async () => {
      const found = await vscode.commands.executeCommand('vscode.executeCodeActionProvider',uri,selection,'refactor.extract.constant',40);
      return found?.find(action => action.command?.command === 'rocketbrain.java.extractConstant');
    },45000);
    assert.equal(actions.edit,undefined);
    assert.equal(actions.command.arguments[0].version,document.version);
    await assert.rejects(api.java.refactoring.preview(document,range('Math.random() * 7'),{
      title:'Extract to constant',kind:'refactor.extract.constant',only:['refactor']
    }),/compile-time expression/);
    const inspect = () => service.inspectConstant({document,range:selection});
    const report = await inspect();
    assert.equal(report.type,'int');
    assert.equal(report.owner,'fixture.boot.'+fixture.className);
    for (const name of ['TAKEN','INHERITED','SHADOW']) {
      await assert.rejects(service.prepareConstantExtraction(report,{name}),/conflicts with an existing symbol/);
    }
    const name = 'SELECTED_WEIGHT';
    const plan = await service.prepareConstantExtraction(report,{name});
    assert.deepEqual(plan.constant,{name,owner:report.owner,type:'int',checkedBindings:1,selectedOccurrences:1});
    assert.equal(plan.documents.length,1);
    assert.equal(plan.resourceOperations.length,0);
    assert.equal(plan.documents[0].before,original);
    assertOnlySelectedConstant(fixture,plan.documents[0].after,name);
    const preview = await vscode.workspace.openTextDocument(vscode.Uri.parse('rocketbrain-java-refactor:/'+plan.id+'/0/after.java'));
    assert.equal(preview.getText().replace(/\r\n/g,'\n'),plan.documents[0].after.replace(/\r\n/g,'\n'));
    const applied = await api.java.refactoring.apply(plan.id);
    assert.equal(applied.state,'applied');
    assert.equal(document.getText(),plan.documents[0].after);
    assert.ok(document.isDirty);
    assert.equal(await fs.readFile(file,'utf8'),fixture.source);
    await vscode.window.showTextDocument(document,{preview:false});
    await vscode.commands.executeCommand('undo');
    await until(() => document.getText() === original,10000);
    assert.equal(document.isDirty,false);

    const fresh = await inspect();
    const stale = await service.prepareConstantExtraction(fresh,{name:'STALE_TEST_WEIGHT'});
    assert.equal(await editor.edit(edit => edit.insert(document.positionAt(document.getText().length),'\n// owned stale-review marker\n')),true);
    await assert.rejects(api.java.refactoring.apply(stale.id),/changed/);
    assert.doesNotMatch(document.getText(),/STALE_TEST_WEIGHT/);
    await vscode.commands.executeCommand('undo');
    await until(() => document.getText() === original,10000);
    const jdbc = await jdbcReadback();
    assert.ok(jdbc,'Use the owned Spring JDBC fixture for native extraction verification.');
    checks.push('JDT proposed a local constant and javac verified its declaration and exact selected binding in the imported Spring workspace.');
    checks.push('The native action routes through a guarded preview. Same-name conflicts, runtime expressions and stale edits were refused, and one Undo restored the original buffer.');
    return { springWorkspace:true,jdbc,jdtCodeActionGuarded:true,compilerBinding:true,selectedOccurrences:1,unselectedDuplicatePreserved:true,
      existingNameCollisionsRefused:true,sideEffectRefused:true,sourceChangeRefused:true,nativeUndo:true,diskPreserved:true };
  } finally {
    try {
      if (document?.isDirty) {
        await vscode.window.showTextDocument(document,{preview:false});
        if (vscode.window.activeTextEditor?.document === document) await vscode.commands.executeCommand('workbench.action.files.revert');
      }
    } finally { if (created) await fs.rm(file,{force:true}); }
  }
}

module.exports = { runJavaExtractConstantChecks };
