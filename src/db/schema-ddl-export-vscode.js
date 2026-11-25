'use strict';

const { randomUUID } = require('node:crypto');
const { buildDdlExport } = require('./schema-ddl-export');

function registerSchemaDdlExport(context, vscode, { database }) {
  const reviews = new Map(), subscriptions = [];
  let generation = 0, pending, disposed = false;

  function trusted() {
    if (disposed || !vscode.workspace.isTrusted) throw new Error('Open a trusted workspace to export database DDL.');
  }

  function exclusive(action) {
    trusted();
    if (pending) throw new Error('Finish the active schema export first.');
    const work = Promise.resolve().then(action);
    pending = work;
    return work.finally(() => { if (pending === work) pending = undefined; });
  }

  function checkGeneration(ticket) {
    trusted();
    if (generation !== ticket) throw new Error('The connection or catalog changed. Prepare the DDL export again.');
  }

  async function prepare({ tables, includeStored = tables === undefined } = {}) {
    return exclusive(async () => {
      const ticket = generation;
      if (typeof includeStored !== 'boolean') throw new Error('Choose whether to include visible stored-program definitions.');
      const options = { ...(tables === undefined ? {} : { tables: structuredClone(tables) }), includeStored };
      const captured = await database.captureSchemaSnapshot(options);
      checkGeneration(ticket);
      const report = buildDdlExport(captured), id = randomUUID();
      const expiresAt = Date.now() + 5 * 60 * 1000;
      for (const [key, review] of reviews) if (review.expiresAt <= Date.now()) reviews.delete(key);
      while (reviews.size >= 6) reviews.delete(reviews.keys().next().value);
      reviews.set(id, { report, options, expiresAt, generation: ticket });
      return { id, expiresAt, ...structuredClone(report) };
    });
  }

  function review(id) {
    trusted();
    const value = reviews.get(id);
    if (!value || value.expiresAt <= Date.now()) throw new Error('The DDL export preview expired. Prepare it again.');
    checkGeneration(value.generation);
    return value;
  }

  async function saveReview(id, destination) {
    return exclusive(async () => {
      const value = review(id);
      if (destination?.scheme !== 'file' || destination.authority) throw new Error('Choose a local SQL file for the schema export.');
      const fresh = buildDdlExport(await database.captureSchemaSnapshot(value.options));
      checkGeneration(value.generation);
      if (fresh.sourceIdentity !== value.report.sourceIdentity || fresh.fingerprint !== value.report.fingerprint) {
        throw new Error('The database object definitions or dependency coverage changed after review.');
      }
      await vscode.workspace.fs.writeFile(destination, Buffer.from(value.report.sql));
      return { state: 'saved', uri: destination.toString(), fingerprint: fresh.fingerprint,
        statements: fresh.statements.length, omitted: fresh.omitted.length, executedSql: false, rowDataIncluded: false };
    });
  }

  async function chooseScope(item) {
    if (item?.table?.name) return { tables: [item.table.name], includeStored: true };
    const catalog = database.catalogSnapshot();
    if (!catalog) throw new Error('Connect to MySQL or MariaDB before exporting DDL.');
    const ticket = generation;
    const choices = [
      { label: 'All Visible Schema Definitions', description: 'Tables, views, supported routines and triggers', all: true },
      { label: 'Choose Tables and Views', description: 'Include attached triggers and their supported routine dependencies', all: false }
    ];
    const selection = await vscode.window.showQuickPick(choices, { title: 'Choose Schema DDL Export Scope' });
    if (!selection) return;
    checkGeneration(ticket);
    if (selection.all) return {};
    const objects = [...catalog.tables, ...catalog.views].filter(item => !/^__rb_/i.test(item.name));
    const selected = await vscode.window.showQuickPick(objects.map(item => ({ label: item.name, description: item.kind })),
      { title: 'Select Objects and Their Required Dependencies', canPickMany: true });
    if (!selected?.length) return;
    checkGeneration(ticket);
    return { tables: selected.map(item => item.label), includeStored: true };
  }

  async function command(item) {
    try {
      trusted();
      const scope = await chooseScope(item);
      if (!scope) return;
      const value = await prepare(scope);
      const document = await vscode.workspace.openTextDocument(vscode.Uri.parse('rocketbrain-schema-ddl-export:/' + value.id + '/schema.sql'));
      await vscode.window.showTextDocument(document, { preview: false });
      const destination = await vscode.window.showSaveDialog({ title: 'Save Reviewed Schema DDL', filters: { 'SQL script': ['sql'] } });
      if (destination) return await saveReview(value.id, destination);
    } catch (error) {
      if (!disposed) await vscode.window.showErrorMessage('Rocketbrain Schema DDL: ' + error.message);
    }
  }

  subscriptions.push(vscode.commands.registerCommand('rocketbrain.schema.exportDdl', command));
  subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('rocketbrain-schema-ddl-export', {
    provideTextDocumentContent(uri) {
      try { return review(uri.path.split('/').filter(Boolean)[0]).report.sql; }
      catch { return '-- Prepare a new schema DDL export to inspect the current definitions.'; }
    }
  }));
  subscriptions.push(database.onDidChangeDatabase(() => { generation++; }));

  return { prepare, saveReview,
    async dispose() {
      if (disposed) return;
      disposed = true;
      for (const subscription of subscriptions) subscription.dispose();
      await pending?.catch(() => {});
      reviews.clear();
    } };
}

module.exports = { registerSchemaDdlExport };
