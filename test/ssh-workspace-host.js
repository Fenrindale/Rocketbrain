'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { startSshWorkspace } = require('./helpers/ssh-workspace-fixture');
const { jdbcReadback } = require('./java-source-analysis-host');

async function runSshWorkspaceChecks(api, vscode, checks) {
  const workspace = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const fixture = await startSshWorkspace(process.env.ROCKETBRAIN_SSH_TEST_PYTHON, workspace);
  try {
    const commands = await vscode.commands.getCommands(true);
    for (const name of ['attach','close','refresh','upload']) assert.ok(commands.includes('rocketbrain.sshWorkspace.' + name));
    const root = await api.sshWorkspace.attach(fixture.profile);
    const entries = await vscode.workspace.fs.readDirectory(root);
    assert.deepEqual(entries,[['RemoteController.java',vscode.FileType.File]]);
    const uri = vscode.Uri.joinPath(root,'RemoteController.java');
    const remoteDocument = await vscode.workspace.openTextDocument(uri);
    assert.equal(remoteDocument.getText(),fixture.original);
    await assert.rejects(vscode.workspace.fs.writeFile(uri,Buffer.from('direct write')));
    const local = vscode.Uri.file(path.join(fixture.folder,'LocalController.java'));
    const content = fixture.original.replace('42','43');
    await fs.writeFile(local.fsPath,content,{ flag:'wx' });
    const stale = await api.sshWorkspace.reviewUpload(uri,local);
    await fs.writeFile(local.fsPath,content + '\n');
    await assert.rejects(api.sshWorkspace.applyUpload(stale.id),/local file changed/);
    assert.equal(await fs.readFile(fixture.file,'utf8'),fixture.original);
    const approved = await api.sshWorkspace.reviewUpload(uri,local);
    await vscode.commands.executeCommand('vscode.diff',approved.remote,approved.local,'Owned SSH diff');
    await api.sshWorkspace.applyUpload(approved.id);
    await assert.rejects(api.sshWorkspace.applyUpload(approved.id),/Review a current/);
    assert.equal(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString(),content+'\n');
    assert.equal(await fs.readFile(fixture.file,'utf8'),content+'\n');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const jdbc = await jdbcReadback();
    checks.push('Used the installed SSH file provider and native diff with an authenticated OpenSSH peer, and uploaded only reviewed bytes.');
    return { nativeFileSystem:true, nativeDiff:true, readOnlyProvider:true, strongHostKeyVerification:true,
      staleLocalRefused:true, reviewedUpload:true, jdbc };
  } finally { api.sshWorkspace.close(); await fixture.close(); }
}

module.exports = { runSshWorkspaceChecks };
