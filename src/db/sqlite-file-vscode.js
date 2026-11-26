'use strict';

const { randomUUID } = require('node:crypto');
const { statementAt } = require('../sql');
const { openSqliteSnapshot } = require('./sqlite-file');

const language = 'rocketbrain-sqlite';
const scheme = 'rocketbrain-sqlite-snapshot';
const label = value => String(value ?? '').replace(/[\x00-\x1f\x7f]/gu, ' ');
const identifier = value => '"' + value.replaceAll('"', '""') + '"';
const closed = () => Error('Open a local SQLite snapshot in a trusted workspace first.');
const textSql = (source, metadata) => {
  const columns = metadata.columns.map(column => '-- ' + label(column.name) + '  ' + (label(column.type) || '(no declared type)') +
    (column.primaryKeyOrder ? '  PK #' + column.primaryKeyOrder : '') + (column.generated ? '  GENERATED ' + column.generated.toUpperCase() : '') +
    (column.hidden ? '  HIDDEN' : '') + (column.notNull ? '  NOT NULL' : '') +
    (column.defaultSql !== null ? '  DEFAULT ' + label(column.defaultSql) : ''));
  const foreign = metadata.foreignKeys.map(key => '-- FK #' + key.id + ' ' + label(key.from) + ' → ' + label(key.table) + '.' +
    label(key.to ?? '(primary key)') + '  ON UPDATE ' + label(key.onUpdate) + '  ON DELETE ' + label(key.onDelete));
  const indexes = metadata.indexes.flatMap(index => ['-- Index ' + label(index.name) + ' · ' + index.origin +
    (index.unique ? ' · UNIQUE' : '') + (index.partial ? ' · PARTIAL' : ''), ...index.columns.map(term =>
    '--   ' + (term.key ? 'key' : 'auxiliary') + ' ' + label(term.column ?? term.term) + (term.descending ? ' DESC' : ' ASC') +
    (term.collation ? ' ' + label(term.collation) : '')), ...(index.source ? [index.source + ';'] : []), '']);
  return ['-- SQLite schema snapshot ' + label(source.name) + ' · ' + source.snapshotSha256, '-- ' + metadata.kind.toUpperCase() +
    ' ' + label(metadata.name) + (metadata.strict ? ' · STRICT' : '') + (metadata.withoutRowid ? ' · WITHOUT ROWID' : ''), '',
    ...columns, ...foreign, '', ...(metadata.source ? [metadata.source + ';', ''] : []), ...indexes].join('\n');
};

