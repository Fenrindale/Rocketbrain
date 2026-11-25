'use strict';

const { MongoDbError, openMongoDb, parseMongoFind, parseMongoAggregation, inspectMongoTlsCa } = require('./mongodb');

const resultScheme = 'rocketbrain-mongodb-result';
const commandPrefix = 'rocketbrain.mongodb.';

function registerMongoDb(context, vscode) {
  let selected, joining, previewCount = 0;
  const generatedQueries = new Map();
  const previews = new Map();
  const changed = new vscode.EventEmitter();
  context.subscriptions.push(changed, vscode.workspace.registerTextDocumentContentProvider(resultScheme, {
    onDidChange: changed.event,
    provideTextDocumentContent: uri => previews.get(uri.toString())?.text ?? ''
  }));

  function trusted() {
    if (!vscode.workspace.isTrusted) throw new MongoDbError('Trust the workspace before connecting to MongoDB.');
  }

  function clearPreviews() {
    const old = [...previews.values()];
    previews.clear();
    for (const { uri } of old) changed.fire(uri);
  }

  async function close() {
    joining?.abort();
    joining = undefined;
    clearPreviews();
    const old = selected;
    selected = undefined;
    void vscode.commands.executeCommand('setContext', 'rocketbrain.mongoConnected', false);
    void vscode.commands.executeCommand('setContext', 'rocketbrain.mongoEditable', false);
    await old?.close();
  }

  async function open(configuration, { signal } = {}) {
    trusted();
    const pending = new AbortController();
    joining?.abort();
    joining = pending;
    const request = signal ? AbortSignal.any([pending.signal, signal]) : pending.signal;
    try {
      const next = await openMongoDb(configuration, { signal: request });
      if (joining !== pending || request.aborted || !vscode.workspace.isTrusted) {
        await next.close();
        throw new MongoDbError('MongoDB connection cancelled.', 'ROCKETBRAIN_MONGO_CANCELLED');
      }
      const old = selected;
      selected = next;
      clearPreviews();
      void vscode.commands.executeCommand('setContext', 'rocketbrain.mongoConnected', true);
      void vscode.commands.executeCommand('setContext', 'rocketbrain.mongoEditable', next.source.reviewedEdits === true);
      await old?.close().catch(() => {});
      return next.source;
    } finally {
      if (joining === pending) joining = undefined;
    }
  }

  async function use(method, args) {
    trusted();
    const connection = selected;
    if (!connection) throw new MongoDbError('Connect to a MongoDB server first.');
    const result = await connection[method](...args);
    trusted();
    if (selected !== connection && method !== 'applyEdit') throw new MongoDbError('The MongoDB connection changed.', 'ROCKETBRAIN_MONGO_CANCELLED');
    return result;
  }

  function prepareEdit(...args) {
    trusted();
    if (!selected) throw new MongoDbError('Connect to a MongoDB server first.');
    return selected.prepareEdit(...args);
  }

  const api = { open, close, source: () => vscode.workspace.isTrusted ? selected?.source ?? null : null,
    databases: options => use('databases', [options]), collections: (database, options) => use('collections', [database, options]),
    find: (source, options) => use('find', [source, options]),
    inspectAggregation: (target, options) => use('inspectAggregation', [target, options]),
    aggregate: (source, options) => use('aggregate', [source, options]),
    inspectDocumentEdit: (target, options) => use('inspectDocumentEdit', [target, options]),
    prepareEdit, applyEdit: (review, approved, options) => use('applyEdit', [review, approved, options]) };

  context.subscriptions.push({ dispose: () => { void close().catch(() => {}); } },
    vscode.workspace.onDidCloseTextDocument(document => generatedQueries.delete(document.uri.toString())));

  function command(id, action) {
    context.subscriptions.push(vscode.commands.registerCommand(commandPrefix + id, async (...args) => {
      try { return await action(...args); }
      catch (error) {
        if (error.code !== 'ROCKETBRAIN_MONGO_CANCELLED') {
          const message = error instanceof MongoDbError ? error.message : 'The operation could not be completed.';
          void vscode.window.showErrorMessage('Rocketbrain MongoDB: ' + message);
        }
      }
    }));
  }

  function progress(title, action) {
    return vscode.window.withProgress({ title, location: vscode.ProgressLocation.Notification, cancellable: true },
      async (_progress, token) => {
        const signal = new AbortController();
        const cancellation = token.onCancellationRequested(() => signal.abort());
        if (token.isCancellationRequested) signal.abort();
        try { return await action({ signal: signal.signal }); }
        finally { cancellation.dispose(); }
      });
  }

  async function pickCollection(ordinaryOnly = false) {
    const { databases, truncated } = await progress('Reading MongoDB Databases', api.databases);
    if (!databases.length) {
      await vscode.window.showInformationMessage('This MongoDB account has no visible databases.');
      return;
    }
    const database = await vscode.window.showQuickPick(databases,
      { title: 'MongoDB Databases', placeHolder: truncated ? 'Showing the first 200 databases' : 'Choose a database' });
    if (!database) return;
    const catalog = await progress('Reading MongoDB Collections', options => api.collections(database, options));
    const available = ordinaryOnly ? catalog.collections.filter(item => item.kind === 'collection' && !item.name.startsWith('system.')) :
      catalog.collections;
    if (!available.length) {
      await vscode.window.showInformationMessage('This MongoDB account has no visible collections in the selected database.');
      return;
    }
    const chosen = await vscode.window.showQuickPick(available.map(item => ({ label: item.name, description: item.kind })),
      { title: database, placeHolder: catalog.truncated ? 'Showing the first 200 catalog entries' :
        ordinaryOnly ? 'Choose a collection for aggregation' : 'Choose a collection or view' });
    return chosen ? { database, collection: chosen.label } : undefined;
  }

  async function openQuery(source, kind) {
    const document = await vscode.workspace.openTextDocument({ language: 'json', content: source + '\n' });
    generatedQueries.set(document.uri.toString(), kind);
    await vscode.window.showTextDocument(document);
    return document.uri.toString();
  }

  async function newFind(target) {
    trusted();
    if (!selected) throw new MongoDbError('Connect to a MongoDB server first.');
    target ??= await pickCollection();
    if (!target) return;
    const source = JSON.stringify({ database: target.database, collection: target.collection, filter: {}, limit: 50 }, null, 2);
    parseMongoFind(source);
    return openQuery(source, 'find');
  }

  async function newAggregation(target) {
    trusted();
    if (!selected) throw new MongoDbError('Connect to a MongoDB server first.');
    target ??= await pickCollection(true);
    if (!target) return;
    const observed = await progress('Inspecting MongoDB Collection Identity', options => api.inspectAggregation(target, options));
    const source = JSON.stringify({ ...observed, pipeline: [{ $match: {} }], limit: 50 }, null, 2);
    parseMongoAggregation(source);
    return openQuery(source, 'aggregation');
  }

  function queryText(kind, suffix) {
    const document = vscode.window.activeTextEditor?.document;
    if (document?.languageId !== 'json' || !(generatedQueries.get(document.uri.toString()) === kind ||
      (document.uri.scheme === 'file' && document.fileName.toLowerCase().endsWith(suffix)))) {
      throw new MongoDbError('Open a MongoDB ' + kind + ' editor or a ' + suffix + ' file.');
    }
    return document.getText();
  }

  async function showResult(result) {
    const uri = vscode.Uri.from({ scheme: resultScheme, path: `/MongoDB result ${++previewCount}.json` });
    previews.set(uri.toString(), { uri, text: JSON.stringify({ ...result, documentCount: result.documents.length }, null, 2) + '\n' });
    if (previews.size > 3) {
      const [first, old] = previews.entries().next().value;
      previews.delete(first);
      changed.fire(old.uri);
    }
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true, preview: true });
    return uri.toString();
  }

  command('open', async () => {
    trusted();
    const mode = await vscode.window.showQuickPick([{ label: 'Verify TLS with a PEM CA', tls: true },
      { label: 'Local numeric loopback', tls: false }], { title: 'MongoDB Connection Security' });
    if (!mode) return;
    const host = mode.tls ? (await vscode.window.showInputBox({ title: 'MongoDB Server DNS Name or IP Address', value: 'localhost' }))?.trim() :
      await vscode.window.showQuickPick(['127.0.0.1', '::1'], { title: 'Local MongoDB Address' });
    if (!host) return;
    const port = await vscode.window.showInputBox({ title: 'MongoDB Port', value: '27017',
      validateInput: value => /^\d{1,5}$/.test(value) && +value >= 1 && +value <= 65535 ? undefined : 'Enter a port from 1 to 65535.' });
    if (!port) return;
    const authSource = await vscode.window.showInputBox({ title: 'Authentication Database', value: 'admin' });
    if (authSource === undefined) return;
    let tls;
    if (mode.tls) {
      const [file] = await vscode.window.showOpenDialog({ title: 'Select the MongoDB CA Certificate File',
        filters: { 'PEM certificates': ['pem', 'crt', 'cer'] } }) || [];
      if (file?.scheme !== 'file' || file.authority) return;
      const ca = await progress('Inspecting MongoDB CA Certificates', options => inspectMongoTlsCa(file.fsPath, options));
      const action = 'Approve MongoDB Trust';
      const accepted = await vscode.window.showWarningMessage('Verify this MongoDB endpoint using the reviewed CA file?',
        { modal: true, detail: [host + ' · port ' + port, file.fsPath, 'File SHA-256 ' + ca.sha256, ...ca.fingerprints].join('\n') }, action);
      if (accepted !== action) return;
      tls = { caPath: file.fsPath, caSha256: ca.sha256 };
    }
    const username = await vscode.window.showInputBox({ title: 'MongoDB Username' });
    if (username === undefined) return;
    const password = await vscode.window.showInputBox({ title: 'MongoDB Password', password: true,
      prompt: 'The password is used for this connection session.' });
    if (password === undefined) return;
    const access = await vscode.window.showQuickPick([{ label: 'Read-only Find and Aggregation', edits: false },
      { label: 'Allow reviewed single-field document edits', edits: true }], { title: 'MongoDB Connection Access' });
    if (!access) return;
    if (access.edits) {
      const action = 'Approve Reviewed Edits';
      const accepted = await vscode.window.showWarningMessage('Allow reviewed MongoDB field edits for this connection session?',
        { modal: true, detail: [host + ' · port ' + port, 'Authentication database ' + authSource,
          'MongoDB must grant the account permission to update the chosen collection. Each field change requires its own review.'].join('\n') }, action);
      if (accepted !== action) return;
    }
    const source = await progress('Connecting to MongoDB', options => open({ host, port: Number(port), authSource, username,
      password, tls, reviewedEdits: access.edits }, options));
    void vscode.window.showInformationMessage('MongoDB connected to ' + source.host + (source.transport === 'tls-verified' ? ' with verified TLS.' :
      ' on the local loopback interface.'));
    return source;
  });
  command('close', close);
  command('browse', () => newFind());
  command('newFind', newFind);
  command('newAggregation', newAggregation);
  command('run', async () => {
    const source = queryText('find', '.mongo.json');
    const result = await progress('Running Read-Only MongoDB Find', options => api.find(source, options));
    return { ...result, preview: await showResult(result) };
  });
  command('runAggregation', async () => {
    const source = queryText('aggregation', '.mongo-aggregate.json');
    const result = await progress('Running Read-Only MongoDB Aggregation', options => api.aggregate(source, options));
    return { ...result, preview: await showResult(result) };
  });
  command('editDocumentField', async () => {
    trusted();
    if (selected?.source.reviewedEdits !== true) throw new MongoDbError('Open a MongoDB connection approved for reviewed field edits.');
    const target = await pickCollection(true);
    if (!target) return;
    const id = await vscode.window.showInputBox({ title: 'MongoDB Document ObjectId', prompt: 'Copy the 24-character ObjectId from Find' });
    if (id === undefined) return;
    const snapshot = await progress('Inspecting MongoDB Document', options => api.inspectDocumentEdit({ ...target, objectId: id.trim() }, options));
    const field = await vscode.window.showQuickPick(snapshot.fields.map(item => ({
      label: item.name, description: item.type, detail: JSON.stringify(item.value).slice(0, 180), item
    })), { title: 'Choose an Observed Document Field' });
    if (!field) return;
    const value = await vscode.window.showInputBox({ title: 'New MongoDB BSON Field Value', value: JSON.stringify(field.item.value),
      prompt: 'Enter one JSON string, boolean, null, or canonical $numberInt or $numberLong object', ignoreFocusOut: true });
    if (value === undefined) return;
    const edit = api.prepareEdit(snapshot.id, field.item.name, value);
    const action = 'Commit MongoDB Field';
    const accepted = await vscode.window.showWarningMessage('Commit this exact MongoDB field change?',
      { modal: true, detail: [edit.database + '.' + edit.collection, 'ObjectId ' + edit.objectId, 'Field ' + edit.field,
        'Before (' + edit.beforeType + ')  ' + JSON.stringify(edit.before), 'After (' + edit.afterType + ')  ' + JSON.stringify(edit.after)].join('\n') }, action);
    if (accepted !== action) return;
    const result = await progress('Committing MongoDB Field', options => api.applyEdit(edit.id, true, options));
    void vscode.window.showInformationMessage('MongoDB confirmed the single-field change.');
    return result;
  });

  return api;
}

module.exports = { registerMongoDb };
