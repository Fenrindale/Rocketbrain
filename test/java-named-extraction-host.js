'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { importedSpring,jdbcReadback } = require('./java-source-analysis-host');
const { namedExtractionFixture,assertNamedBody } = require('./helpers/java-named-extraction-fixture');
const { until } = require('./helpers/stdio-lsp');

async function runJavaNamedExtractionChecks(api,vscode,checks) {
  const service = api.javaSourceAnalysis;
  assert.ok(service?.inspectValueExtraction && service?.prepareValueExtraction);
  const commandByKind = {local:'rocketbrain.java.extractVariable',field:'rocketbrain.java.extractField'};
  const commands = await vscode.commands.getCommands(true);
  assert.ok(Object.values(commandByKind).every(command => commands.includes(command)));
  const workspace = vscode.workspace.workspaceFolders[0].uri.fsPath;
  await importedSpring(api,workspace);
  const fixture = namedExtractionFixture('fixture.boot','RbNamedExtraction'+randomBytes(5).toString('hex'));
  const file = path.join(workspace,'src/main/java/fixture/boot',fixture.className+'.java');
  const uri = vscode.Uri.file(file);
  let document, created = false;
  try {
    await fs.writeFile(file,fixture.source,{flag:'wx'});
    created = true;
    document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document,{preview:false});
    const original = document.getText();
    const at = original.indexOf(fixture.expression);
    const selection = new vscode.Range(document.positionAt(at),document.positionAt(at+fixture.expression.length));
    const build = await api.java.buildWorkspace();
    assert.ok(build === 0 || build === 1 || build?.status === 'succeed');
    const actions = await until(async () => {
      const found = await vscode.commands.executeCommand('vscode.executeCodeActionProvider',uri,selection,'refactor',100);
      const selected = Object.values(commandByKind).map(command => found?.find(action => action.command?.command === command));
      return selected.every(Boolean) ? selected : false;
    },45000);
    for (const action of actions) {
      assert.equal(action.edit,undefined);
      assert.equal(action.command.arguments[0].version,document.version);
    }
    const inspect = kind => service.inspectValueExtraction({kind,document,range:selection});
    const local = await inspect('local');
    const field = await inspect('field');
    assert.equal(local.type,'int');
    assert.equal(field.owner,'fixture.boot.'+fixture.className);
    for (const name of ['input','otherField','inheritedValue']) {
      await assert.rejects(service.prepareValueExtraction(field,{name}),/conflicts with an existing (?:source or inherited )?symbol/);
    }
    const localPlan = await service.prepareValueExtraction(local,{name:'chosenLocal'});
    const staleField = await service.prepareValueExtraction(field,{name:'staleField'});
    async function checkApplyUndo(plan,kind,name,checkedNames,afterApply) {
      assert.deepEqual(plan.extraction,{kind,name,type:'int',owner:field.owner,checkedNames,selectedOccurrences:1});
      assert.equal(plan.documents.length,1);
      assert.equal(plan.resourceOperations.length,0);
      assert.equal(plan.documents[0].before,original);
      assert.equal(plan.documents[0].edits.length,1);
      const after = plan.documents[0].after;
      const normalized = text => text.replace(/\r\n/g,'\n');
      assertNamedBody(fixture,normalized(after),kind,name);
      const preview = await vscode.workspace.openTextDocument(vscode.Uri.parse('rocketbrain-java-refactor:/'+plan.id+'/0/after.java'));
      assert.equal(normalized(preview.getText()),normalized(after));
      const applied = await api.java.refactoring.apply(plan.id);
      assert.equal(applied.state,'applied');
      assert.equal(document.getText(),after);
      assert.ok(document.isDirty);
      assert.equal(await fs.readFile(file,'utf8'),fixture.source);
      await afterApply?.();
      await vscode.window.showTextDocument(document,{preview:false});
      await vscode.commands.executeCommand('undo');
      await until(() => document.getText() === original,10000);
      assert.equal(document.isDirty,false);
    }
    await checkApplyUndo(localPlan,'local','chosenLocal',2,async () => {
      await assert.rejects(api.java.refactoring.apply(staleField.id),/changed/);
      assert.doesNotMatch(document.getText(),/staleField/);
    });
    const fieldPlan = await service.prepareValueExtraction(await inspect('field'),{name:'chosenField'});
    assert.ok(fieldPlan.warnings.some(warning => /private instance field/.test(warning)));
    await checkApplyUndo(fieldPlan,'field','chosenField',3);
    const jdbc = await jdbcReadback();
    assert.ok(jdbc,'Use the owned Spring JDBC fixture for native extraction verification.');
    checks.push('Ordinary JDT local and field code actions opened guarded naming workflows in imported Spring source.');
    checks.push('Javac verified the renamed declarations and exact use sites. Native previews applied as one undoable buffer edit and stale review was refused.');
    return {springWorkspace:true,jdbc,variableNamed:true,fieldNamed:true,checkedLocalBindings:2,checkedFieldBindings:3,
      oneEditPerOperation:true,unchangedOtherOccurrence:true,nameCollisionsRefused:true,stalePlanRefused:true,nativeUndo:true,diskPreserved:true};
  } finally {
    try {
      if (document?.isDirty) {
        await vscode.window.showTextDocument(document,{preview:false});
        if (vscode.window.activeTextEditor?.document === document) await vscode.commands.executeCommand('workbench.action.files.revert');
      }
    } finally { if (created) await fs.rm(file,{force:true}); }
  }
}

module.exports = { runJavaNamedExtractionChecks };
