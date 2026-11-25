'use strict';

const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { workspacePath, workspaceRoots } = require('../java/workbench-model');
const { openJupyterKernel } = require('./jupyter-kernel');
const { marker, decodeNotebook, encodeNotebook, outputItem } = require('./jupyter-format');

const type = 'rocketbrain-jupyter';

function registerJupyter(vscode) {
  const sessions = new Map();
  const active = new Map();
  const subscriptions = [];
  let disposed = false;
  const output = vscode.window.createOutputChannel('Rocketbrain Jupyter');
  subscriptions.push(output);

  function checkLocal(notebook) {
    if (disposed || !vscode.workspace.isTrusted || notebook?.notebookType !== type) {
      throw Error('Run Python cells from the Rocketbrain notebook editor in a trusted workspace.');
    }
    const uri = notebook.uri;
    const folder = uri.scheme === 'untitled' ? vscode.workspace.workspaceFolders?.[0] : vscode.workspace.getWorkspaceFolder(uri);
    if (folder?.uri.scheme !== 'file') throw Error('Open a local workspace to start a notebook kernel.');
    const roots = workspaceRoots([folder]);
    const directory = uri.scheme === 'untitled' ? roots[0] : path.dirname(workspacePath(uri.toString(), roots, { directory: false }));
    const python = vscode.workspace.getConfiguration('rocketbrain.jupyter', folder.uri).get('pythonPath');
    return { python, directory };
  }

  async function stop(notebook) {
    const key = notebook.uri.toString();
    active.get(key)?.abort();
    const owned = sessions.get(key);
    if (!owned) return;
    try { await owned.kernel.close(); }
    finally { if (sessions.get(key) === owned) sessions.delete(key); }
  }

  async function getKernel(notebook, settings) {
    const key = notebook.uri.toString();
    let session = sessions.get(key);
    if (session && (session.python !== settings.python || session.directory !== settings.directory || session.kernel.stopped)) {
      await session.kernel.close();
      sessions.delete(key);
      session = undefined;
    }
    if (session) return session.kernel;
    if (sessions.size >= 4) throw Error('Close other notebooks before starting another Python kernel.');
    const kernel = openJupyterKernel(settings);
    sessions.set(key, { ...settings, kernel });
    try { await kernel.ready; }
    catch (error) {
      await kernel.close();
      if (sessions.get(key)?.kernel === kernel) sessions.delete(key);
      throw error;
    }
    return kernel;
  }

  subscriptions.push(vscode.workspace.registerNotebookSerializer(type, {
    deserializeNotebook: bytes => decodeNotebook(vscode, bytes),
    serializeNotebook: data => encodeNotebook(vscode, data)
  }, { transientOutputs: false }));
  const controller = vscode.notebooks.createNotebookController('rocketbrain-python-kernel', type, 'Rocketbrain Python');
  controller.supportedLanguages = ['python'];
  controller.supportsExecutionOrder = true;
  subscriptions.push(controller);

  async function executeCells(cells, notebook) {
    const settings = checkLocal(notebook);
    const key = notebook.uri.toString();
    if (active.has(key)) throw Error('Wait for the current notebook execution.');
    const interrupted = new AbortController();
    active.set(key, interrupted);
    const results = [];
    try {
      for (const cell of cells) {
        if (interrupted.signal.aborted) break;
        if (cell.kind !== vscode.NotebookCellKind.Code || cell.document.languageId !== 'python' ||
            cell.metadata?.[marker]?.cell_type === 'raw') continue;
        checkLocal(notebook);
        const execution = controller.createNotebookCellExecution(cell);
        const cancellation = execution.token.onCancellationRequested(() => interrupted.abort());
        execution.start(Date.now());
        let success = false;
        try {
          const kernel = await getKernel(notebook, settings);
          const result = await kernel.execute(cell.document.getText(), { cancellation: interrupted.signal });
          const values = result.outputs.slice();
          if (result.kernelStopped) values.push({ output_type: 'stream', name: 'stderr',
            text: 'The kernel was reset to stop the cell. Run setup cells again to restore state.\n' });
          if (result.truncated) values.push({ output_type: 'stream', name: 'stderr', text: 'Cell output reached the Rocketbrain display limit.\n' });
          if (Number.isSafeInteger(result.executionCount)) execution.executionOrder = result.executionCount;
          await execution.replaceOutput(values.map(value => outputItem(vscode, value)));
          success = result.success;
          results.push({ success, executionCount: result.executionCount, cancelled: result.cancelled });
        } catch (error) {
          await execution.replaceOutput([outputItem(vscode, { output_type: 'error', ename: 'Rocketbrain Jupyter',
            evalue: error.message, traceback: [] })]);
          results.push({ success: false, cancelled: interrupted.signal.aborted });
        } finally {
          execution.end(success, Date.now());
          cancellation.dispose();
        }
      }
    } finally {
      if (active.get(key) === interrupted) active.delete(key);
    }
    return results;
  }

  controller.executeHandler = (cells, notebook) => executeCells(cells, notebook).catch(error => {
    output.appendLine(error.message);
    void vscode.window.showErrorMessage(error.message);
  });
  controller.interruptHandler = notebook => active.get(notebook.uri.toString())?.abort();
  subscriptions.push(vscode.workspace.onDidCloseNotebookDocument(notebook => {
    if (notebook.notebookType === type) void stop(notebook).catch(error => output.appendLine(error.message));
  }));
  subscriptions.push(vscode.workspace.onDidChangeNotebookDocument(event => {
    if (event.notebook.notebookType !== type || !event.contentChanges.length) return;
    const additions = event.contentChanges.flatMap(change => change.addedCells);
    const updates = additions.filter(cell => !cell.metadata?.[marker]?.id).map(cell =>
      vscode.NotebookEdit.updateCellMetadata(cell.index, { ...cell.metadata, [marker]: { ...cell.metadata?.[marker], id: randomUUID() } }));
    if (updates.length) {
      const edit = new vscode.WorkspaceEdit();
      edit.set(event.notebook.uri, updates);
      void vscode.workspace.applyEdit(edit).then(undefined, error => output.appendLine(error.message));
    }
  }));

  subscriptions.push(vscode.commands.registerCommand('rocketbrain.jupyter.create', async () => {
    const cell = new vscode.NotebookCellData(vscode.NotebookCellKind.Code, '', 'python');
    cell.metadata = { [marker]: { id: randomUUID() } };
    const notebook = await vscode.workspace.openNotebookDocument(type, new vscode.NotebookData([cell]));
    await vscode.window.showNotebookDocument(notebook);
    return notebook.uri;
  }));
  subscriptions.push(vscode.commands.registerCommand('rocketbrain.jupyter.reset', async () => {
    const notebook = vscode.window.activeNotebookEditor?.notebook;
    if (notebook?.notebookType === type) await stop(notebook);
  }));

  return { executeCells, stop, async dispose() {
    disposed = true;
    for (const interrupt of active.values()) interrupt.abort();
    await Promise.allSettled([...sessions.values()].map(({ kernel }) => kernel.close()));
    sessions.clear();
    subscriptions.forEach(item => item.dispose());
  } };
}

module.exports = { registerJupyter, type };
