'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { inlineWorkstation } = require('./helpers/editor-inline-host');
const { startLocalModel } = require('./helpers/local-sql-model-fixture');
const { jdbcReadback } = require('./java-source-analysis-host');

const prefix = 'final class InlineFixture {\n    // This method returns the integer 42.\n    int answer() { return ';
const suffix = '; }\n}\n';
const initial = prefix + suffix;

function verifyProposal(suggestions) {
  assert.equal(suggestions.length, 1);
  const [item] = suggestions;
  assert.equal(item.insertText.trim(), '42');
  assert.equal(item.range.isEmpty, true);
  return item;
}

async function verifyEditorInlineModel(model) {
  const parent = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(parent, 'rb-real-inline-model-'));
  const file = path.join(root, 'InlineFixture.java');
  await fs.writeFile(file, initial, { flag: 'wx' });
  const host = inlineWorkstation(root, file, initial, model);
  try {
    host.setCursor(prefix.length);
    assert.deepEqual(await host.complete(), []);
    assert.equal(await host.invoke('enableInline'), true);
    const item = verifyProposal(await host.complete(host.vscode.InlineCompletionTriggerKind.Automatic));
    assert.equal(item.range.start.offset, prefix.length);
    assert.equal(await fs.readFile(file, 'utf8'), initial);
    assert.equal(host.document.getText(), initial);
    const accepted = initial.slice(0, item.range.start.offset) + item.insertText + initial.slice(item.range.end.offset);
    assert.match(accepted, /return\s+42\s*;/u);
    await host.invoke('disableInline');
    assert.deepEqual(await host.complete(), []);
    return { model: 'Qwen2.5-Coder-1.5B-Instruct Q4_K_M', registeredProvider: true, explicitPerFileApproval: true,
      cursorOnly: true, exactJavaInsertion: '42', unchangedBeforeAcceptance: true, revokedOnStop: true };
  } finally {
    host.codeModel.dispose();
    await fs.unlink(file);
    await fs.rmdir(root);
  }
}

async function runEditorInlineModelChecks(api, vscode, checks) {
  const supplied = { endpoint: process.env.ROCKETBRAIN_LOCAL_MODEL_ENDPOINT, model: process.env.ROCKETBRAIN_LOCAL_MODEL_ID };
  const parent = await fs.realpath(process.env.ROCKETBRAIN_JAVA_TEST_WORKSPACE);
  assert.ok(parent.split(path.sep).includes('test-output'));
  assert.equal(await fs.realpath(vscode.workspace.getWorkspaceFolder(vscode.Uri.file(parent)).uri.fsPath), parent);
  const folder = await fs.mkdtemp(path.join(parent, 'rb-inline-editor-'));
  const file = path.join(folder, 'InlineFixture.java');
  const preferences = vscode.workspace.getConfiguration('rocketbrain.localCodeModel');
  const keys = ['endpoint', 'model'];
  const previous = Object.fromEntries(keys.map(key => [key, preferences.inspect(key)?.workspaceValue]));
  const cancellation = new vscode.CancellationTokenSource();
  const inline = api.codeModel.inline;
  let document, owned;
  try {
    if (!supplied.endpoint || !supplied.model) owned = await startLocalModel();
    const model = owned ?? supplied;
    for (const key of keys) await preferences.update(key, model[key], vscode.ConfigurationTarget.Workspace);
    await fs.writeFile(file, initial, { flag: 'wx' });
    document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    const position = document.positionAt(prefix.length);
    const cursor = new vscode.Selection(position, position);
    const editor = await vscode.window.showTextDocument(document, { preview: false, selection: cursor });
    // Drain the opening selection and configuration events before approving the
    // file. These same events intentionally cancel an in-flight proposal.
    const deadline = Date.now() + 3000;
    while (!editor.selection.isEmpty || !editor.selection.active.isEqual(position)) {
      assert.ok(Date.now()<deadline,'The native cursor never reached the completion point.');
      await delay(25);
    }
    await vscode.commands.executeCommand('setContext','rocketbrain.fixtureInlineCursorReady',true);
    const provide = () => inline.provideInlineCompletionItems(document, position,
      { triggerKind: vscode.InlineCompletionTriggerKind.Invoke }, cancellation.token);
    assert.deepEqual(await provide(), []);
    assert.equal(await inline.approve(document, scope => scope.endpoint === model.endpoint && scope.model === model.model), true);
    assert.equal(vscode.window.activeTextEditor,editor);
    assert.equal(document.offsetAt(editor.selection.active),prefix.length);
    const item = verifyProposal(await provide());
    assert.ok(item.range.start.isEqual(position));
    assert.equal(document.getText(), initial);
    assert.equal(await fs.readFile(file, 'utf8'), initial);
    assert.equal(await editor.edit(change => change.insert(item.range.start, item.insertText)), true);
    assert.match(document.getText(), /return\s+42\s*;/u);
    inline.clear();
    assert.deepEqual(await provide(), []);
    checks.push('The local model provided one native cursor insertion for the approved Java file. The source was unchanged before the editor applied the exact suggestion.');
    return { localModel: true, typedNativeItem: true, noAutomaticEdit: true, revoked: true, jdbc: await jdbcReadback() };
  } finally {
    try {
      inline.clear();
      cancellation.dispose();
      if (document && !document.isClosed) {
        await vscode.window.showTextDocument(document, { preview: false });
        await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      }
      for (const key of keys) await preferences.update(key, previous[key], vscode.ConfigurationTarget.Workspace);
      await fs.unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
      await fs.rmdir(folder);
    } finally { await owned?.close(); }
  }
}

if (require.main === module) startLocalModel().then(async model => {
  try { console.log(JSON.stringify(await verifyEditorInlineModel(model))); }
  finally { await model.close(); }
}).catch(error => { console.error(error.stack); process.exitCode = 1; });

module.exports = { runEditorInlineModelChecks, verifyEditorInlineModel };
