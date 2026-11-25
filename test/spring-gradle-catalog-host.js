'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const {verify} = require('./helpers/spring-gradle-catalog-fixture');

async function runSpringGradleCatalogChecks(api,vscode,checks) {
  const service = api.springProjects;
  assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.spring.editStarters'));
  const config = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG,'utf8'));
  const report = await verify(service,config,{
    async onReview(review,catalog) {
      const uri = part=>vscode.Uri.parse('rocketbrain-spring-projects:/'+review.reviewId+'/'+part);
      const summary = await vscode.workspace.openTextDocument(uri('review.md'));
      const before = await vscode.workspace.openTextDocument(uri('before'));
      const after = await vscode.workspace.openTextDocument(uri('after'));
      assert.match(summary.getText(),/Gradle catalog platform org\.springframework\.boot:spring-boot-dependencies/u);
      assert.match(summary.getText(),/version\.ref bootRelease/u);
      assert.match(summary.getText(),/Reviewed input gradle\/libs\.versions\.toml/u);
      assert.equal(before.getText(),review.before);
      assert.equal(after.getText(),review.after);
      await vscode.commands.executeCommand('vscode.diff',uri('before'),uri('after'),'Review Gradle catalog starter changes');
      const companion = await vscode.workspace.openTextDocument(vscode.Uri.file(catalog));
      await vscode.window.showTextDocument(companion,{preview:false});
      const original = companion.getText();
      const edit = new vscode.WorkspaceEdit();
      edit.insert(companion.uri,companion.positionAt(original.length),'# unsaved catalog change\n');
      assert.ok(await vscode.workspace.applyEdit(edit));
      try {
        assert.ok(companion.isDirty);
        await assert.rejects(service.apply({reviewId:review.reviewId,allowWrite:true,allowProjectExecution:true}),
          error=>error.code==='ROCKETBRAIN_SPRING_PROJECT_STALE');
      } finally {
        await vscode.commands.executeCommand('undo');
        assert.equal(companion.getText(),original);
        if (companion.isDirty) assert.ok(await companion.save());
      }
    },
    async onSaved(build,review) {
      const editor = await vscode.workspace.openTextDocument(vscode.Uri.file(build));
      await vscode.window.showTextDocument(editor,{preview:false});
      assert.equal(editor.getText(),review.after);
      await vscode.commands.executeCommand('undo');
      assert.equal(editor.getText(),review.before);
      await vscode.commands.executeCommand('redo');
      assert.equal(editor.getText(),review.after);
      assert.equal(await editor.save(),true);
    }
  });
  assert.equal(report.nativeUndo,true);
  checks.push('A reviewed Gradle catalog starter edit preserved Boot version references and rejected stale or dirty companion files. Native Undo/Redo and the real BOM-resolved application build and JDBC probe passed.');
  return {...report,nativeCatalogEdit:true,nativeUndoRedo:true,dirtyCatalogRefused:true};
}

module.exports = {runSpringGradleCatalogChecks};