function registerSqliteFile(context, vscode, database) {
  let selected, attempt, generation = 0, disposed = false;
  const notes = new Map(), reviewed = new Map();
  const trusted = () => { if (disposed || !vscode.workspace.isTrusted) throw closed(); };
  const connected = () => void vscode.commands.executeCommand('setContext', 'rocketbrain.sqliteConnected', Boolean(selected?.source));
  const active = () => { trusted(); if (!selected?.source) throw closed(); return selected; };
  const ensure = session => { if (session !== selected || !session.source || !vscode.workspace.isTrusted) throw closed(); };

  async function close() {
    generation++;
    attempt?.abort();
    const previous = selected;
    selected = undefined;
    notes.clear();
    reviewed.clear();
    connected();
    await previous?.stop();
  }

  async function open(file, { signal } = {}) {
    trusted();
    const fresh = ++generation;
    attempt?.abort();
    const openAttempt = new AbortController();
    attempt = openAttempt;
    const abort = () => openAttempt.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    let candidate;
    try {
      candidate = await openSqliteSnapshot(file, { signal: openAttempt.signal });
      trusted();
      if (fresh !== generation || openAttempt.signal.aborted) throw closed();
      const previous = selected;
      selected = candidate;
      notes.clear();
      reviewed.clear();
      connected();
      await previous?.stop();
      ensure(candidate);
      return { ...candidate.source };
    } finally {
      if (candidate && candidate !== selected) await candidate.stop();
      if (attempt === openAttempt) attempt = undefined;
      signal?.removeEventListener('abort', abort);
    }
  }

  async function use(action) {
    const session = active();
    try {
      const value = await action(session);
      ensure(session);
      return value;
    } finally {
      if (selected === session && !session.source) await close();
    }
  }

  function readonlyNote(id, name, content) {
    while (notes.size >= 12) notes.delete(notes.keys().next().value);
    const uri = vscode.Uri.parse(scheme + ':/' + id + '/' + name + '.sqlite.sql');
    notes.set(uri.toString(), content);
    return uri;
  }

  async function prepare(sql, options) {
    return use(async session => {
      const review = await session.prepare(sql, options);
      ensure(session);
      const comment = ['-- ' + label(session.source.name) + ' · read-only SQLite snapshot', '-- SHA-256 ' + review.snapshotSha256,
        '-- Up to ' + review.maxRows + ' rows. Review this statement before execution.',
        ...review.plan.map(node => '-- Plan ' + node.id + ' (parent ' + node.parent + ') ' + label(node.detail)),
        ...(review.planTruncated ? ['-- Further plan operations omitted.'] : []), '', ''].join('\n');
      const uri = readonlyNote(review.reviewId, 'query-review', comment + review.sql);
      while (reviewed.size >= 8) reviewed.delete(reviewed.keys().next().value);
      reviewed.set(review.reviewId, { source: session.source, sql: review.sql });
      return { ...review, reviewUri: uri.toString() };
    });
  }

  function discard(reviewId) {
    selected?.discard(reviewId);
    reviewed.delete(reviewId);
  }

  async function run(reviewId, options = {}) {
    return use(async session => {
      const reviewedQuery = reviewed.get(reviewId);
      if (!reviewedQuery || reviewedQuery.source !== session.source) throw Error('Review the exact query on the selected SQLite snapshot.');
      reviewed.delete(reviewId);
      const resultId = database.scriptResultBegin(reviewedQuery.sql,
        'SQLite snapshot · ' + label(session.source.name) + ' · ' + session.source.snapshotSha256.slice(0, 12), { readOnly: true });
      try {
        const result = await session.execute(reviewId, options);
        ensure(session);
        database.scriptResultFinish(resultId, result);
        await database.showResults();
        ensure(session);
        return { ...result, resultId, snapshotSha256: session.source.snapshotSha256 };
      } catch (error) {
        database.scriptResultFinish(resultId, undefined, error.message || String(error));
        throw error;
      }
    });
  }

  function describe(name, options) {
    return use(async session => {
      const description = await session.describe(name, options);
      ensure(session);
      const uri = readonlyNote(randomUUID(), 'schema', textSql(session.source, description));
      return { ...description, schemaUri: uri.toString() };
    });
  }

  const api = { open, close, source: () => vscode.workspace.isTrusted && selected?.source ? { ...selected.source } : null,
    refresh: options => open(active().file, options), catalog: options => use(session => session.catalog(options)),
    describe, prepare, run, discard };

  function progress(title, action) {
    return vscode.window.withProgress({ title, location: vscode.ProgressLocation.Notification, cancellable: true }, async (_, token) => {
      const controller = new AbortController();
      const cancellation = token.onCancellationRequested(() => controller.abort());
      if (token.isCancellationRequested) controller.abort();
      try { return await action({ signal: controller.signal }); }
      finally { cancellation.dispose(); }
    });
  }

  const command = (id, action) => context.subscriptions.push(vscode.commands.registerCommand('rocketbrain.sqlite.' + id, async (...args) => {
    try { return await action(...args); }
    catch (error) {
      if (error.code !== 'ROCKETBRAIN_SQLITE_CANCELED') await vscode.window.showErrorMessage('Rocketbrain SQLite: ' + error.message);
    }
  }));
  async function showNote(uri) {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
    await vscode.window.showTextDocument(document, { preview: true, viewColumn: vscode.ViewColumn.Beside });
    return document;
  }
  async function newQuery(name) {
    active();
    const content = (name ? 'SELECT * FROM main.' + identifier(name) + ' LIMIT 100;' : 'SELECT sqlite_version() AS sqlite_version;') + '\n';
    const document = await vscode.workspace.openTextDocument({ language, content });
    await vscode.window.showTextDocument(document, { preview: false });
    return document.uri.toString();
  }

  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(scheme, {
    provideTextDocumentContent(uri) { trusted(); return notes.get(uri.toString()) ?? '-- This SQLite snapshot review expired.'; }
  }), { dispose() { disposed = true; void close(); } });
  command('open', async () => {
    trusted();
    const [file] = await vscode.window.showOpenDialog({ title: 'Open a Local SQLite Snapshot', openLabel: 'Open Read-Only',
      filters: { 'SQLite database': ['sqlite', 'sqlite3', 'db', 'db3'], 'All files': ['*'] } }) || [];
    if (!file) return;
    if (file.scheme !== 'file' || file.authority) throw Error('Choose a local SQLite file on this extension host.');
    const result = await progress('Opening SQLite Snapshot', options => open(file.fsPath, options));
    await vscode.window.showInformationMessage('Opened read-only SQLite snapshot of ' + label(result.name) + '.');
    return result;
  });
  command('refresh', async () => {
    const result = await progress('Refreshing SQLite Snapshot', api.refresh);
    await vscode.window.showInformationMessage('Refreshed ' + label(result.name) + ' · ' + result.snapshotSha256.slice(0, 12));
    return result;
  });
  command('close', close);
  command('newQuery', () => newQuery());
  command('browse', async () => {
    const session = active();
    const { objects, truncated } = await progress('Reading SQLite Catalog', api.catalog);
    if (!objects.length) return vscode.window.showInformationMessage('No user tables or views in this SQLite snapshot.');
    const chosen = await vscode.window.showQuickPick(objects.map(object => ({ label: label(object.name),
      description: object.kind + ' · ' + object.columns + ' columns', object })),
    { title: label(session.source.name) + ' · SQLite snapshot' + (truncated ? ' · first 256 objects' : '') });
    if (!chosen) return;
    ensure(session);
    const action = await vscode.window.showQuickPick(['Open Schema and Indexes', 'Open Row Query'], { title: label(chosen.object.name) });
    ensure(session);
    if (action === 'Open Schema and Indexes') {
      const metadata = await progress('Reading SQLite Object', options => describe(chosen.object.name, options));
      await showNote(metadata.schemaUri);
      return metadata;
    }
    if (action === 'Open Row Query') return newQuery(chosen.object.name);
  });
  command('run', async () => {
    const editor = vscode.window.activeTextEditor;
    if (editor?.document.languageId !== language || editor.document.uri.scheme === scheme) throw Error('Open a SQLite SQL editor first.');
    const { document } = editor, version = document.version;
    const sql = editor.selection.isEmpty ? statementAt(document.getText(), document.offsetAt(editor.selection.active), { dialect: 'sqlite' }) :
      document.getText(editor.selection);
    const preview = await progress('Reviewing SQLite Query', options => prepare(sql, options));
    try {
      const note = await showNote(preview.reviewUri);
      if (!note.getText().endsWith(preview.sql)) throw Error('The exact SQLite review is unavailable. Prepare again.');
      const choice = await vscode.window.showInformationMessage('Run this read-only query on the reviewed SQLite snapshot?',
        { modal: true }, 'Run Reviewed Query');
      if (choice !== 'Run Reviewed Query') return;
      if (document.version !== version || document.isClosed) throw Error('The SQLite SQL editor changed after review. Prepare again.');
      return await progress('Running Reviewed SQLite Query', options => run(preview.reviewId, options));
    } finally { discard(preview.reviewId); }
  });

  return api;
}

module.exports = { registerSqliteFile };
