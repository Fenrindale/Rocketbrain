'use strict';

const { captureResult, decodeNotebook, encodeNotebook, limits, renderResult, sourceDigest } = require('./sql-notebook');
const { validateQuery } = require('./sql-policy');

const notebookType = 'rocketbrain-sql-notebook';
const controllerId = 'rocketbrain-sql-read';
const commands = {
  create:'rocketbrain.sqlNotebook.create',
  pin:'rocketbrain.sqlNotebook.pinResult',
  unpin:'rocketbrain.sqlNotebook.unpinResult'
};
const pinKey = 'rocketbrainPin';

function registerSqlNotebook(vscode, { database }) {
  const batches = new Map(), captures = new WeakMap(), order = new WeakMap();
  const cellKind = vscode.NotebookCellKind;
  const changes = new vscode.EventEmitter();
  const item = (text, mime) => vscode.NotebookCellOutputItem.text(text, mime);

  function display(result) {
    const { html, text } = renderResult(result);
    return new vscode.NotebookCellOutput([item(html, 'text/html'), item(text, 'text/plain')]);
  }

  function record(kind, language, source, metadata) {
    const markup = kind === cellKind.Markup && language === 'markdown';
    const sql = kind === cellKind.Code && language === 'sql';
    if (!sql && !markup) throw Error('Use SQL code cells or Markdown cells in a Rocketbrain SQL notebook.');
    return { type:markup ? 'markdown' : 'sql', source, result:metadata?.[pinKey] };
  }

  const serializer = vscode.workspace.registerNotebookSerializer(notebookType, {
    deserializeNotebook(bytes) {
      return new vscode.NotebookData(decodeNotebook(bytes).map(({ type, source, result }) => {
        const cell = new vscode.NotebookCellData(type === 'sql' ? cellKind.Code : cellKind.Markup, source, type);
        if (result) {
          cell.metadata = { [pinKey]:result };
          cell.outputs = [display(result)];
        }
        return cell;
      }));
    },
    serializeNotebook(data) {
      return encodeNotebook(data.cells.map(cell => record(cell.kind, cell.languageId, cell.value, cell.metadata)));
    }
  }, { transientOutputs:true });

  const controller = vscode.notebooks.createNotebookController(controllerId, notebookType, 'Rocketbrain SQL');
  controller.description = 'Active MySQL or MariaDB connection · read only';
  controller.supportedLanguages = ['sql'];
  controller.supportsExecutionOrder = true;

  function selectedCell(argument) {
    let cell = argument?.cell ?? argument;
    if (!cell?.document) {
      const editor = vscode.window.activeNotebookEditor;
      if (editor && editor.selection.start < editor.notebook.cellCount) cell = editor.notebook.cellAt(editor.selection.start);
    }
    if (cell?.notebook?.notebookType !== notebookType || cell.document.isClosed || cell.kind !== cellKind.Code ||
        cell.document.languageId !== 'sql' || cell.index < 0) throw Error('Select a SQL notebook cell.');
    return cell;
  }

  async function changePin(argument, keep) {
    const cell = selectedCell(argument), notebook = cell.notebook;
    if (batches.has(notebook)) throw Error('Finish running this notebook before updating its saved result.');
    const current = captures.get(cell), previous = cell.metadata[pinKey];
    if (keep && (!current || current.sourceDigest !== sourceDigest(cell.document.getText()))) {
      throw Error('Run the current SQL cell before saving its result.');
    }
    if (!keep && !previous) return false;
    const metadata = { ...cell.metadata };
    if (keep) metadata[pinKey] = current;
    else delete metadata[pinKey];
    encodeNotebook(notebook.getCells().map(entry =>
      record(entry.kind, entry.document.languageId, entry.document.getText(), entry === cell ? metadata : entry.metadata)));
    const edit = new vscode.WorkspaceEdit();
    edit.set(notebook.uri, [vscode.NotebookEdit.updateCellMetadata(cell.index, metadata)]);
    if (!await vscode.workspace.applyEdit(edit)) throw Error('The SQL notebook changed. Update its saved result again.');
    changes.fire();
    return true;
  }

  async function create() {
    const cell = new vscode.NotebookCellData(cellKind.Code, 'SELECT VERSION() AS server_version;', 'sql');
    const doc = await vscode.workspace.openNotebookDocument(notebookType, new vscode.NotebookData([cell]));
    await vscode.window.showNotebookDocument(doc, { preview:false });
    return doc;
  }

  async function execute(cells, notebook) {
    if (batches.has(notebook)) throw Error('Finish or cancel the running notebook cells first.');
    if (notebook.notebookType !== notebookType || notebook.isClosed) throw Error('Open a Rocketbrain SQL notebook.');
    const work = [...new Set(cells)].filter(cell => cell.notebook === notebook && cell.kind === cellKind.Code)
      .sort((a, b) => a.index - b.index)
      .map(cell => ({ cell, version:cell.document.version, source:cell.document.getText() }));
    if (work.length > limits.cells) throw Error('Run at most 64 SQL notebook cells at a time.');
    const connectionEpoch = database.savedQueryTarget().connectionEpoch;
    const batch = new AbortController();
    batches.set(notebook, batch);
    try {
      for (const { cell, version, source } of work) {
        if (batch.signal.aborted || cell.index < 0 || cell.document.isClosed) break;
        const execution = controller.createNotebookCellExecution(cell);
        execution.start(Date.now());
        execution.executionOrder = (order.get(notebook) ?? 0) + 1;
        order.set(notebook, execution.executionOrder);
        const cancellation = execution.token.onCancellationRequested(() => batch.abort());
        let succeeded = false;
        captures.delete(cell);
        try {
          await execution.clearOutput();
          if (execution.token.isCancellationRequested) batch.abort();
          const assertSource = () => {
            if (notebook.isClosed || cell.index < 0 || cell.document.isClosed ||
                cell.document.version !== version || cell.document.languageId !== 'sql') {
              throw Error('The SQL cell changed after execution was requested. Run it again.');
            }
          };
          assertSource();
          validateQuery(source, { readOnly:true });
          const result = await database.querySqlNotebook(source, { connectionEpoch, signal:batch.signal, assertSource });
          const captured = captureResult(result, source);
          await execution.replaceOutput([display(captured)]);
          captures.set(cell, captured);
          succeeded = true;
        } catch (error) {
          if (!notebook.isClosed && !cell.document.isClosed) {
            await execution.replaceOutput([new vscode.NotebookCellOutput([
              item(batch.signal.aborted ? 'SQL notebook execution was cancelled.' : error.message, 'text/plain')
            ])]);
          }
        } finally {
          cancellation.dispose();
          execution.end(succeeded, Date.now());
          changes.fire();
        }
        if (!succeeded) break;
      }
    } finally { batches.delete(notebook); }
  }

  controller.executeHandler = async (cells, notebook) => {
    try { await execute(cells, notebook); }
    catch (error) { void vscode.window.showErrorMessage(error.message); }
  };

  const status = vscode.notebooks.registerNotebookCellStatusBarItemProvider(notebookType, {
    onDidChangeCellStatusBarItems:changes.event,
    provideCellStatusBarItems(cell) {
      const pin = cell.metadata[pinKey], live = captures.get(cell);
      if (!pin && !live) return;
      const digest = sourceDigest(cell.document.getText());
      const text = pin ? pin.sourceDigest === digest ? '$(pinned) Result saved in notebook'
        : '$(warning) Saved result belongs to earlier SQL' : '$(pin) Save result in notebook';
      const value = new vscode.NotebookCellStatusBarItem(text, vscode.NotebookCellStatusBarAlignment.Left);
      if (!pin && live.sourceDigest === digest) value.command = {
        title:'Pin SQL Notebook Result', command:commands.pin, arguments:[cell]
      };
      value.tooltip = 'Saving a result includes the displayed data when you save or share the notebook.';
      return value;
    }
  });

  const close = vscode.workspace.onDidCloseNotebookDocument(notebook => batches.get(notebook)?.abort());
  const edited = vscode.workspace.onDidChangeTextDocument(event => {
    if (event.document.uri.scheme === 'vscode-notebook-cell') changes.fire();
  });
  const registered = [
    vscode.commands.registerCommand(commands.create, create),
    vscode.commands.registerCommand(commands.pin, cell => changePin(cell, true)),
    vscode.commands.registerCommand(commands.unpin, cell => changePin(cell, false))
  ];
  return {
    create, pinResult:cell => changePin(cell, true), unpinResult:cell => changePin(cell, false),
    dispose() {
      for (const batch of batches.values()) batch.abort();
      for (const resource of [close, edited, status, changes, controller, serializer, ...registered]) resource.dispose();
    }
  };
}

module.exports = { registerSqlNotebook, notebookType, controllerId };
