'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { jdbcReadback } = require('./java-source-analysis-host');
const { until } = require('./helpers/stdio-lsp');

async function runJupyterDebugChecks(api, vscode, checks) {
  const type = 'rocketbrain-jupyter';
  const [workspace] = vscode.workspace.workspaceFolders || [];
  const python = vscode.workspace.getConfiguration('rocketbrain.jupyter', workspace?.uri).get('pythonPath') ||
    vscode.workspace.getConfiguration('rocketbrain.python', workspace?.uri).get('path');
  assert.equal(workspace?.uri.scheme, 'file');
  assert.ok(path.isAbsolute(python));
  const commands = new Set(await vscode.commands.getCommands(true));
  for (const name of ['debugCell', 'debugControls']) assert.ok(commands.has('rocketbrain.jupyter.' + name));
  const nonce = randomUUID();
  const file = path.join(workspace.uri.fsPath, 'rb-jupyter-debug-' + nonce + '.ipynb');
  const marker = path.join(workspace.uri.fsPath, 'rb-jupyter-debug-unexpected-' + nonce);
  const uri = vscode.Uri.file(file);
  const metadata = { rocketbrainFixture: { owned: true } };
  const cells = ['seed = 33',
    'value = seed + 2\nnextValue = value * 2\nprint(nextValue)',
    'from pathlib import Path\nPath(' + JSON.stringify(marker) + ').write_text("unexpected")',
    'assert "seed" not in globals()']
    .map((source, index) => ({ id: 'debug-' + index, cell_type: 'code', metadata: {}, source, outputs: [], execution_count: null }));
  await fs.writeFile(file, JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata, cells }) + '\n', { flag: 'wx' });
  const service = api.jupyter;
  let notebook;
  try {
    await vscode.commands.executeCommand('vscode.openWith', uri, type, { preview: false });
    notebook = await until(() => vscode.workspace.notebookDocuments.find(document =>
      document.uri.toString() === uri.toString() && document.notebookType === type), 6000);
    await vscode.window.showNotebookDocument(notebook, { preview: false });
    await vscode.commands.executeCommand('notebook.selectKernel', {
      id: 'rocketbrain-python-kernel', extension: 'rocketbrain-local.rocketbrain'
    });
    const [seed, cell, cancel, clean] = notebook.getCells();
    assert.equal((await service.executeCells([seed], notebook))[0].success, true);
    await assert.rejects(service.debugCell(cell, notebook, 19), /executable Python line/);
    const run = service.debugCell(cell, notebook, 2);
    void run.catch(() => {});
    const pausedAt = line => until(() => {
      const stage = service.debugStatus(notebook);
      return stage.state === 'paused' && stage.line === line && stage;
    }, 18000);
    const first = await pausedAt(2);
    let variables = (await service.debugControl(notebook, 'locals', first.pause)).variables;
    assert.deepEqual(variables.find(value => value.name === 'value'), { name: 'value', value: '35', type: 'int' });
    await service.debugControl(notebook, 'next', first.pause);
    const next = await pausedAt(3);
    assert.equal(next.reason, 'step');
    await assert.rejects(service.debugControl(notebook, 'continue', first.pause), /current paused/);
    variables = (await service.debugControl(notebook, 'locals', next.pause)).variables;
    assert.deepEqual(variables.find(value => value.name === 'nextValue'), { name: 'nextValue', value: '70', type: 'int' });
    await service.debugControl(notebook, 'continue', next.pause);
    assert.equal((await run).success, true);
    assert.equal(await notebook.save(), true);
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.deepEqual(saved.metadata, metadata);
    assert.equal(saved.cells[1].outputs.map(value => value.text).join(''), '70\n');
    const interrupted = service.debugCell(cancel, notebook, 2);
    void interrupted.catch(() => {});
    await pausedAt(2);
    const update = new vscode.WorkspaceEdit();
    update.insert(cancel.document.uri, cancel.document.positionAt(cancel.document.getText().length), '\n# edited while paused');
    assert.equal(await vscode.workspace.applyEdit(update), true);
    assert.equal((await interrupted).cancelled, true);
    assert.deepEqual(service.debugStatus(notebook), { state: 'none' });
    await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
    assert.equal((await service.executeCells([clean], notebook))[0].success, true);
    assert.equal(await notebook.save(), true);
    const versions = execFileSync(python, ['-I', '-c', 'import ipykernel,debugpy; print(ipykernel.__version__,debugpy.__version__)'],
      { encoding: 'utf8', timeout: 15000, windowsHide: true }).trim().split(' ');
    const jdbc = await jdbcReadback();
    checks.push('Debugged an installed notebook cell in the owned ipykernel: exact breakpoint, step, locals, saved outputs and edited-cell cancellation.');
    return { breakpointLine: 2, steppedLine: 3, locals: [35, 70], savedOutputs: true, editedCellRefused: true,
      stalePauseRefused: true, resetOnlyOwnedKernel: true, ipykernel: versions[0], debugpy: versions[1], jdbc };
  } finally {
    if (notebook) await service.stop(notebook);
    const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input?.uri?.toString() === uri.toString());
    if (tabs.length) await vscode.window.tabGroups.close(tabs, true);
    await fs.rm(file, { force: true });
    await fs.rm(marker, { force: true });
  }
}

module.exports = { runJupyterDebugChecks };
