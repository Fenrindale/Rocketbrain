'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {jdbcReadback}=require('./java-source-analysis-host');
const {createShelfFixture}=require('./helpers/git-shelf-fixture');

async function runGitShelfChecks(api,vscode,checks) {
  const workspace=await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
  assert.equal(workspace,await fs.realpath(process.env.ROCKETBRAIN_JAVA_TEST_WORKSPACE));
  assert.ok(workspace.split(path.sep).includes('test-output'));
  const root=await fs.mkdtemp(path.join(workspace,'rb-git-shelf-')), token=randomUUID();
  const marker=path.join(root,'.owner');await fs.writeFile(marker,token,{flag:'wx'});
  const service=api.changelists.shelf,options=directory=>({repositoryUri:vscode.Uri.file(directory).toString()});
  let fixture,document,virtual, original;
  try {
    fixture=await createShelfFixture(root,{spring:true});
    const from=options(fixture.origin),to=options(fixture.target),collision=options(fixture.conflict);
    const commands=await vscode.commands.getCommands(true);
    assert.ok(commands.includes('rocketbrain.vcs.shelveHunks')&&commands.includes('rocketbrain.vcs.shelves'));
    const reviewed=await service.inspect(from);
    const chosen=reviewed.hunks.filter(item=>item.newLine<15).map(item=>item.id);
    assert.equal(chosen.length,2);
    const preview=service.select(reviewed,chosen);
    virtual=await service.openPatch(preview.patch);
    assert.equal(virtual.document.uri.scheme,'rocketbrain-git-shelf');
    assert.equal(virtual.document.getText().replace(/\r\n/g,'\n'),preview.patch);
    assert.match(preview.patch,/return 2/u);
    assert.doesNotMatch(preview.patch,/unfinished line 34/u);
    const index=await fixture.indexBytes(fixture.origin);
    document=await vscode.workspace.openTextDocument(vscode.Uri.file(fixture.filename(fixture.origin)));
    original=document.getText();
    const pending=new vscode.WorkspaceEdit();
    pending.insert(document.uri,document.positionAt(original.length),'// Owned unsaved change\n');
    assert.equal(await vscode.workspace.applyEdit(pending),true);
    await assert.rejects(service.shelve(preview,'Owned Shelf'),/Save the reviewed/u);
    const clean=new vscode.WorkspaceEdit();
    clean.replace(document.uri,new vscode.Range(document.positionAt(0),document.positionAt(document.getText().length)),original);
    assert.equal(await vscode.workspace.applyEdit(clean),true);
    if(document.isDirty)assert.equal(await document.save(),true);
    const refreshed=await service.inspect(from);
    const item=await service.shelve(service.select(refreshed,refreshed.hunks.filter(hunk=>hunk.newLine<15).map(hunk=>hunk.id)),'Owned Shelf');
    assert.equal(item.state,'shelved');
    assert.deepEqual(await fixture.indexBytes(fixture.origin),index);
    assert.equal(await fs.readFile(fixture.filename(fixture.origin),'utf8'),fixture.indexText.replace(...fixture.untouched));
    const targetIndex=await fixture.indexBytes(fixture.target);
    const report=await service.previewRestore({...to,id:item.id});
    assert.equal(report.branch,'release');assert.equal(report.sourceBranch,'main');assert.equal(report.status,'ready');
    assert.equal((await service.restore(report)).status,'applied');
    assert.deepEqual(await fixture.indexBytes(fixture.target),targetIndex);
    assert.equal((await service.previewRestore({...to,id:item.id})).status,'already-applied');
    const before=await fs.readFile(fixture.filename(fixture.conflict,fixture.other));
    const rejected=await service.previewRestore({...collision,id:item.id});
    assert.equal(rejected.status,'conflict');
    assert.equal((await service.restore(rejected)).status,'conflict');
    assert.deepEqual(await fs.readFile(fixture.filename(fixture.conflict,fixture.other)),before);
    assert.equal((await service.list(to)).find(entry=>entry.id===item.id).count,2);
    const jdbc=await jdbcReadback();assert.ok(jdbc);
    checks.push('Native Git Shelf previewed selected Spring source hunks, preserved staged bytes and remaining work, restored to a linked release branch, and kept its patch after a repeat or conflict.');
    return {nativePreview:true,dirtyRefused:true,from:'main',to:'release',hunks:2,
      originalIndexPreserved:true,targetIndexPreserved:true,alreadyApplied:true,conflictRetained:true,jdbc};
  } finally {
    if(document?.isDirty) {
      const clean=new vscode.WorkspaceEdit();
      clean.replace(document.uri,new vscode.Range(document.positionAt(0),document.positionAt(document.getText().length)),original);
      await vscode.workspace.applyEdit(clean);
      await document.save();
    }
    const shown=new Set([virtual?.document.uri.toString(),document?.uri.toString()].filter(Boolean));
    const tabs=vscode.window.tabGroups.all.flatMap(group=>group.tabs).filter(tab=>shown.has(tab.input?.uri?.toString()));
    if(tabs.length)await vscode.window.tabGroups.close(tabs);
    try {
      if(fixture)for(const item of await service.list(options(fixture.origin)))await service.remove({...options(fixture.origin),id:item.id});
    } finally {
      assert.equal(await fs.realpath(root),root);assert.equal(path.dirname(root),workspace);
      assert.equal(await fs.readFile(marker,'utf8'),token);
      await fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:250});
    }
  }
}

module.exports={runGitShelfChecks};
