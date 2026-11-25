'use strict';

const { randomUUID } = require('node:crypto');
const { contextOf, listNames, loadSource } = require('./object-source');

const scheme = 'rocketbrain-object-source';
const maxDocuments = 16;
const invalidated = '-- This database source is no longer available on the current connection. Open the object source again.';

function registerObjectSources(vscode, { database }) {
  const changed = new vscode.EventEmitter(), documents = new Map();
  let generation = 0, disposed = false;

  function check(frame) {
    if (disposed || !vscode.workspace.isTrusted) throw Error('Open a trusted workspace to read object source.');
    if (frame !== generation) throw Error('The metadata connection changed. Browse object source again.');
  }

  function inspect(action, frame = generation) {
    check(frame);
    return database.withDatabaseAdmin(async lease => {
      let connection;
      const query = async (sql, values) => {
        check(frame);
        if (!lease.guard()) throw Error('The metadata connection changed. Browse object source again.');
        const result = await lease.db._metadataQuery(sql, values);
        check(frame);
        const current = lease.db._metadataSession.connection;
        if (!lease.guard() || !current || connection && current !== connection) {
          throw Error('The metadata connection changed. Browse object source again.');
        }
        connection = current;
        return result;
      };
      const value = await action(query, await contextOf(query));
      return { value, epoch: lease.epoch };
    });
  }

  async function list(request, frame) {
    const { value } = await inspect(async (query, context) => ({ ...context, ...await listNames(query, context, request) }), frame);
    return value;
  }

  function forget(key) {
    const previous = documents.get(key);
    if (!previous) return;
    documents.delete(key);
    changed.fire(previous.uri);
  }

  async function open(object, frame = generation) {
    const { value, epoch } = await inspect((query, context) => loadSource(query, context, object), frame);
    check(frame);
    const identity = JSON.stringify(value.object);
    const existing = [...documents.values()].find(item => item.epoch === epoch && item.identity === identity);
    if (existing) {
      existing.source = value.source;
      changed.fire(existing.uri);
    }
    const filename = [value.object.schema, value.object.name, value.object.kind].join('.').replace(/[\\/:]/g, '_');
    const uri = existing?.uri || vscode.Uri.from({ scheme, path: '/' + randomUUID() + '/' + filename + '.sql' });
    const key = uri.toString();
    if (!existing) {
      while (documents.size >= maxDocuments) forget(documents.keys().next().value);
      documents.set(key, { object: { ...value.object }, identity, uri, epoch, source: value.source });
    }
    const document = await vscode.workspace.openTextDocument(uri);
    check(frame);
    await vscode.window.showTextDocument(document, { preview: false });
    check(frame);
    return { ...value, documentUri: key };
  }

  async function refresh(uri = vscode.window.activeTextEditor?.document.uri) {
    const current = uri?.scheme === scheme && documents.get(uri.toString());
    if (!current) throw Error('Open the database object source before refreshing it.');
    return open(current.object);
  }

  async function choosePage(load, frame, title) {
    let after = '';
    for (;;) {
      const page = await load(after);
      const choices = page.items.map(item => ({ label: item.name, description: item.kind, item }));
      if (page.next) choices.push({ label: 'Next page…', next: true });
      if (!choices.length) {
        await vscode.window.showInformationMessage('No matching objects are visible to the current account.');
        return;
      }
      const selected = await vscode.window.showQuickPick(choices, { title });
      check(frame);
      if (!selected || !selected.next) return { item: selected?.item, kinds: page.kinds };
      after = page.next;
    }
  }

  async function browse(item) {
    const frame = generation;
    if (item?.table?.name) {
      const schema = database.catalogSnapshot()?.database;
      return open({ schema, name: item.table.name, kind: item.table.kind }, frame);
    }

    const schema = await choosePage(after => list({ kind: 'schema', after }, frame), frame, 'Choose a Database Schema');
    if (!schema?.item) return;
    const kind = await vscode.window.showQuickPick(schema.kinds, { title: 'Choose a Database Object Type' });
    check(frame);
    if (!kind) return;
    if (kind.kind === 'schema') return open(schema.item, frame);

    const prefix = await vscode.window.showInputBox({ title: 'Find ' + kind.label, prompt: 'Optional object name prefix' });
    check(frame);
    if (prefix === undefined) return;
    const target = await choosePage(after => list({ kind: kind.kind, schema: schema.item.name, prefix, after }, frame),
      frame, 'Choose a ' + kind.label + ' to View');
    if (target?.item) return open(target.item, frame);
  }

  function command(id, action) {
    return vscode.commands.registerCommand(id, async argument => {
      try { return await action(argument); }
      catch (error) { if (!disposed) await vscode.window.showErrorMessage('Rocketbrain object source: ' + error.message); }
    });
  }

  const subscriptions = [changed,
    vscode.workspace.registerTextDocumentContentProvider(scheme, {
      onDidChange: changed.event,
      provideTextDocumentContent(uri) {
        return vscode.workspace.isTrusted ? documents.get(uri.toString())?.source ?? invalidated : invalidated;
      }
    }),
    vscode.workspace.onDidCloseTextDocument(document => {
      if (document.uri.scheme === scheme) documents.delete(document.uri.toString());
    }),
    database.onDidChangeDatabase(({ epoch, mysql }) => {
      generation++;
      for (const [key, value] of documents) if (!mysql || value.epoch !== epoch) forget(key);
    }),
    command('rocketbrain.db.openObjectSource', browse),
    command('rocketbrain.db.refreshObjectSource', refresh)
  ];

  return {
    listSchemas: options => list({ ...options, kind: 'schema' }),
    listObjects: options => list(options),
    open,
    refresh,
    dispose() {
      if (disposed) return;
      disposed = true;
      documents.clear();
      for (const subscription of subscriptions) subscription.dispose();
    }
  };
}

module.exports = { registerObjectSources };
