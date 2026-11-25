'use strict';

const assert=require('node:assert/strict');
const path=require('node:path');
const { createQualityFixture,runQualityCli }=require('./helpers/java-quality-fixture');

async function runJavaQualityGateChecks(api,vscode,checks) {
  const [workspace]=vscode.workspace.workspaceFolders;
  const fixture=await createQualityFixture(workspace.uri.fsPath);
  const reportFile=path.join(fixture.root,'assigned.sarif');
  let editor;
  try {
    assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.java.openQualityReport'));
    const extension=vscode.extensions.getExtension('rocketbrain-local.rocketbrain');
    const cli=path.join(extension.extensionPath,'dist','java-quality-gate.js');
    const run=await runQualityCli('node',cli,['--repo',fixture.root,'--revision',fixture.current,
      '--baseline-revision',fixture.baseline,'--output',reportFile]);
    assert.equal(run.exit,1,run.stderr);
    assert.match(run.stderr,/3 files, 1 new, 1 unchanged, 1 fixed, 1 blocking/);
    checks.push('The bundled CLI inspected committed Java via real Git, wrote SARIF 2.1.0, and exited 1 for a new warning while an existing warning stayed in the baseline.');
    await fixture.git('checkout','--quiet','--detach',fixture.baseline);
    const head=await fixture.git('rev-parse','HEAD');
    assert.equal(head,fixture.baseline);
    const status=await fixture.git('status','--porcelain=v1');
    const quality=api.javaInspections.quality;
    const report=await quality.read(vscode.Uri.file(reportFile),workspace.uri,vscode.Uri.file(fixture.root));
    assert.equal(report.revision,fixture.current);
    const item=report.items.findIndex(finding=>finding.state==='new');
    assert.ok(item>=0);
    editor=await quality.open(report,item);
    assert.equal(editor.document.uri.scheme,'rocketbrain-java-quality');
    assert.equal(editor.document.getText().replaceAll('\r\n','\n'),fixture.introduced);
    assert.equal(editor.document.getText(editor.selection),'catch (IllegalStateException problem) { }');
    await vscode.commands.executeCommand('type',{text:'unexpected document edit'});
    assert.equal(editor.document.isDirty,false);
    assert.equal(editor.document.getText().replaceAll('\r\n','\n'),fixture.introduced);
    assert.equal(await fixture.git('rev-parse','HEAD'),head);
    assert.equal(await fixture.git('status','--porcelain=v1'),status);
    checks.push('The native report opened a read-only source span from its exact Git commit even though the worktree was checked out to the baseline. Git HEAD and worktree status stayed intact.');
    return {successful:true,cliExit:run.exit,files:3,new:1,unchanged:1,fixed:1,blocking:1,
      exactCommit:true,readOnly:true,selectedRule:report.items[item].rule};
  } finally {
    if (editor && vscode.window.activeTextEditor?.document.uri.toString()===editor.document.uri.toString()) {
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    }
    await fixture.cleanup();
  }
}

module.exports={runJavaQualityGateChecks};
