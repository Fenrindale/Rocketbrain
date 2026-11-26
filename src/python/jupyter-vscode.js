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
  const debugging = new Map();
  const subscriptions = [];
  let disposed = false;
  const output = vscode.window.createOutputChannel('Rocketbrain Jupyter');
  const debuggerStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
  debuggerStatus.command = 'rocketbrain.jupyter.debugControls';
  subscriptions.push(output, debuggerStatus);

  function paintDebuggerStatus() {
    const key = vscode.window.activeNotebookEditor?.notebook.uri.toString();
    const stage = debugging.get(key)?.stage;
    if (!stage) return debuggerStatus.hide();
    debuggerStatus.text = stage.state === 'paused'
      ? '$(debug-pause) Python notebook · line ' + stage.line
      : '$(debug-alt) Python notebook';
    debuggerStatus.tooltip = 'Notebook debugger controls';
    debuggerStatus.show();
  }

  function pythonCell(cell) {
    return cell?.kind === vscode.NotebookCellKind.Code && cell.document.languageId === 'python' &&
      cell.metadata?.[marker]?.cell_type !== 'raw';
  }

  function currentDebugCell(item) {
    const cell = item.cell;
    return !item.notebook.isClosed && !cell.document.isClosed && item.notebook.getCells().some(entry => entry.document === cell.document) &&
      cell.document.version === item.version && cell.document.getText() === item.code;
  }

  function checkDebugCell(item) {
    checkLocal(item.notebook);
    if (!currentDebugCell(item)) {
      active.get(item.notebook.uri.toString())?.abort();
      throw Error('The debugged Python cell changed. Set a breakpoint on its latest source.');
    }
  }

  function checkLocal(notebook) {
    if (disposed || !vscode.workspace.isTrusted || notebook?.notebookType !== type) {
      throw Error('Run Python cells from the Rocketbrain notebook editor in a trusted workspace.');
    }
    const uri = notebook.uri;
    const folder = uri.scheme === 'untitled' ? vscode.workspace.workspaceFolders?.[0] : vscode.workspace.getWorkspaceFolder(uri);
    if (folder?.uri.scheme !== 'file') throw Error('Open a local workspace to start a notebook kernel.');
    const roots = workspaceRoots([folder]);
    const directory = uri.scheme === 'untitled' ? roots[0] : path.dirname(workspacePath(uri.toString(), roots, { directory: false }));
    const python = vscode.workspace.getConfiguration('rocketbrain.jupyter', folder.uri).get('pythonPath') ||
      vscode.workspace.getConfiguration('rocketbrain.python', folder.uri).get('path');
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

  async function executeCells(cells, notebook, debug) {
    const settings = checkLocal(notebook);
    const key = notebook.uri.toString();
    if (active.has(key)) throw Error('Wait for the current notebook execution.');
    const interrupted = new AbortController();
    active.set(key, interrupted);
    const results = [];
    try {
      for (const cell of cells) {
        if (interrupted.signal.aborted) break;
        if (!pythonCell(cell)) continue;
        checkLocal(notebook);
        const execution = controller.createNotebookCellExecution(cell);
        const cancellation = execution.token.onCancellationRequested(() => interrupted.abort());
        execution.start(Date.now());
        let success = false;
        try {
          const kernel = await getKernel(notebook, settings);
          let result;
          if (debug) {
            checkDebugCell(debug);
            debug.kernel = kernel;
            debug.stage = { state: 'running' };
            paintDebuggerStatus();
            result = await kernel.debug(debug.code, debug.line, { cancellation: interrupted.signal, onDebug(stage) {
              try { checkDebugCell(debug); } catch { interrupted.abort(); return; }
              debug.stage = stage;
              paintDebuggerStatus();
              const editor = vscode.window.activeNotebookEditor;
              if (editor?.notebook === notebook) editor.revealRange(new vscode.NotebookRange(cell.index, cell.index + 1),
                vscode.NotebookEditorRevealType.InCenterIfOutsideViewport);
            } });
          } else result = await kernel.execute(cell.document.getText(), { cancellation: interrupted.signal });
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

  async function debugCell(cell, notebook, line) {
    checkLocal(notebook);
    if (!pythonCell(cell) || !notebook.getCells().some(entry => entry.document === cell.document)) {
      throw Error('Select a Python code cell in this notebook.');
    }
    const code = cell.document.getText();
    if (!Number.isSafeInteger(line) || line < 1 || line > cell.document.lineCount ||
        !cell.document.lineAt(line - 1).text.trim().replace(/^#.*$/u, '')) {
      throw Error('Choose an executable Python line in this cell.');
    }
    const key = notebook.uri.toString();
    if (active.has(key) || debugging.has(key)) throw Error('Wait for the current notebook execution.');
    const item = { cell, notebook, line, code, version: cell.document.version, stage: { state: 'starting' } };
    debugging.set(key, item);
    paintDebuggerStatus();
    try { return (await executeCells([cell], notebook, item))[0]; }
    finally {
      if (debugging.get(key) === item) debugging.delete(key);
      paintDebuggerStatus();
    }
  }

  function debugStatus(notebook) {
    const stage = debugging.get(notebook?.uri.toString())?.stage;
    return stage ? { ...stage } : { state: 'none' };
  }

  async function debugControl(notebook, action, pause) {
    checkLocal(notebook);
    const key = notebook.uri.toString();
    const item = debugging.get(key);
    if (!item) throw Error('Start a Python notebook debug session first.');
    if (action === 'stop') {
      await stop(notebook);
      return { state: 'stopped' };
    }
    checkDebugCell(item);
    const stage = item.stage;
    if (stage.state !== 'paused' || stage.pause !== pause) throw Error('Select the current paused Python notebook cell.');
    const result = await item.kernel.debugControl(action, pause);
    checkDebugCell(item);
    if (debugging.get(key) !== item && result.state !== 'running') throw Error('The notebook debug session ended.');
    if (debugging.get(key) === item && item.stage === stage && result.state === 'running') {
      item.stage = result;
      paintDebuggerStatus();
    }
    return result;
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
    const key = event.notebook.uri.toString();
    const item = debugging.get(key);
    if (item && !currentDebugCell(item)) active.get(key)?.abort();
    const additions = event.contentChanges.flatMap(change => change.addedCells);
    const updates = additions.filter(cell => !cell.metadata?.[marker]?.id).map(cell =>
      vscode.NotebookEdit.updateCellMetadata(cell.index, { ...cell.metadata, [marker]: { ...cell.metadata?.[marker], id: randomUUID() } }));
    if (updates.length) {
      const edit = new vscode.WorkspaceEdit();
      edit.set(event.notebook.uri, updates);
      void vscode.workspace.applyEdit(edit).then(undefined, error => output.appendLine(error.message));
    }
  }));
  subscriptions.push(vscode.window.onDidChangeActiveNotebookEditor(paintDebuggerStatus),
    vscode.workspace.onDidChangeTextDocument(({ document }) => {
      for (const [key, item] of debugging) {
        if (item.cell.document === document && !currentDebugCell(item)) active.get(key)?.abort();
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
  const command = (name, action) => vscode.commands.registerCommand('rocketbrain.jupyter.' + name, async (...args) => {
    try { return await action(...args); } catch (error) {
      output.appendLine(error.message);
      void vscode.window.showErrorMessage(error.message);
    }
  });
  subscriptions.push(command('debugCell', async supplied => {
    const editor = vscode.window.activeNotebookEditor;
    if (!editor || editor.notebook.notebookType !== type) throw Error('Open a Rocketbrain Python notebook.');
    const suppliedCell = supplied?.document && supplied.notebook === editor.notebook ? supplied : undefined;
    const cell = suppliedCell || (editor.notebook.cellCount ? editor.notebook.cellAt(editor.selection.start) : undefined);
    if (!pythonCell(cell)) throw Error('Select a Python code cell in this notebook.');
    const current = vscode.window.activeTextEditor;
    const initial = current?.document === cell.document ? current.selection.active.line + 1 : 1;
    const version = cell.document.version;
    const choice = await vscode.window.showInputBox({
      title: 'Python Cell Breakpoint', prompt: 'Choose a line in the selected cell.', value: String(initial),
      validateInput: value => /^[1-9][0-9]*$/u.test(value) && Number(value) <= cell.document.lineCount
        ? undefined : 'Enter a line from 1 to ' + cell.document.lineCount + '.'
    });
    if (!choice) return;
    if (cell.document.version !== version) throw Error('The Python cell changed. Review its breakpoint again.');
    return debugCell(cell, editor.notebook, Number(choice));
  }), command('debugControls', async () => {
    const notebook = vscode.window.activeNotebookEditor?.notebook;
    const stage = debugStatus(notebook);
    if (stage.state === 'none') throw Error('Start a Python notebook debug session first.');
    const commands = [{ label: 'Stop and Reset Notebook Kernel', action: 'stop' }];
    if (stage.state === 'paused') commands.unshift(
      { label: 'Inspect Local Variables', action: 'locals' }, { label: 'Step Over', action: 'next' },
      { label: 'Continue Cell', action: 'continue' });
    const selected = await vscode.window.showQuickPick(commands, { title: stage.state === 'paused'
      ? 'Python Notebook Debugger · Line ' + stage.line : 'Python Notebook Debugger' });
    if (!selected || vscode.window.activeNotebookEditor?.notebook !== notebook) return;
    const reply = await debugControl(notebook, selected.action, stage.pause);
    if (selected.action === 'locals') {
      const variables = reply.variables.map(variable => ({ label: variable.name, description: variable.type,
        detail: variable.value.replace(/[\u0000-\u001f\u007f]/gu, ' ') }));
      await vscode.window.showQuickPick(variables.length ? variables : [{ label: 'No visible local variables' }],
        { title: 'Python Local Variables · Line ' + stage.line, matchOnDescription: true });
    }
  }));

  return { executeCells: (cells, notebook) => executeCells(cells, notebook), debugCell, debugStatus, debugControl, stop, async dispose() {
    disposed = true;
    for (const interrupt of active.values()) interrupt.abort();
    await Promise.allSettled([...sessions.values()].map(({ kernel }) => kernel.close()));
    sessions.clear();
    debugging.clear();
    subscriptions.forEach(item => item.dispose());
  } };
}

module.exports = { registerJupyter, type };
