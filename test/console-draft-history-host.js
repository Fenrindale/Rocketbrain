'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const {jdbcReadback}=require('./java-source-analysis-host');

const saved="SELECT '이전 버전' AS label;\r\n";
const latest="SELECT '현재 버전' AS label;\r\n";
const changed="SELECT '갱신됨' AS label;\r\n";

async function replace(vscode,editor,text) {
  const document=editor.document;
  return editor.edit(edit=>{
    edit.replace(new vscode.Range(document.positionAt(0),document.positionAt(document.getText().length)),text);
  });
}

async function seedConsoleDraftHistory(api,vscode,receipt) {
  // A Rocketbrain console establishes the editor context before the user opts into recovery.
  await vscode.commands.executeCommand('rocketbrain.openConsole');
  const editor=vscode.window.activeTextEditor;
  assert.equal(editor.document.languageId,'sql');
  const eol=vscode.EndOfLine.CRLF;
  assert.equal(await editor.edit(edit=>edit.setEndOfLine(eol),{undoStopBefore:false,undoStopAfter:true}),true);
  assert.equal(await replace(vscode,editor,saved),true);
  editor.selection=new vscode.Selection(editor.document.positionAt(12),editor.document.positionAt(7));
  const draft=await api.sqlDrafts.track(editor,'SQL checkpoints after restart');
  const first=await vscode.commands.executeCommand('rocketbrain.sqlDraft.checkpoint');
  assert.equal(first?.id,draft.id);
  assert.equal(await replace(vscode,editor,latest),true);
  const current=await vscode.commands.executeCommand('rocketbrain.sqlDraft.checkpoint');
  assert.notEqual(current?.revision,first.revision);
  assert.equal(api.sqlDrafts.history(draft.id).length,2);
  await fs.writeFile(receipt,JSON.stringify({id:draft.id,firstRevision:first.revision,currentRevision:current.revision,hostPid:process.pid}),{flag:'wx'});
}

async function runConsoleDraftHistoryChecks(api,vscode,checks,receipt) {
  const seed=JSON.parse(await fs.readFile(receipt,'utf8'));
  assert.notEqual(seed.hostPid,process.pid);
  assert.deepEqual(api.sessions(),[]);
  assert.deepEqual(api.results(),[]);
  const history=api.sqlDrafts.history(seed.id);
  assert.deepEqual(history.map(item=>item.revision),[seed.currentRevision,seed.firstRevision]);
  assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.sqlDraft.history'));
  const first=await api.sqlDrafts.reviewCheckpoint(seed.id,seed.firstRevision);
  const previous=await vscode.workspace.openTextDocument(vscode.Uri.parse(first.previousUri));
  const current=await vscode.workspace.openTextDocument(vscode.Uri.parse(first.currentUri));
  assert.equal(previous.getText().replaceAll('\r\n','\n'),saved.replaceAll('\r\n','\n'));
  assert.equal(current.getText().replaceAll('\r\n','\n'),latest.replaceAll('\r\n','\n'));
  assert.ok(vscode.window.tabGroups.all.some(group=>group.tabs.some(tab=>tab.label.includes('SQL Draft Checkpoint'))));
  const copy=await api.sqlDrafts.copyCheckpoint(first);
  assert.notEqual(copy.id,seed.id);
  assert.equal(copy.sourceRevision,seed.firstRevision);
  const editor=vscode.window.activeTextEditor;
  assert.equal(editor.document.uri.toString(),copy.uri);
  assert.equal(editor.document.getText(),saved);
  assert.equal(editor.document.eol,vscode.EndOfLine.CRLF);
  assert.deepEqual([editor.document.offsetAt(editor.selection.anchor),editor.document.offsetAt(editor.selection.active)],[12,7]);
  const original=await api.sqlDrafts.open(seed.id);
  const originalEditor=vscode.window.activeTextEditor;
  assert.equal(originalEditor.document.uri.toString(),original);
  assert.equal(originalEditor.document.getText(),latest);
  assert.equal(await replace(vscode,originalEditor,changed),true);
  await assert.rejects(api.sqlDrafts.copyCheckpoint(first),/current SQL draft changed/);
  assert.equal(api.sqlDrafts.history(seed.id).length,2);
  assert.deepEqual(api.results(),[]);
  const jdbc=await jdbcReadback();
  assert.deepEqual(jdbc,{people:2,departments:1,rolledBackNames:0});
  checks.push('A new VS Code process reopened two explicit SQL checkpoints, showed their read-only native diff and restored the older CRLF and cursor to a separate offline draft.');
  checks.push('The latest draft remained unchanged when the copy opened. A later buffer edit rejected the prior diff review.');
  return {separateHostPid:true,checkpointCount:2,nativeDiff:true,originalSurvived:true,exactOfflineCopy:true,
    staleDiffRefused:true,noSqlDispatched:true,jdbc};
}

module.exports={seedConsoleDraftHistory,runConsoleDraftHistoryChecks};
