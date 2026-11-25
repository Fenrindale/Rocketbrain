'use strict';

const { offeredTables, prepareLocalSqlRequest, executeLocalSqlRequest } = require('./local-sql-assistant');
const { normalizeLocalChatTarget, cancelled } = require('../ai/local-chat');

const section = 'rocketbrain.localSqlAssistant';

function registerLocalSqlAssistant(context, vscode, database) {
  let epoch = 0, busy = false, active, disposed = false;
  function invalidate() { epoch++; active?.abort(); }
  context.subscriptions.push(database.onDidChangeDatabase(invalidate),
    vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration(section)) invalidate(); }),
    { dispose() { disposed = true; invalidate(); } });

  function capture() {
    if (disposed || !vscode.workspace.isTrusted) throw Error('Trust this workspace before using a local SQL model.');
    const settings = vscode.workspace.getConfiguration(section);
    const target = normalizeLocalChatTarget(settings.get('endpoint'), settings.get('model'));
    const catalog = database.liveCatalogSnapshot();
    return { ...target, catalog, epoch, options: offeredTables(catalog) };
  }

  function check(started) {
    if (disposed || !vscode.workspace.isTrusted || started.epoch !== epoch) {
      throw Error('The database or local model configuration changed. Prepare the request again.');
    }
  }

  async function chooseSchema(options) {
    const selected = await vscode.window.showQuickPick(options.map(item => ({ label: item.name, item })),
      { title: 'Choose Schema Tables for the Local Model', canPickMany: true, ignoreFocusOut: true });
    if (!selected?.length) return null;
    if (selected.length > 6) throw Error('Choose at most six tables.');
    const scopes = [];
    for (const { item } of selected) {
      const columns = await vscode.window.showQuickPick(item.columns, { title: 'Share Column Metadata from ' + item.name,
        canPickMany: true, ignoreFocusOut: true });
      if (!columns?.length) return null;
      scopes.push({ table: item.name, columns });
    }
    return scopes;
  }

  function selectedSql() {
    const editor = vscode.window.activeTextEditor;
    if (editor?.document.languageId !== 'sql') throw Error('Open a SQL editor and choose one SELECT statement to explain.');
    return editor.selection.isEmpty ? editor.document.getText() : editor.document.getText(editor.selection);
  }

  async function openResult(result) {
    const origin = `Configured model ${result.model} at ${result.endpoint}`;
    const scope = `${result.dialect} ${result.schema} · ${result.tables.join(', ')}`;
    if (result.mode === 'draft') {
      const document = await vscode.workspace.openTextDocument({ language: 'sql', content:
        `-- Review this draft before running it.\n-- ${origin}\n-- Schema ${scope}\n${result.sql}\n` });
      await vscode.window.showTextDocument(document, { preview: false });
    }
    const explanation = await vscode.workspace.openTextDocument({ language: 'plaintext', content:
      `Local SQL explanation\n${origin}\n${scope}\nSQL execution · Review only\n\n${result.explanation}\n` });
    await vscode.window.showTextDocument(explanation, { preview: true, viewColumn: vscode.ViewColumn.Beside,
      preserveFocus: result.mode === 'draft' });
  }

  async function ask(mode) {
    if (busy) throw Error('Finish the active local SQL request first.');
    busy = true;
    try {
      const started = capture();
      const input = mode === 'explain' ? selectedSql() : await vscode.window.showInputBox({ title: 'Draft a Read-Only SQL Query',
        prompt: 'Describe the query to send with the selected schema metadata', ignoreFocusOut: true,
        validateInput: value => Buffer.byteLength(value) > 4096 ? 'Keep the request within 4 KiB.' : undefined });
      if (input === undefined) return;
      const selections = await chooseSchema(started.options);
      if (!selections) return;
      check(started);
      const prepared = prepareLocalSqlRequest({ ...started, selections, input, mode });
      const confirmation = await vscode.window.showInformationMessage('Send this request to the configured local SQL model?',
        { modal: true, detail: `${started.model}\n${started.endpoint}\n\n${JSON.stringify(prepared.preview, null, 2)}` }, 'Send to Local Model');
      if (confirmation !== 'Send to Local Model') return;
      check(started);
      const controller = new AbortController();
      active = controller;
      const result = await vscode.window.withProgress({ title: 'Working with the Local SQL Model',
        location: vscode.ProgressLocation.Notification, cancellable: true }, async (_progress, token) => {
        const subscription = token.onCancellationRequested(() => controller.abort());
        if (token.isCancellationRequested) controller.abort();
        try { return await executeLocalSqlRequest(prepared, { signal: controller.signal }); }
        finally { subscription.dispose(); }
      });
      check(started);
      await openResult(result);
      return result;
    } finally { active = undefined; busy = false; }
  }

  function command(id, mode) {
    return vscode.commands.registerCommand('rocketbrain.localSqlAssistant.' + id, async () => {
      try { return await ask(mode); }
      catch (error) {
        if (error.code !== cancelled) await vscode.window.showErrorMessage('Rocketbrain Local SQL: ' + error.message);
      }
    });
  }
  context.subscriptions.push(command('draft', 'draft'), command('explain', 'explain'));

  return { preview({ mode, selections, input }) {
    const started = capture();
    const { preview } = prepareLocalSqlRequest({ ...started, selections, input, mode });
    return { model: started.model, endpoint: started.endpoint, input: preview };
  } };
}

module.exports = { registerLocalSqlAssistant };
