'use strict';

const { randomBytes, randomUUID } = require('node:crypto');
const { tableInventory, buildDiagram, defaultLayout, normalizeLayout, parseLayout, maxLayoutBytes,
  digest, scopeKey, maxLogical, logicalRelation, logicalEdges } = require('./schema-erd');
const { diagramHtml } = require('./schema-erd-view');

const layoutsKey = 'rocketbrain.schemaDiagram.layouts.v1';
const logicalKey = 'rocketbrain.schemaDiagram.logical.v1';
const maxSavedScopes = 24;
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const pngEnd = Buffer.from([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]);

function parseDiagramPng(value) {
  const maximum = 6 * 1024 * 1024;
  if (typeof value !== 'string' || value.length > maximum * 4 / 3 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error('The diagram PNG could not be exported within 6 MiB.');
  }
  const data = Buffer.from(value, 'base64');
  if (data.length < 45 || !data.subarray(0, 8).equals(pngSignature) || !data.subarray(-12).equals(pngEnd) ||
      data.readUInt32BE(8) !== 13 || data.toString('ascii', 12, 16) !== 'IHDR') throw new Error('The diagram PNG is incomplete.');
  const width = data.readUInt32BE(16), height = data.readUInt32BE(20);
  if (!width || !height || width > 4096 || height > 4096 || data.toString('base64') !== value) {
    throw new Error('The diagram PNG has an unexpected size or encoding.');
  }
  return { data, width, height };
}

