'use strict';

const path = require('node:path');
const { openDuckDb } = require('./duckdb-cli');

const keywords = ['ASOF JOIN', 'EXCLUDE', 'FROM', 'GROUP BY ALL', 'LIMIT', 'ORDER BY ALL', 'PIVOT', 'QUALIFY',
  'REPLACE', 'SAMPLE', 'SELECT', 'SUMMARIZE', 'UNION BY NAME', 'UNPIVOT', 'WINDOW', 'WITH'];
const coreFunctions = ['approx_count_distinct', 'array_agg', 'date_diff', 'date_part', 'date_trunc', 'generate_series',
  'histogram', 'json_extract', 'list_extract', 'quantile_cont', 'range', 'regexp_extract', 'struct_pack', 'time_bucket'];
const language = 'duckdb-sql';
const text = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;',
  '"': '&quot;', "'": '&#39;' }[character]));

function table(headings, rows) {
  return `<table><thead><tr>${headings.map(heading => `<th scope="col">${text(heading.name ?? heading)}${heading.type ?
    `<small>${text(heading.type)}</small>` : ''}</th>`).join('')}</tr></thead><tbody>${rows.map(row =>
    `<tr>${row.map(cell => cell === null ? '<td class="null">NULL</td>' : `<td>${text(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

function render(title, status, headings, rows) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${text(title)}</title>
<style>body{margin:0;padding:16px;color:var(--vscode-foreground);background:var(--vscode-editor-background);font-family:var(--vscode-font-family)}
h1{font-size:1.2rem;margin:0 0 8px}p{color:var(--vscode-descriptionForeground);margin:0 0 14px}
.rows{overflow:auto}table{border-collapse:collapse;min-width:70%;font-family:var(--vscode-editor-font-family);font-size:var(--vscode-editor-font-size)}
th,td{text-align:left;padding:7px 12px;border:1px solid var(--vscode-panel-border);vertical-align:top;white-space:pre-wrap;min-width:5ch;max-width:75ch;overflow-wrap:anywhere}
th{background:var(--vscode-editorWidget-background)}tr:nth-child(even) td{background:var(--vscode-list-hoverBackground)}
small{display:block;color:var(--vscode-descriptionForeground);font-weight:normal}.null{color:var(--vscode-descriptionForeground);font-style:italic}</style>
</head><body><h1>${text(title)}</h1><p role="status">${text(status)}</p><div class="rows">${table(headings, rows)}</div></body></html>`;
}

function registerDuckDb(context, vscode) {
  let selected, generation = 0, panel;
  let extensionChange = false;
  const operations = new Set();
  const command = (id, action) => context.subscriptions.push(vscode.commands.registerCommand('rocketbrain.duckdb.' + id, async (...args) => {
    try { return await action(...args); }
    catch (error) {
      if (error.code !== 'ROCKETBRAIN_DUCKDB_CANCELLED') await vscode.window.showErrorMessage('Rocketbrain DuckDB: ' + error.message);
    }
  }));
  const trusted = () => {
    if (!vscode.workspace.isTrusted) throw Error('Trust the workspace before opening local DuckDB data.');
  };

  function abortable(signal) {
    const controller = new AbortController();
    const stop = () => controller.abort();
    if (signal?.aborted) stop();
    signal?.addEventListener('abort', stop, { once: true });
    operations.add(controller);
    return { controller, release() { operations.delete(controller); signal?.removeEventListener('abort', stop); } };
  }

  function close() {
    generation++;
    for (const controller of operations) controller.abort();
    selected = undefined;
    panel?.dispose();
    void vscode.commands.executeCommand('setContext', 'rocketbrain.duckdbConnected', false);
  }

  async function open(client, database, options = {}) {
    trusted();
    close();
    const expected = generation;
    const op = abortable(options.signal);
    try {
      const extensionDirectory = context.storageUri?.scheme === 'file' ?
        path.join(context.storageUri.fsPath, 'duckdb') : undefined;
      const result = await openDuckDb(client, database, { signal: op.controller.signal, extensionDirectory });
      trusted();
      if (generation !== expected || op.controller.signal.aborted) throw Error('The selected DuckDB file changed. Choose it again.');
      selected = result;
      void vscode.commands.executeCommand('setContext', 'rocketbrain.duckdbConnected', true);
      return { ...selected.source };
    } finally { op.release(); }
  }

  async function use(method, args, options = {}) {
    trusted();
    const database = selected;
    if (!database) throw Error('Open a DuckDB database file first.');
    if (extensionChange || method === 'manageExtension' && operations.size) {
      throw Error('Wait for the active DuckDB operation to finish.');
    }
    if (operations.size >= 2) throw Error('Wait for the active DuckDB operations to finish.');
    const op = abortable(options.signal);
    if (method === 'manageExtension') extensionChange = true;
    try {
      const result = await database[method](...args, { ...options, signal: op.controller.signal });
      if (database !== selected || !vscode.workspace.isTrusted) throw Error('The selected DuckDB file changed. Run the operation again.');
      return result;
    } finally {
      if (method === 'manageExtension') extensionChange = false;
      op.release();
    }
  }

  const api = { open, close, source: () => selected && vscode.workspace.isTrusted ? { ...selected.source } : null,
    catalog: opts => use('catalog', [], opts), describe: (object, opts) => use('describe', [object], opts),
    functions: (search, opts) => use('functions', [search], opts), query: (sql, opts) => use('query', [sql], opts),
    previewFile: (file, opts) => use('previewFile', [file], opts), extensions: opts => use('extensions', [], opts),
    manageExtension: (name, action, opts) => use('manageExtension', [name, action], opts) };

  function progress(title, action) {
    return vscode.window.withProgress({ title, location: vscode.ProgressLocation.Notification, cancellable: true },
      async (value, token) => {
        const controller = new AbortController();
        const cancellation = token.onCancellationRequested(() => controller.abort());
        if (token.isCancellationRequested) controller.abort();
        try { return await action({ signal: controller.signal }); }
        finally { cancellation.dispose(); }
      });
  }

  function show(title, status, headings, rows) {
    if (!panel) {
      panel = vscode.window.createWebviewPanel('rocketbrain.duckdbPreview', title, vscode.ViewColumn.Beside,
        { enableScripts: false, localResourceRoots: [] });
      panel.onDidDispose(() => { panel = undefined; });
    } else panel.reveal(vscode.ViewColumn.Beside);
    panel.title = title;
    panel.webview.html = render(title, status, headings, rows);
  }

  command('open', async () => {
    trusted();
    const [database] = await vscode.window.showOpenDialog({ title: 'Open a Local DuckDB File', filters: { DuckDB: ['duckdb', 'db'] } }) || [];
    if (database?.scheme !== 'file') return;
    const [client] = await vscode.window.showOpenDialog({ title: 'Choose the Installed DuckDB CLI Executable',
      openLabel: 'Use DuckDB CLI', ...(process.platform === 'win32' ? { filters: { Executable: ['exe'] } } : {}) }) || [];
    if (client?.scheme !== 'file') return;
    const result = await progress('Opening DuckDB Read-Only', options => api.open(client.fsPath, database.fsPath, options));
    await vscode.window.showInformationMessage('Opened ' + result.name + ' read-only with DuckDB ' + result.version + '.');
    return result;
  });
  command('close', close);
  command('newQuery', async () => {
    if (!api.source()) throw Error('Open a DuckDB database file first.');
    const document = await vscode.workspace.openTextDocument({ language, content: 'SELECT version();\n' });
    await vscode.window.showTextDocument(document);
    return document.uri.toString();
  });
  command('run', async () => {
    const editor = vscode.window.activeTextEditor;
    if (editor?.document.languageId !== language) throw Error('Open a DuckDB SQL editor first.');
    const sql = editor.selection.isEmpty ? editor.document.getText() : editor.document.getText(editor.selection);
    const result = await progress('Running Read-Only DuckDB Query', options => api.query(sql, options));
    show('DuckDB Query Results', result.rows.length + ' rows' + (result.truncated ? ' · row limit reached' : '') +
      (result.clippedCells ? ' · ' + result.clippedCells + ' values shortened' : ''), result.columns, result.rows);
    return result;
  });
  command('previewFile', async (chosen) => {
    trusted();
    if (!api.source()) throw Error('Open a DuckDB database file first.');
    const [file] = chosen ? [chosen] : await vscode.window.showOpenDialog({ title: 'Preview One Local DuckDB Data File',
      openLabel: 'Preview read-only', filters: { 'CSV and Parquet': ['csv', 'parquet'] } }) || [];
    if (file?.scheme !== 'file') return;
    const result = await progress('Reading DuckDB Data File', options => api.previewFile(file.fsPath, options));
    const status = result.rows.length + ' rows' + (result.truncated ? ' · sample limit reached' : '') +
      (result.clippedCells ? ' · ' + result.clippedCells + ' values shortened' : '');
    show(result.name, status, result.columns, result.rows);
    return result;
  });
  command('extensions', async () => {
    const observed = await progress('Reading DuckDB Extension Inventory', api.extensions);
    show('DuckDB Extensions', observed.length + ' extension entries', ['Name', 'Installed', 'Loaded', 'Version', 'Mode', 'Description'],
      observed.map(row => [row.name, row.installed, row.loaded, row.version, row.mode, row.description]));
    return observed;
  });
  command('manageExtension', async () => {
    const observed = await progress('Reading DuckDB Extension Inventory', api.extensions);
    const choice = await vscode.window.showQuickPick(observed.filter(item => item.managed).map(item => ({
      label: item.name, description: item.loaded ? 'Enabled' : item.installed ? 'Installed' : 'Available', item
    })), { title: 'Manage Workspace DuckDB Extension' });
    if (!choice) return;
    const { item } = choice;
    const actions = item.loaded ? ['disable', 'update'] : item.installed ? ['enable', 'update', 'remove'] : ['install'];
    const selectedAction = await vscode.window.showQuickPick(actions.map(action => ({ label: action[0].toUpperCase() + action.slice(1), action })),
      { title: 'Manage DuckDB ' + item.name });
    if (!selectedAction) return;
    const { action, label } = selectedAction;
    if (['install', 'update', 'remove'].includes(action)) {
      const detail = action === 'remove' ? 'Remove the verified extension file from this workspace.' :
        'Download an official signed extension for the selected DuckDB version and platform. It stays in this workspace.';
      if (await vscode.window.showInformationMessage(label + ' DuckDB ' + item.name + '?', { modal: true, detail }, label) !== label) return;
    }
    const changed = await progress('Applying DuckDB Extension Action', options => api.manageExtension(item.name, action, options));
    await vscode.window.showInformationMessage('DuckDB ' + item.name + ' · ' +
      (changed.loaded ? 'enabled' : changed.installed ? 'installed' : 'removed'));
    return changed;
  });
  command('browse', async () => {
    const { objects, truncated } = await progress('Reading DuckDB Catalog', api.catalog);
    if (!objects.length) return vscode.window.showInformationMessage('This DuckDB database has no user tables or views.');
    const picked = await vscode.window.showQuickPick(objects.map(object => ({ label: object.schema + '.' + object.name,
      description: object.kind + (object.estimated_rows === null ? '' : ' · ~' + object.estimated_rows + ' rows'), object })),
    { title: 'Browse DuckDB Tables and Views', placeHolder: truncated ? 'Showing the first 500 objects' : undefined });
    if (!picked) return;
    const result = await progress('Reading DuckDB Columns', options => api.describe(picked.object, options));
    show(picked.label, picked.description + (result.truncated ? ' · first 200 columns' : ''),
      ['Column', 'Type', 'Nullable', 'Default', 'Comment'], result.columns.map(column =>
        [column.name, column.type, column.nullable ? 'Yes' : 'No', column.default_value, column.comment]));
    return result;
  });
  command('functions', async () => {
    const search = await vscode.window.showInputBox({ title: 'Find DuckDB Functions', prompt: 'Search native names and overloads' });
    if (search === undefined) return;
    const result = await progress('Reading DuckDB Functions', options => api.functions(search, options));
    show('DuckDB Functions', result.matches.length + ' overloads' + (result.truncated ? ' · result limit reached' : ''),
      ['Function', 'Kind', 'Parameters', 'Return type', 'Description', 'Examples'], result.matches.map(item =>
        [item.name, item.kind, item.parameters, item.return_type, item.description, item.examples]));
    return result;
  });

  async function functionsAt(prefix, token, exact = false) {
    if (!api.source() || prefix.length < 3 || token?.isCancellationRequested || operations.size) return [];
    const controller = new AbortController();
    const cancellation = token?.onCancellationRequested(() => controller.abort());
    try {
      const result = await api.functions(prefix, { prefix: !exact, exact, signal: controller.signal });
      return result.matches;
    } catch { return []; }
    finally { cancellation?.dispose(); }
  }

  context.subscriptions.push(vscode.languages.registerCompletionItemProvider({ language }, {
    async provideCompletionItems(document, position, token) {
      const positionText = document.lineAt(position.line).text.slice(0, position.character);
      const prefix = /[a-zA-Z_][a-zA-Z_0-9]*$/.exec(positionText)?.[0]?.toLowerCase() || '';
      if (!prefix || /^\s*(?:--|\/\*)/.test(positionText)) return [];
      const items = new Map();
      for (const label of keywords.filter(name => name.toLowerCase().startsWith(prefix))) {
        items.set(label, new vscode.CompletionItem(label, vscode.CompletionItemKind.Keyword));
      }
      for (const label of coreFunctions.filter(name => name.startsWith(prefix))) {
        items.set(label, new vscode.CompletionItem(label, vscode.CompletionItemKind.Function));
      }
      for (const item of await functionsAt(prefix, token)) {
        if (items.get(item.name)?.detail) continue;
        const completion = new vscode.CompletionItem(item.name, vscode.CompletionItemKind.Function);
        completion.detail = item.kind + ' · DuckDB' + (item.return_type ? ' · ' + item.return_type : '');
        items.set(item.name, completion);
      }
      return token?.isCancellationRequested ? [] : [...items.values()];
    }
  }));
  context.subscriptions.push(vscode.languages.registerHoverProvider({ language }, {
    async provideHover(document, position, token) {
      const range = document.getWordRangeAtPosition(position, /[a-zA-Z_][a-zA-Z_0-9]*/);
      if (!range || !/^\s*\(/.test(document.lineAt(position.line).text.slice(range.end.character))) return;
      const name = document.getText(range);
      const matches = await functionsAt(name, token, true);
      if (!matches.length || token?.isCancellationRequested) return;
      const details = new vscode.MarkdownString();
      for (const item of matches.slice(0, 8)) {
        details.appendCodeblock(item.name + ' ' + (item.parameters || '[]') + (item.return_type ? ' → ' + item.return_type : ''), language);
      }
      if (matches[0].description) details.appendText(matches[0].description);
      return new vscode.Hover(details, range);
    }
  }));
  context.subscriptions.push({ dispose: close });
  return api;
}

module.exports = { registerDuckDb, render };
