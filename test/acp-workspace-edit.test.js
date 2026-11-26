'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { prepareWorkspacePrompt, reviewWorkspaceEdit } = require('../src/ai/acp-workspace-edit');
const { registerWorkspaceAcpEdits } = require('../src/ai/acp-workspace-edit-vscode');

const originals = ['class One { String label = "old-one"; }\n', 'class Two { String label = "old-two"; }\r\n'];
const answer = { summary: 'Change the labels.', edits: [
  { id: 'file1', find: '"old-one"', replace: '"new-one"' }, { id: 'file2', find: '"old-two"', replace: '"new-two"' }
] };

test('only the exact unique selected source fragments become replacements', () => {
  const prepared = prepareWorkspacePrompt(originals.map((text, index) => ({ name: `Source${index}.java`, text })), 'Change the string labels');
  const reply = output => ({ stopReason: 'end_turn', output: JSON.stringify(output) });
  const result = reviewWorkspaceEdit(prepared, reply(answer));
  assert.equal(result.edits.length, 2);
  assert.equal(result.edits[0].after, originals[0].replace('old-one', 'new-one'));
  assert.equal(result.edits[1].after, originals[1].replace('old-two', 'new-two').replace('\r\n','\n'));
  assert.throws(() => reviewWorkspaceEdit(prepared, reply({ ...answer, edits: [answer.edits[0], answer.edits[0]] })), /source ID/);
  assert.throws(() => reviewWorkspaceEdit(prepared, reply({ ...answer, edits: [answer.edits[0], { ...answer.edits[1], id: '../outside.java' }] })), /source ID/);
  assert.throws(() => reviewWorkspaceEdit(prepared, reply({ ...answer, edits: [answer.edits[0], { ...answer.edits[1], find: 'missed' }] })), /unique changed/);
  assert.throws(() => reviewWorkspaceEdit(prepared, { stopReason: 'max_tokens', output: JSON.stringify(answer) }), /complete bounded/);
});

test('the reviewed batch applies in one editor operation only after all source versions and bytes are checked', async () => {
  const parent = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(parent, 'rb-acp-edit-unit-'));
  const handle = { dispose() {} };
  const uri = fsPath => ({ fsPath, scheme: 'file', toString: () => pathToFileURL(fsPath).href });
  const rootUri = uri(root), uris = ['One.java','Two.java'].map(name => uri(path.join(root, name)));
  const docs = new Map();
  const applied = [];
  const providers = [];
  const fixture = path.join(__dirname, 'fixtures/acp-workspace-peer.cjs');
  const subscriptions = [];
  try {
    for (const [index, file] of uris.entries()) {
      const contents = originals[index];
      await fs.writeFile(file.fsPath, contents);
      docs.set(file.fsPath, { uri: file, isDirty: false, isClosed: false, version: 1, eol: index ? 2 : 1,
        getText: () => contents, positionAt: offset => offset });
    }
    const real = { commands: { registerCommand: () => handle, executeCommand: async () => {} },
      Uri: { from: data => data }, EndOfLine: { CRLF: 2 }, Range: class { constructor(start, end) { Object.assign(this, { start, end }); } },
      WorkspaceEdit: class { edits = []; replace(...args) { this.edits.push(args); } },
      workspace: { isTrusted: true, getWorkspaceFolder: () => ({ uri: rootUri }), getConfiguration: () => ({
        get: name => name === 'agents' ? [{ label: 'Test local peer', executable: process.execPath, args: [fixture] }] : undefined
      }), openTextDocument: async file => docs.get(file.fsPath), onDidChangeWorkspaceFolders: () => handle,
      onDidChangeConfiguration: () => handle, registerTextDocumentContentProvider: (_id, provider) => { providers.push(provider); return handle; },
      async applyEdit(edit) { applied.push(edit.edits); return true; } } };
    const adapter = registerWorkspaceAcpEdits({ subscriptions }, real);
    const request = await adapter.stage({ uris, input: 'Replace the two labels', agentLabel: 'Test local peer' });
    await assert.rejects(adapter.generate(request.id, { confirmed: false }), /Review the exact/);
    const plan = await adapter.generate(request.id, { confirmed: true });
    assert.equal(plan.files.length, 2);
    const diff = await adapter.openDiff(plan.id, plan.files[0].id);
    assert.match(providers[0].provideTextDocumentContent(diff.after), /"new-one"/);
    const approval = { confirmed: true, fingerprint: plan.fingerprint };
    await fs.writeFile(uris[1].fsPath, 'class ChangedExternally {}\n');
    await assert.rejects(adapter.apply(plan.id, approval), /saved Java source differs/);
    assert.equal(applied.length, 0);
    await fs.writeFile(uris[1].fsPath, originals[1]);
    await assert.rejects(adapter.apply(plan.id, { ...approval, fingerprint: 'different' }), /Approve the exact/);
    assert.deepEqual(await adapter.apply(plan.id, approval), { applied: true, files: 2, saved: false });
    assert.equal(applied.length, 1);
    assert.equal(applied[0].length, 2);
    assert.equal(applied[0][0][2], '"new-one"');
    assert.equal(applied[0][1][2], '"new-two"');
    await assert.rejects(adapter.apply(plan.id, approval), /expired/);
    for (const [index, file] of uris.entries()) assert.equal(await fs.readFile(file.fsPath, 'utf8'), originals[index]);
  } finally {
    for (const item of subscriptions) item.dispose();
    const cleanup = await fs.realpath(root);
    assert.equal(path.dirname(cleanup), parent);
    assert.match(path.basename(cleanup), /^rb-acp-edit-unit-/);
    await fs.rm(cleanup, { recursive: true, maxRetries: 5 });
  }
});
