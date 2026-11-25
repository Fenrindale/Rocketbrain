'use strict';

const { randomUUID } = require('node:crypto');
const { contextOf, listNames, loadSource } = require('./object-source');
const { searchDatabaseText, textHash } = require('./unified-search');
const { sourceTokens, sourceRange } = require('./sql-analysis');
const { ddlDefinitionLocation } = require('./sql-ddl-location');
const { isApplicationSchema, limits: viewImpactLimits } = require('./view-impact');
const { registerViewImpact } = require('./view-impact-vscode');
const { registerCatalogUsages } = require('./catalog-usages-vscode');

const scheme = 'rocketbrain-object-source';
const maxDocuments = 16;
const invalidated = '-- This database source is no longer available on the current connection. Open the object source again.';

function registerObjectSources(vscode, { database, captureFileUsages }) {
  const changed = new vscode.EventEmitter(), documents = new Map();
  let generation = 0, disposed = false;

  function check(frame) {
    if (disposed || !vscode.workspace.isTrusted) throw Error('Open a trusted workspace to read object source.');
    if (frame !== generation) throw Error('The metadata connection changed. Browse object source again.');
  }

  function inspect(action, frame = generation, assertActive = () => {}) {
    check(frame);
    assertActive();
    return database.withDatabaseAdmin(async lease => {
      let connection;
      const query = async (sql, values) => {
        check(frame);
        assertActive();
        if (!lease.guard()) throw Error('The metadata connection changed. Browse object source again.');
        const result = await lease.db._metadataQuery(sql, values);
        check(frame);
        assertActive();
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

  async function retainDocument(value, epoch, frame, exact, assertActive = () => {}) {
    check(frame);
    assertActive();
    const identity = JSON.stringify(value.object);
    const existing = [...documents.values()].find(item => item.epoch === epoch && item.identity === identity &&
      (!exact || item.source === value.source));
    if (existing && existing.source !== value.source) {
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
    assertActive();
    return document;
  }

  async function open(object, frame = generation, navigation) {
    const { value, epoch } = await inspect((query, context) => loadSource(query, context, object), frame);
    if (navigation?.hash && textHash(value.source) !== navigation.hash) throw Error('The database definition changed. Search again.');
    if (navigation?.settingsHash && textHash(JSON.stringify(value.settings)) !== navigation.settingsHash) {
      throw Error('The database definition settings changed. Search again.');
    }
    const anchor = navigation?.member ? memberLocation(value, navigation.member) : navigation?.span;
    const document = await retainDocument(value, epoch, frame, Boolean(navigation));
    if (anchor && document.getText().replace(/\r\n/g, '\n') !== value.source.replace(/\r\n/g, '\n')) {
      throw Error('The observed database source changed in the editor. Search again.');
    }
    const positions = anchor && sourceRange(value.source, anchor.start, anchor.end);
    const selection = positions ? new vscode.Range(positions.start.line, positions.start.character, positions.end.line, positions.end.character) : undefined;
    await vscode.window.showTextDocument(document, { preview: false, ...(selection && { selection }) });
    check(frame);
    return { ...value, documentUri: document.uri.toString() };
  }

  async function definition({ object, member, sqlMode }, assertActive = () => {}) {
    const frame = generation;
    const { value, epoch } = await inspect((query, context) => loadSource(query, context, object), frame, assertActive);
    const anchor = ddlDefinitionLocation(value, member, sqlMode);
    if (!anchor) return undefined;
    const document = await retainDocument(value, epoch, frame, true, assertActive);
    if (document.getText() !== value.source) throw Error('The database definition changed. Resolve it again.');
    return new vscode.Location(document.uri, new vscode.Range(document.positionAt(anchor.start), document.positionAt(anchor.end)));
  }
  async function columnOrigin(input, assertActive = () => {}) {
    const frame = generation;
    const { traceColumnOrigin, originExplanation } = require('./sql-column-origin');
    const { value, epoch } = await inspect((query, context) => traceColumnOrigin(query, context, input, assertActive), frame, assertActive);
    const { loaded, anchor, ...report } = value;
    const document = await retainDocument(loaded, epoch, frame, true, assertActive);
    if (document.getText() !== loaded.source) throw Error('The database definition changed. Resolve it again.');
    const range = new vscode.Range(document.positionAt(anchor.start), document.positionAt(anchor.end));
    return { ...report, quickExplanation: originExplanation(report), location: new vscode.Location(document.uri, range) };
  }

  async function refresh(uri = vscode.window.activeTextEditor?.document.uri) {
    const current = uri?.scheme === scheme && documents.get(uri.toString());
    if (!current) throw Error('Open the database object source before refreshing it.');
    return open(current.object);
  }

  async function choosePage(load, frame, title, initialChoices = []) {
    let after = '';
    for (;;) {
      const page = await load(after);
      const choices = [...initialChoices, ...page.items.map(item => ({ label: item.name, description: item.kind, item }))];
      if (page.next) choices.push({ label: 'Next page…', next: true });
      if (!choices.length) {
        await vscode.window.showInformationMessage('No matching objects are visible to the current account.');
        return;
      }
      const selected = await vscode.window.showQuickPick(choices, { title });
      check(frame);
      if (!selected || !selected.next) return { item: selected?.item, kinds: page.kinds, action: selected?.action };
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

  const viewImpact = registerViewImpact(vscode, { inspect, check, currentFrame: () => generation });
  const catalogUsages = registerCatalogUsages(vscode, { inspect, check, currentFrame: () => generation, captureFileUsages,
    openRoutine: (hit, frame) => open(hit.object, frame, { hash: hit.sourceSha256, settingsHash: hit.settingsSha256, span: hit }) });
  async function chooseImpactRequest(request, frame) {
    if (request?.target) return request;
    async function schemaPage(after, excluded = []) {
      const page = await list({ kind: 'schema', after }, frame);
      return { ...page, items: page.items.filter(item => isApplicationSchema(item.name) && !excluded.includes(item.name)) };
    }
    let target;
    if (request?.table?.name) {
      target = { schema: database.catalogSnapshot()?.database, name: request.table.name, kind: request.table.kind };
    } else {
      const schema = await choosePage(schemaPage, frame, 'Choose the target schema');
      if (!schema?.item) return;
      const choice = await vscode.window.showQuickPick([
        { label: 'Table', kind: 'table' }, { label: 'View', kind: 'view' }
      ], { title: 'Choose the target relation kind' });
      check(frame);
      if (!choice) return;
      const relation = await choosePage(after => list({ kind: choice.kind, schema: schema.item.name, after }, frame),
        frame, 'Choose the target table or view');
      target = relation?.item;
    }
    if (!target) return;
    const schemas = [target.schema];
    while (schemas.length < viewImpactLimits.schemas) {
      const selected = await choosePage(after => schemaPage(after, schemas), frame,
        'Add a schema to inspect (' + schemas.join(', ') + ')',
        [{ label: 'Inspect selected schemas', action: 'inspect' }]);
      if (selected?.action === 'inspect') break;
      if (!selected?.item) return;
      schemas.push(selected.item.name);
    }
    return { target, schemas };
  }

  async function browseImpact(request) {
    const frame = generation;
    const selected = await chooseImpactRequest(request, frame);
    return selected && viewImpact.open(selected, frame);
  }

  async function browseCatalogUsages(request) {
    const frame = generation;
    if (request?.target) return catalogUsages.capture(request, frame);
    const selected = await chooseImpactRequest(request, frame);
    if (!selected) return;
    if (vscode.workspace.workspaceFolders?.some(folder => folder.uri.scheme === 'file')) {
      const choice = await vscode.window.showQuickPick(['Procedures and local SQL roots', 'Procedures only'], { title: 'Choose usage sources' });
      check(frame);
      if (!choice) return;
      selected.includeFiles = choice === 'Procedures and local SQL roots';
    }
    return catalogUsages.browse(selected, frame);
  }

  function command(id, action) {
    return vscode.commands.registerCommand(id, async argument => {
      try { return await action(argument); }
      catch (error) {
        if (!disposed && !(error instanceof vscode.CancellationError)) {
          await vscode.window.showErrorMessage('Rocketbrain object source: ' + error.message);
        }
      }
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
      viewImpact.invalidate(epoch, mysql);
      catalogUsages.clear();
    }),
    command('rocketbrain.db.openObjectSource', browse),
    command('rocketbrain.db.inspectViewImpact', browseImpact),
    command('rocketbrain.db.findCatalogUsages', browseCatalogUsages),
    command('rocketbrain.db.refreshObjectSource', refresh)
  ];

  return {
    listSchemas: options => list({ ...options, kind: 'schema' }),
    listObjects: options => list(options),
    open,
    viewImpact: { inspect: viewImpact.inspect, open: viewImpact.open },
    catalogUsages: { inspect: catalogUsages.capture, open: catalogUsages.open },
    definition,
    columnOrigin,
    search(options, assertActive = () => {}) {
      return inspect((query, context) => searchDatabaseText(query, context, options, assertActive), generation, assertActive)
        .then(({ value }) => value);
    },
    openSearchResult(result) {
      if (result.type === 'database-ddl') {
        return open(result.object, generation, { hash: result.hash, span: { start: result.start, end: result.end } });
      }
      return open(result.object.owner ?? result.object, generation, result.object.owner ? { member: result.object } : undefined);
    },
    refresh,
    dispose() {
      if (disposed) return;
      disposed = true;
      documents.clear();
      viewImpact.dispose();
      catalogUsages.clear();
      for (const subscription of subscriptions) subscription.dispose();
    }
  };
}

function memberLocation(loaded, member) {
  if (member.kind === 'column') return ddlDefinitionLocation(loaded, member);
  try {
    const options = { dialect: loaded.dialect, sqlMode: String(loaded.settings?.sql_mode ?? '').split(',').filter(Boolean) };
    const tokens = sourceTokens(loaded.source, options);
    let depth = 0;
    for (const [index, token] of tokens.entries()) {
      const previous = tokens[index - 1];
      if (token.kind === 'symbol' && token.value === '(') depth++;
      if (token.kind === 'symbol' && token.value === ')') depth--;
      if (!['word', 'identifier'].includes(token.kind) || token.value !== member.name &&
          !(member.name === 'PRIMARY' && token.upper === 'PRIMARY')) continue;
      const located = member.kind === 'index' && depth === 1 && (['KEY', 'INDEX'].includes(previous?.upper) || token.upper === 'PRIMARY') ||
        member.kind === 'constraint' && depth === 1 && (previous?.upper === 'CONSTRAINT' || token.upper === 'PRIMARY' ||
          ['KEY', 'INDEX'].includes(previous?.upper));
      if (located) return { start: token.start, end: token.end };
    }
  } catch {}
  return undefined;
}

module.exports = { registerObjectSources, memberLocation };
