'use strict';

const { createSqliteCellEditor } = require('./sqlite-cell-editor');

const scheme = 'rocketbrain-sqlite-edit';
const label = value => String(value).replace(/[\x00-\x1f\x7f]/gu, ' ');
const descriptions = { INTEGER: 'Signed 64-bit decimal', REAL: 'Finite floating-point value', TEXT: 'Unicode text', BLOB: 'Hexadecimal byte pairs' };
const exactValue = cell => cell.kind + (cell.kind === 'NULL' ? '' : ' ' + JSON.stringify(cell.value));

function renderCellReview(review, runtime) {
  return ['-- SQLite Cell Edit Review', '-- File ' + label(review.fileName), '-- File identity SHA-256 ' + review.fileIdentity,
    '-- Schema SHA-256 ' + review.schemaFingerprint, '-- Row SHA-256 ' + review.rowFingerprint, '-- Runtime ' + runtime.node + ' · SQLite ' + runtime.sqlite,
    '-- Key ' + review.keyColumn + ' = ' + review.key, '-- Column ' + review.column, '-- Before ' + exactValue(review.previous),
    '-- After ' + exactValue(review.replacement), '', review.sql + ';', '', '-- SQLite applies one typed replacement in an immediate transaction.'].join('\n');
}

function registerSqliteCellEditor(context, vscode, { fileApi, currentSnapshot }) {
  const editor = createSqliteCellEditor({ isTrusted: () => vscode.workspace.isTrusted, currentSnapshot });
  const documents = new Map();
  const activeRuntime = () => void vscode.commands.executeCommand('setContext', 'rocketbrain.sqliteEditRuntime', Boolean(editor.runtime()));
  void vscode.commands.executeCommand('setContext', 'rocketbrain.sqliteEditPlatform', editor.platformSupported());

  function progress(title, action) {
    return vscode.window.withProgress({ title, location: vscode.ProgressLocation.Notification, cancellable: true }, async (_, token) => {
      const controller = new AbortController();
      const cancel = token.onCancellationRequested(() => controller.abort());
      if (token.isCancellationRequested) controller.abort();
      try { return await action({ signal: controller.signal }); }
      finally { cancel.dispose(); }
    });
  }

  async function reviewDocument(draftId, name, value) {
    const review = editor.review(draftId, name, value);
    const uri = vscode.Uri.parse(scheme + ':/' + review.id + '/cell-review.sqlite.sql');
    const text = renderCellReview(review, editor.runtime());
    while (documents.size >= 4) {
      const oldest = documents.keys().next().value;
      editor.discard(documents.get(oldest).review.id);
      documents.delete(oldest);
    }
    documents.set(uri.toString(), { review, text });
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document, { preview: false, viewColumn: vscode.ViewColumn.Beside });
      return { ...review, reviewUri: uri.toString() };
    } catch (error) {
      documents.delete(uri.toString());
      editor.discard(review.id);
      throw error;
    }
  }

  const command = (name, action) => context.subscriptions.push(vscode.commands.registerCommand('rocketbrain.sqlite.' + name, async () => {
    try { return await action(); }
    catch (error) {
      if (error.code !== 'ROCKETBRAIN_SQLITE_EDIT_CANCELED') await vscode.window.showErrorMessage('Rocketbrain SQLite: ' + error.message);
    } finally { activeRuntime(); }
  }));

  context.subscriptions.push(editor, vscode.workspace.registerTextDocumentContentProvider(scheme, {
    provideTextDocumentContent(uri) {
      if (!vscode.workspace.isTrusted) return '-- Trust the workspace before viewing the SQLite cell edit.';
      return documents.get(uri.toString())?.text ?? '-- This SQLite cell review expired.';
    }
  }));
  command('chooseEditRuntime', async () => {
    if (!vscode.workspace.isTrusted || !editor.platformSupported()) throw Error('SQLite edit runtime selection requires a trusted Windows x64 workspace.');
    const [choice] = await vscode.window.showOpenDialog({ title: 'Choose Official Windows x64 Node.js 22.23.5',
      openLabel: 'Verify Runtime', filters: { Executable: ['exe'] } }) || [];
    if (!choice) return;
    if (choice.scheme !== 'file' || choice.authority) throw Error('Choose a local official Node.js executable.');
    const runtime = await progress('Verifying Pinned Node.js Runtime', options => editor.selectRuntime(choice.fsPath, options));
    documents.clear();
    await vscode.window.showInformationMessage('SQLite cell editing will use verified Node.js ' + runtime.node + '.');
    return runtime;
  });
  command('reviewCellEdit', async () => {
    const { session } = currentSnapshot();
    if (!editor.runtime()) throw Error('Choose the pinned SQLite edit runtime first.');
    const catalog = await progress('Reading SQLite Snapshot Catalog', fileApi.catalog);
    const table = await vscode.window.showQuickPick(catalog.objects.filter(item => item.kind === 'table')
      .map(item => ({ label: label(item.name), name: item.name })), { title: 'Select an Ordinary SQLite Table' });
    if (!table) return;
    const key = await vscode.window.showInputBox({ title: 'SQLite INTEGER Primary Key', prompt: 'Enter the exact signed 64-bit row key in decimal' });
    if (key === undefined) return;
    if (currentSnapshot().session !== session) throw Error('The selected SQLite snapshot changed. Choose the row again.');
    const row = await progress('Inspecting the Selected SQLite Row', options => editor.inspect({ table: table.name, key }, options));
    try {
      const column = await vscode.window.showQuickPick(row.columns.flatMap((item, index) => item.editable ?
        [{ label: item.name, description: item.type, detail: exactValue(row.cells[index]).slice(0, 180), item }] : []),
      { title: 'Choose One SQLite Cell' });
      if (!column) return;
      const kinds = column.item.type === 'ANY' ? Object.keys(descriptions) : [column.item.type];
      if (column.item.nullable) kinds.push('NULL');
      const kind = await vscode.window.showQuickPick(kinds, { title: 'SQLite Replacement Storage Type' });
      if (!kind) return;
      let value = null;
      if (kind !== 'NULL') {
        value = await vscode.window.showInputBox({ title: 'SQLite ' + kind + ' Replacement', prompt: descriptions[kind] });
        if (value === undefined) return;
      }
      return reviewDocument(row.id, column.item.name, { kind, value });
    } finally { editor.discard(row.id); }
  });
  command('applyCellEdit', async () => {
    const document = vscode.window.activeTextEditor?.document, key = document?.uri.toString();
    const review = documents.get(key);
    const current = () => review && documents.get(key) === review && !document.isClosed && document.getText() === review.text &&
      review.review.expiresAt > Date.now();
    if (!current()) throw Error('Open a current SQLite cell review first.');
    const selection = await vscode.window.showWarningMessage('Apply this one reviewed cell change to the local SQLite file?',
      { modal: true, detail: label(review.review.fileName) + ' · ' + review.review.table + ' · ' + review.review.keyColumn + '=' + review.review.key },
      'Apply Reviewed Cell Edit');
    if (selection !== 'Apply Reviewed Cell Edit') return;
    if (!current()) throw Error('The exact SQLite review changed during confirmation. Review the row again.');
    documents.delete(key);
    const result = await progress('Applying Reviewed SQLite Cell', options => editor.apply(review.review.id, true, options));
    await vscode.window.showInformationMessage('SQLite confirmed one changed cell. Refresh the read-only snapshot to see the committed value.' +
      (result.temporaryRuntimeCleanupPending ? ' The temporary runtime could not be removed.' : ''));
    return result;
  });

  return { selectRuntime: (file, options) => editor.selectRuntime(file, options).then(result => { activeRuntime(); return result; }),
    inspect: editor.inspect, review: reviewDocument, apply: editor.apply, discard: editor.discard };
}

module.exports = { registerSqliteCellEditor, renderCellReview };