function registerSchemaDiagrams(context, vscode, { database }) {
  let frame, panel, epoch, generation = 0, disposed = false, pending, refreshing = false;
  const subscriptions = [];

  function trusted() {
    if (disposed || !vscode.workspace.isTrusted) throw new Error('Open a trusted workspace to use the schema diagram.');
  }

  function getCollection(key) {
    const collection = context.workspaceState.get(key, []);
    if (!Array.isArray(collection) || collection.length > maxSavedScopes) throw new Error('The saved diagram collection has an unsupported format.');
    return collection;
  }

  function getRecord(key, identity) {
    return getCollection(key).find(record => record?.identity === identity);
  }

  async function store(key, identity, value, expectedRevision) {
    const collection = getCollection(key), previous = collection.find(record => record?.identity === identity);
    if (previous?.revision !== expectedRevision) throw new Error('The saved diagram state changed. Reopen the diagram.');
    const next = collection.filter(record => record?.identity !== identity);
    if (value === undefined) {
      if (previous) await context.workspaceState.update(key, next);
      return undefined;
    }
    if (next.length >= maxSavedScopes) throw new Error('The workspace has 24 saved diagram scopes. Clear unused positions or relationships first.');
    const revision = randomUUID(), current = { identity, value, revision };
    await context.workspaceState.update(key, [...next, current]);
    return revision;
  }

  function capture(focus) {
    trusted();
    const catalog = database.catalogSnapshot();
    tableInventory(catalog);
    const profileScope = scopeKey(catalog, database.activeConnectionProfile?.());
    const savedRelations = profileScope ? getRecord(logicalKey, profileScope) : undefined;
    const records = savedRelations?.value || [];
    const diagram = buildDiagram(catalog, { focus, logical: logicalEdges(catalog, records) });
    const layoutScope = digest([profileScope, diagram.identity]);
    const savedLayout = getRecord(layoutsKey, layoutScope), placement = defaultLayout(diagram);
    let layout = placement;
    if (savedLayout) {
      try { layout = normalizeLayout(diagram, savedLayout.value); } catch { /* Older layout entries can be replaced. */ }
    }
    return { token: randomUUID(), epoch, generation, catalog, diagram, layout, placement, layoutScope, profileScope, records,
      layoutRevision: savedLayout?.revision, logicalRevision: savedRelations?.revision };
  }

  function active(token) {
    trusted();
    if (!frame || token !== frame.token || frame.generation !== generation) throw new Error('The catalog changed. Reopen the diagram.');
    return frame;
  }

  function post(message) { void panel?.webview.postMessage(message); }

  function publish(current, keepPositions = false) {
    post({ type: 'diagram', token: current.token, diagram: current.diagram, layout: current.layout, defaultLayout: current.placement,
      keepPositions, logicalAvailable: Boolean(current.profileScope) });
  }

  function status(token, text) {
    if (frame?.token === token) post({ type: 'status', token, text });
  }

  function exclusive(action) {
    trusted();
    if (pending) throw new Error('Finish the current diagram action first.');
    const work = Promise.resolve().then(action);
    pending = work;
    return work.finally(() => { if (pending === work) pending = undefined; });
  }

  async function selectFocus(initial, allowPrompt) {
    try { return capture(initial); }
    catch (error) {
      if (!allowPrompt || initial !== undefined || error.code !== 'ROCKETBRAIN_DIAGRAM_SIZE') throw error;
      const ticket = generation;
      const catalog = database.catalogSnapshot();
      const selected = await vscode.window.showQuickPick(tableInventory(catalog).map(table => table.name),
        { title: 'Select an entity and its immediate relationships' });
      if (selected === undefined) return;
      if (ticket !== generation) throw new Error('The catalog changed while selecting a diagram.');
      return capture(selected);
    }
  }

  async function openDiagram({ focus, allowPrompt = false } = {}) {
    return exclusive(async () => {
      const current = await selectFocus(focus, allowPrompt);
      if (!current) return;
      trusted();
      if (current.generation !== generation) throw new Error('The catalog changed while opening the diagram.');
      frame = current;
      if (!panel) {
        panel = vscode.window.createWebviewPanel('rocketbrain.schemaDiagram', 'Schema Diagram', vscode.ViewColumn.One, {
          enableScripts: true, retainContextWhenHidden: true, localResourceRoots: []
        });
        const shown = panel;
        const messages = shown.webview.onDidReceiveMessage(message => receive(message, shown));
        shown.onDidDispose(() => {
          messages.dispose();
          if (panel === shown) { panel = undefined; frame = undefined; }
        });
        shown.webview.html = diagramHtml(randomBytes(24).toString('hex'));
      } else { panel.reveal?.(); publish(current); }
      return { token: current.token, diagram: structuredClone(current.diagram), layout: structuredClone(current.layout) };
    });
  }

  async function saveLayout(token, next) {
    const current = active(token);
    if (!vscode.workspace.workspaceFile && !vscode.workspace.workspaceFolders?.length) throw new Error('Open a workspace or folder before saving diagram positions.');
    const layout = normalizeLayout(current.diagram, next);
    const customized = JSON.stringify(layout) !== JSON.stringify(current.placement);
    current.layoutRevision = await store(layoutsKey, current.layoutScope, customized ? layout : undefined, current.layoutRevision);
    current.layout = layout;
    status(token, 'Layout saved in this workspace');
    return structuredClone(layout);
  }

  function layoutDocument(token, layout) {
    const current = active(token);
    return Buffer.from(JSON.stringify(normalizeLayout(current.diagram, layout), null, 2) + '\n');
  }

  function importLayout(token, bytes) {
    const layout = parseLayout(active(token).diagram, bytes);
    post({ type: 'layout', token, layout });
    return structuredClone(layout);
  }

  async function exportLayoutFile(token, layout) {
    const body = layoutDocument(token, layout);
    const target = await vscode.window.showSaveDialog({ filters: { 'Diagram layout': ['json'] } });
    if (!target) return;
    active(token);
    await vscode.workspace.fs.writeFile(target, body);
    status(token, 'Layout exported');
  }

  async function importLayoutFile(token) {
    const sources = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'Diagram layout': ['json'] } });
    if (!sources?.length) return;
    active(token);
    const source = sources[0];
    if ((await vscode.workspace.fs.stat(source)).size > maxLayoutBytes) throw new Error('Choose a diagram layout of at most 64 KiB.');
    const body = await vscode.workspace.fs.readFile(source);
    return importLayout(token, body);
  }

  async function exportPng(token, image) {
    const { data, width, height } = parseDiagramPng(image);
    const target = await vscode.window.showSaveDialog({ filters: { 'PNG image': ['png'] } });
    if (!target) return;
    active(token);
    await vscode.workspace.fs.writeFile(target, data);
    status(token, 'PNG exported · ' + width + ' × ' + height);
  }

  async function refresh(current) {
    refreshing = true;
    try {
      await database.refreshSchema();
      trusted();
      if (epoch !== current.epoch || !panel) throw new Error('The database connection changed. Reopen the diagram.');
      frame = capture(current.diagram.focus || undefined);
      publish(frame, true);
    } finally { refreshing = false; }
  }

  async function saveRelations(token, records) {
    const current = active(token);
    if (!current.profileScope) throw new Error('Choose a saved connection profile to store logical relationships.');
    if (!vscode.workspace.workspaceFile && !vscode.workspace.workspaceFolders?.length) throw new Error('Open a workspace or folder to store logical relationships.');
    buildDiagram(current.catalog, { focus: current.diagram.focus || undefined, logical: logicalEdges(current.catalog, records) });
    current.logicalRevision = await store(logicalKey, current.profileScope, records.length ? records : undefined, current.logicalRevision);
    active(token);
    frame = capture(current.diagram.focus || undefined);
    publish(frame, true);
    return { token: frame.token, diagram: structuredClone(frame.diagram) };
  }

  function addRelation(token, input) {
    const current = active(token);
    if (!current.profileScope) throw new Error('Choose a saved connection profile to store logical relationships.');
    if (current.records.length >= maxLogical) throw new Error('Remove a logical relationship before adding another.');
    const value = logicalRelation(current.catalog, { ...input, id: randomUUID(), name: input.name?.trim() });
    const records = [...current.records, value];
    if (!logicalEdges(current.catalog, records).some(edge => edge.id === value.id)) throw new Error('The same relationship is already present.');
    return saveRelations(token, records);
  }

  function removeRelation(token, id) {
    const current = active(token);
    if (!current.records.some(record => record?.id === id)) throw new Error('The logical relationship changed. Open the list again.');
    return saveRelations(token, current.records.filter(record => record?.id !== id));
  }

  async function chooseRelation(current) {
    const pick = (choices, title) => vscode.window.showQuickPick(choices, { title, ignoreFocusOut: true });
    const actions = [{ label: 'Add Logical Relationship', add: true }, ...current.records.map(record => ({
      label: 'Remove ' + record.name, description: record.child + ' → ' + record.parent, id: record.id
    }))];
    const action = await pick(actions, 'Logical Relationships');
    if (!action) return;
    if (action.id) {
      const accepted = await vscode.window.showWarningMessage('Remove this workspace relationship?', { modal: true }, 'Remove Relationship');
      if (accepted === 'Remove Relationship') await removeRelation(current.token, action.id);
      return;
    }
    const tables = current.diagram.nodes.filter(node => node.kind === 'table');
    const child = await pick(tables.map(node => node.name), 'Choose child table');
    if (!child) return;
    const parent = await pick(tables.map(node => node.name), 'Choose referenced table');
    if (!parent) return;
    const childColumns = tables.find(node => node.name === child).columns.map(col => col.name);
    const parentColumns = tables.find(node => node.name === parent).columns.map(col => col.name);
    const pairs = [];
    while (pairs.length < 8 && childColumns.length && parentColumns.length) {
      const from = await pick(childColumns, 'Choose child column');
      if (!from) return;
      const to = await pick(parentColumns, 'Choose referenced column');
      if (!to) return;
      pairs.push({ child: from, parent: to });
      childColumns.splice(childColumns.indexOf(from), 1); parentColumns.splice(parentColumns.indexOf(to), 1);
      if (pairs.length < 8 && childColumns.length && parentColumns.length) {
        const next = await pick(['Name and Save', 'Add Another Column Pair'], 'Logical Relationship Columns');
        if (!next) return;
        if (next === 'Name and Save') break;
      }
    }
    const name = await vscode.window.showInputBox({ title: 'Name Logical Relationship',
      prompt: 'Stores a workspace annotation for this connection. The database schema stays unchanged.', ignoreFocusOut: true });
    if (name !== undefined) await addRelation(current.token, { name, child, parent, pairs });
  }

  async function receive(message, shown) {
    if (disposed || !message || typeof message.type !== 'string' || shown !== panel) return;
    if (message.type === 'ready') { if (frame) publish(frame); return; }
    try {
      await exclusive(async () => {
        const current = active(message.token);
        switch (message.type) {
          case 'refresh': return refresh(current);
          case 'saveLayout': return saveLayout(current.token, message.layout);
          case 'exportLayout': return exportLayoutFile(current.token, message.layout);
          case 'importLayout': return importLayoutFile(current.token);
          case 'exportPng': return exportPng(current.token, message.image);
          case 'logical': return chooseRelation(current);
          case 'openTable':
            if (current.diagram.nodes.some(node => node.kind === 'table' && node.name === message.name)) {
              return vscode.commands.executeCommand('rocketbrain.openTable', message.name);
            }
        }
      });
    } catch (error) {
      if (message.type === 'refresh' && !frame) post({ type: 'stale', text: error.message });
      else status(message.token, error.message);
    }
  }

  subscriptions.push(database.onDidChangeDatabase(event => {
    epoch = event.epoch;
    generation++;
    frame = undefined;
    if (!refreshing) post({ type: 'stale', text: 'The connection or catalog changed. Reopen Schema Diagram.' });
  }));
  subscriptions.push(vscode.commands.registerCommand('rocketbrain.schema.diagram', async item => {
    try { return await openDiagram({ focus: item?.table?.name, allowPrompt: true }); }
    catch (error) { if (!disposed) await vscode.window.showErrorMessage('Rocketbrain Diagram: ' + error.message); }
  }));

  return { openDiagram, saveLayout: (token, layout) => exclusive(() => saveLayout(token, layout)), layoutDocument, importLayout,
    addRelation: (token, input) => exclusive(() => addRelation(token, input)),
    removeRelation: (token, id) => exclusive(() => removeRelation(token, id)),
    async dispose() {
      if (disposed) return;
      disposed = true;
      for (const subscription of subscriptions) subscription.dispose();
      panel?.dispose();
      await pending?.catch(() => {});
    } };
}

module.exports = { registerSchemaDiagrams, parseDiagramPng };
