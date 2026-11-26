'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { fileURLToPath, pathToFileURL } = require('node:url');
const { pyrightLaunch } = require('../src/python/pyright-runtime');
const { reviewedRename } = require('../src/python/pyright-vscode');
const { StdioLsp, positionOf, until } = require('./helpers/stdio-lsp');

const model = 'class Row:\n    balance: int\n\n    def __init__(self, balance: int) -> None:\n        self.balance = balance\n\n'
  + 'def compute(row: Row) -> int:\n    return row.balance\n';
const source = 'from model import Row, compute\nrow = Row(35)\nwrong: str = compute(row)\ncheck = row.balance\nrow.ba\n';

async function temporary(t, close) {
  const parent = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(parent, 'rb-python-analysis-'));
  t.after(async () => {
    await close?.();
    assert.equal(path.relative(parent, path.dirname(await fs.realpath(root))), '');
    assert.match(path.basename(root), /^rb-python-analysis-/);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 6 });
  });
  return root;
}

test('Python rename rejects filesystem operations, foreign documents and edits other than the requested name', async t => {
  const root = await temporary(t);
  const project = path.join(root, 'project');
  await fs.mkdir(project);
  const local = path.join(project, 'module.py'), outside = path.join(root, 'other.py');
  await fs.writeFile(local, source);
  await fs.writeFile(outside, source);
  const edit = { range: { start: {line:0,character:0}, end: {line:0,character:4} }, newText: 'target' };
  const change = file => ({ changes: { [pathToFileURL(file).href]: [edit] } });
  assert.deepEqual(reviewedRename(change(local), project, 'target'), change(local));
  assert.throws(() => reviewedRename(change(outside), project, 'target'), /outside the reviewed workspace/);
  assert.throws(() => reviewedRename(change(local), project, 'different'), /unsupported source changes/);
  assert.throws(() => reviewedRename({ documentChanges: [{ kind: 'rename', oldUri: pathToFileURL(local).href,
    newUri: pathToFileURL(outside).href }] }, project, 'target'), /source text/);
});

test('real Pyright reports and clears a Python type error, offers typed completion and cross-file navigation and rename', {
  skip: !process.env.ROCKETBRAIN_PYRIGHT_TEST_HOME && 'Supply the pinned open-source Pyright fixture.',
  timeout: 55000
}, async t => {
  let client;
  const root = await temporary(t, () => client?.close());
  const file = path.join(root, 'consumer.py');
  const target = path.join(root, 'model.py');
  await Promise.all([fs.writeFile(file, source), fs.writeFile(target, model),
    fs.writeFile(path.join(root, 'pyrightconfig.json'), '{"include":["."],"typeCheckingMode":"strict"}')]);
  const launch = await pyrightLaunch({ workspace: root, serverHome: process.env.ROCKETBRAIN_PYRIGHT_TEST_HOME,
    nodePath: process.execPath });
  client = new StdioLsp(launch);
  const rootUri = pathToFileURL(root).href;
  const initialized = await client.request('initialize', { processId: process.pid, rootUri, workspaceFolders: [{ uri: rootUri, name: 'owned types' }],
    capabilities: { workspace: { configuration: true, workspaceFolders: true } } });
  assert.equal(launch.version, '1.1.414');
  assert.ok(initialized.capabilities.completionProvider && initialized.capabilities.renameProvider);
  client.notify('initialized', {});
  const uri = pathToFileURL(file).href;
  const textDocument = { uri };
  client.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'python', version: 1, text: source } });
  const diagnostics = await until(() => client.notifications.find(event => event.method === 'textDocument/publishDiagnostics' &&
    event.params.diagnostics.some(item => item.code === 'reportAssignmentType')), 20000);
  assert.ok(diagnostics.params.diagnostics.some(item => item.code === 'reportAssignmentType' && item.range.start.line === 2));
  const position = positionOf(source, 'compute(row)', 2);
  const hover = await client.request('textDocument/hover', { textDocument, position });
  assert.match(JSON.stringify(hover.contents), /compute.*-> int/u);
  const definition = await client.request('textDocument/definition', { textDocument, position });
  assert.ok(definition.some(location => {
    const file = fileURLToPath(location.uri ?? location.targetUri);
    return path.relative(target, file) === '';
  }));
  const complete = await client.request('textDocument/completion', { textDocument, position: positionOf(source, 'row.ba\n', 6) });
  assert.ok((complete.items ?? complete).some(item => item.label === 'balance'));
  const edit = await client.request('textDocument/rename', { textDocument, position, newName: 'reviewedTotal' });
  assert.ok(reviewedRename(edit, root, 'reviewedTotal'));
  const after = source.replace('wrong: str', 'wrong: int');
  const from = client.notifications.length;
  client.notify('textDocument/didChange', { textDocument: { uri, version: 2 }, contentChanges: [{ text: after }] });
  await until(() => client.notifications.slice(from).some(event => event.method === 'textDocument/publishDiagnostics' &&
    path.relative(file, fileURLToPath(event.params.uri)) === '' && !event.params.diagnostics.some(item => item.code === 'reportAssignmentType')), 20000);
});
