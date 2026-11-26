'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {randomBytes} = require('node:crypto');
const {importedSpring,jdbcReadback} = require('./java-source-analysis-host');

async function runJavaDelegatedBuildChecks(api,vscode,checks) {
  const service = api.java.delegatedBuild;
  assert.ok(service?.prepare && service?.apply);
  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes('rocketbrain.java.reviewDelegatedCompile'));
  assert.ok(commands.includes('rocketbrain.java.retryDelegatedCompile'));
  const root = await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
  const project = await importedSpring(api,root);
  assert.equal(project.tool,'gradle');
  const projectUri = project.uri;
  const name = 'RbDelegatedCompile'+randomBytes(5).toString('hex');
  const file = path.join(root,'src/main/java/fixture/boot',name+'.java');
  const source = result=>'package fixture.boot;\npublic final class '+name+
    ' { public static int value() { return '+result+'; } }\n';
  let document;
  async function replace(value,save) {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri,new vscode.Range(document.positionAt(0),document.positionAt(document.getText().length)),source(value));
    assert.ok(await vscode.workspace.applyEdit(edit));
    if (save) assert.ok(await document.save());
  }
  const apply = plan=>service.apply({id:plan.id,allowProjectExecution:true});
  const run = async options=>apply(await service.prepare({projectUri,...options}));
  await fs.writeFile(file,source('2'),{flag:'wx'});
  try {
    document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    const first = await run();
    assert.equal(first.state,'succeeded');
    assert.ok(first.classes.after>0);
    const repeat = await run();
    assert.equal(repeat.state,'succeeded');
    assert.equal(repeat.classes.state,'outputs-reused');

    const stale = await service.prepare({projectUri});
    await replace('"invalid"',false);
    await assert.rejects(apply(stale),/Save the selected project source/u);
    assert.equal(await fs.readFile(file,'utf8'),source('2'));
    assert.ok(await document.save());
    await assert.rejects(apply(stale),/inputs changed/u);
    const failed = await run();
    assert.equal(failed.state,'failed');
    assert.equal(failed.classes.state,'unverified');
    await replace('7',true);
    const prepared = await service.prepare({projectUri,retryFrom:failed.id});
    assert.equal(prepared.retryOf,failed.id);
    assert.ok(prepared.sincePrevious.changed.includes('src/main/java/fixture/boot/'+name+'.java'));
    const healed = await apply(prepared);
    assert.equal(healed.state,'succeeded');
    assert.equal(healed.retryOf,failed.id);
    assert.ok(service.report().some(report=>report.id===healed.id));
    const jdbc = await jdbcReadback();
    assert.ok(jdbc);
    checks.push('The installed Java workbench delegated an unchanged repeat, reported native compiler failure and retried the repaired saved Spring source without cleaning the project.');
    return {repeat:repeat.classes.state,failed:failed.state,staleRefused:true,dirtyRefused:true,
      recovered:healed.state,explicitRetry:true,classesAfter:healed.classes.after,jdbc};
  } finally {
    if (document?.isDirty) await document.save();
    await fs.unlink(file);
  }
}

module.exports = {runJavaDelegatedBuildChecks};
