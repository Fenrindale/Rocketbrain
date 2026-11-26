'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const { until } = require('./helpers/stdio-lsp');

async function verifyWslSourceWatch(wsl, vscode, { document, peerUri, appendFromLinux }) {
  const watcher = wsl.sourceWatch;
  const installed = await vscode.commands.getCommands(true);
  for (const contribution of ['watchSource', 'compareSource', 'reloadSource', 'stopSourceWatch']) {
    assert.ok(installed.includes('rocketbrain.wsl.' + contribution), contribution);
  }
  const original = document.getText();
  const initial = '// Linux wrote the first reviewed source version';
  const second = '// Linux wrote the next reviewed source version';
  try {
    const started = await watcher.start(document);
    assert.equal(started.state, 'watching');
    await appendFromLinux(initial);
    await until(() => watcher.state().state === 'changed', 20000);
    assert.equal(document.getText(), original);
    assert.equal(document.isDirty, false);
    const first = await watcher.showComparison();
    const left = await vscode.workspace.openTextDocument(first.editorUri);
    const right = await vscode.workspace.openTextDocument(first.linuxUri);
    assert.equal(left.getText(), original);
    assert.ok(right.getText().includes(initial));
    assert.equal(vscode.window.activeTextEditor.document, document);
    await assert.rejects(watcher.reload(first.token), /explicitly approve/u);
    await appendFromLinux(second);
    await assert.rejects(watcher.reload(first.token, { approved: true }), /Linux source changed/u);
    assert.equal(document.getText(), original);

    const dirtyPreflight = await watcher.compare();
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    assert.equal(await editor.edit(edit => edit.insert(document.positionAt(0), '// local unsaved control\n')), true);
    await assert.rejects(watcher.reload(dirtyPreflight.token, { approved: true }), /dirty or changed/u);
    assert.ok(document.getText().startsWith('// local unsaved control'));
    await vscode.commands.executeCommand('undo');
    await until(() => !document.isDirty && document.getText() === original, 10000);

    const latest = await watcher.showComparison();
    const other = await vscode.window.showTextDocument(peerUri, { viewColumn: vscode.ViewColumn.Beside, preview: false });
    const peerText = other.document.getText(), peerVersion = other.document.version;
    const receipt = await watcher.reload(latest.token, { approved: true });
    assert.equal(receipt.state, 'reloaded');
    assert.equal(receipt.sourceUri, document.uri.toString());
    await assert.rejects(watcher.reload(latest.token, { approved: true }), /explicitly approve/u);
    const reloaded = await vscode.workspace.openTextDocument(document.uri);
    assert.ok(reloaded.getText().includes(initial) && reloaded.getText().includes(second));
    assert.equal(reloaded.isDirty, false);
    assert.equal(watcher.state().state, 'watching');
    assert.equal(vscode.window.activeTextEditor.document, other.document);
    assert.equal(other.document.getText(), peerText);
    assert.equal(other.document.version, peerVersion);
    const disk = await fs.readFile(document.uri.fsPath);
    assert.equal(createHash('sha256').update(disk).digest('hex'), receipt.sha256);
    console.log('WSL Linux-side fallback reload verified with stale-disk and dirty-editor controls.');
    return { document: reloaded, receipt: { observedLinuxChange: true, readOnlyComparison: true,
      reloadClean: true, diskSha256: receipt.sha256, dirtyEditorPreserved: true,
      newerDiskRefused: true, approvalRequired: true, approvalConsumed: true, peerFocusPreserved: true } };
  } finally { watcher.stop(); }
}

module.exports = { verifyWslSourceWatch };
