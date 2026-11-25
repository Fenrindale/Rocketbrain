'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { jdbcReadback } = require('./java-source-analysis-host');
const { until } = require('./helpers/stdio-lsp');

async function runJupyterChecks(api, vscode, checks) {
  const type = 'rocketbrain-jupyter';
  const [workspace] = vscode.workspace.workspaceFolders || [];
  assert.equal(workspace?.uri.scheme, 'file');
  const python = vscode.workspace.getConfiguration('rocketbrain.jupyter', workspace.uri).get('pythonPath');
  assert.ok(path.isAbsolute(python));
  const initial = { nbformat: 4, nbformat_minor: 5, metadata: { rocketbrainFixture: { owned: true } }, cells: [
    { id: 'note', cell_type: 'markdown', metadata: {}, source: '# Stored notebook' },
    { id: 'first', cell_type: 'code', metadata: {}, source: 'value = 21\nprint(value)', outputs: [], execution_count: null },
    { id: 'second', cell_type: 'code', metadata: {}, source: 'value * 2', outputs: [], execution_count: null }
  ] };
  const file = path.join(workspace.uri.fsPath, 'rb-jupyter-' + randomUUID() + '.ipynb');
  await fs.writeFile(file, JSON.stringify(initial) + '\n', { flag: 'wx' });
  const uri = vscode.Uri.file(file);
  await vscode.commands.executeCommand('vscode.openWith', uri, type, { preview: false });
  const notebook = await until(() => vscode.workspace.notebookDocuments.find(item =>
    item.uri.toString() === uri.toString() && item.notebookType === type), 6000);
  await vscode.window.showNotebookDocument(notebook, { preview: false });
  await vscode.commands.executeCommand('notebook.selectKernel', {
    id: 'rocketbrain-python-kernel', extension: 'rocketbrain-local.rocketbrain'
  });
  try {
    const [note, first, second] = notebook.getCells();
    const results = await api.jupyter.executeCells([note, first, second], notebook);
    assert.deepEqual(results, [{ success: true, executionCount: 1, cancelled: false },
      { success: true, executionCount: 2, cancelled: false }]);
    assert.equal(first.outputs[0].metadata.rocketbrainJupyter.text, '21\n');
    assert.equal(second.outputs[0].metadata.rocketbrainJupyter.data['text/plain'], '42');
    assert.equal(await notebook.save(), true);
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(saved.cells[1].execution_count, 1);
    assert.equal(saved.cells[2].outputs[0].data['text/plain'], '42');
    assert.deepEqual(saved.metadata, initial.metadata);
    const vendor = execFileSync(python, ['-I', '-c',
      'import nbformat,sys; nbformat.validate(nbformat.read(sys.argv[1],as_version=4)); print(nbformat.__version__)', file],
    { encoding: 'utf8', timeout: 20000, windowsHide: true }).trim();
    assert.match(vendor, /^\d+\.\d+/);
    const jdbc = await jdbcReadback();
    checks.push('The installed VSIX opened and executed Python cells in a real ipykernel, saved results, and passed official nbformat validation.');
    return { executionCounts: [1, 2], persistentPython: true, savedOutputs: true, formatValidatedBy: vendor, jdbc };
  } finally { await api.jupyter.stop(notebook); }
}

module.exports = { runJupyterChecks };
