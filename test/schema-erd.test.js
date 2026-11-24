'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDiagram, defaultLayout, parseLayout, normalizeLayout, logicalEdges, logicalRelation, scopeKey } = require('../src/db/schema-erd');
const { registerSchemaDiagrams, parseDiagramPng } = require('../src/db/schema-erd-vscode');

const column = (name, primaryKey = false) => ({ name, type: 'int', primaryKey, nullable: false, defaultValue: 'excluded default' });
const parent = { name: 'parent', kind: 'table', columns: [column('pk1', true), column('pk2', true)] };
const child = { name: 'child', kind: 'table', columns: [column('left'), column('right'), column('other')], foreignKeys: [
  { name: 'parent_fk', referencedSchema: 'example', referencedTable: 'parent', onDelete: 'CASCADE', columns: [
    { name: 'right', referencedColumn: 'pk2', ordinal: 2 }, { name: 'left', referencedColumn: 'pk1', ordinal: 1 }
  ] },
  { name: 'outside_fk', referencedSchema: 'outside', referencedTable: 'parent', columns: [
    { name: 'left', referencedColumn: 'pk1', ordinal: 1 }
  ] }
] };
const unrelated = { name: 'other', kind: 'table', columns: [column('id')] };
const diagramCatalog = { database: 'example', tableNameCaseSensitive: true, coverage: { foreignKeys: 'loaded' },
  tables: [unrelated, child, parent, { ...parent, name: '__rb_hidden' }], views: [{ ...parent, name: 'snapshot_view', kind: 'view' }] };

test('visible diagram keeps ordered composite foreign keys and reports outside targets explicitly', () => {
  const model = buildDiagram(diagramCatalog);
  assert.deepEqual(model.nodes.map(node => node.name), ['child', 'other', 'parent', 'snapshot_view']);
  assert.equal(model.accountLimited, true);
  assert.equal(model.foreignKeysLoaded, true);
  assert.equal(JSON.stringify(model).includes('excluded default'), false);
  const inner = model.edges.find(edge => edge.name === 'parent_fk');
  assert.deepEqual(inner.pairs, [{ child: 'left', parent: 'pk1' }, { child: 'right', parent: 'pk2' }]);
  assert.equal(inner.parentInDiagram, true);
  assert.equal(inner.onDelete, 'CASCADE');
  const boundary = model.edges.find(edge => edge.name === 'outside_fk');
  assert.equal(boundary.parentInDiagram, false);
  assert.equal(boundary.parentSchema, 'outside');
  assert.deepEqual(buildDiagram(diagramCatalog, { focus: 'parent' }).nodes.map(node => node.name), ['child', 'parent']);
  assert.equal(buildDiagram({ ...diagramCatalog, coverage: { foreignKeys: 'unavailable' } }).edges.length, 0);
});

test('diagram bounds permit focused neighborhoods when the full visible schema exceeds the entity limit', () => {
  const catalog = { ...diagramCatalog, tables: [...diagramCatalog.tables,
    ...Array.from({ length: 65 }, (_, index) => ({ ...unrelated, name: 'unrelated_' + index }))] };
  assert.throws(() => buildDiagram(catalog), { code: 'ROCKETBRAIN_DIAGRAM_SIZE' });
  assert.deepEqual(buildDiagram(catalog, { focus: 'parent' }).nodes.map(node => node.name), ['child', 'parent']);
});

test('diagram placement and strict layout exchange are deterministic and profile keys omit endpoints', () => {
  const model = buildDiagram(diagramCatalog), layout = defaultLayout(model);
  assert.deepEqual(defaultLayout(buildDiagram({ ...diagramCatalog, tables: [...diagramCatalog.tables].reverse() })), layout);
  const alternative = { ...structuredClone(layout), positions: [...layout.positions].reverse() };
  assert.deepEqual(parseLayout(model, Buffer.from(JSON.stringify(alternative))), layout);
  assert.throws(() => parseLayout(model, Buffer.from([255, 255])), /UTF-8 JSON/);
  assert.throws(() => normalizeLayout(model, { ...layout, diagram: 'other' }), /same visible diagram/);
  assert.throws(() => normalizeLayout(model, { ...layout, positions: layout.positions.map(item => ({ ...item, x: -5 })) }), /invalid entity position/);
  assert.throws(() => normalizeLayout(model, { ...layout, positions: [...layout.positions.slice(0, -1), layout.positions[0]] }), /invalid entity position/);
  const profile = { id: 'profile-1', host: 'private.example', database: 'example', port: 3306 };
  const key = scopeKey(diagramCatalog, profile);
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.notEqual(scopeKey(diagramCatalog, { ...profile, port: 4306 }), key);
  assert.equal(scopeKey(diagramCatalog, { ...profile, database: 'elsewhere' }), null);
});

test('logical edges keep workspace mapping and skip missing and physical duplicates', () => {
  const logical = { id: 'logical-1', name: 'User mapped', child: 'child', parent: 'parent', pairs: [{ child: 'other', parent: 'pk2' }] };
  assert.deepEqual(logicalRelation(diagramCatalog, logical), logical);
  const duplicate = { ...logical, id: 'duplicate', pairs: [{ child: 'right', parent: 'pk2' }, { child: 'left', parent: 'pk1' }] };
  const stale = { ...logical, id: 'stale', pairs: [{ child: 'gone', parent: 'pk1' }] };
  const values = logicalEdges(diagramCatalog, [duplicate, stale, logical]);
  assert.deepEqual(values.map(edge => [edge.id, edge.kind]), [['logical-1', 'logical']]);
  assert.equal(buildDiagram(diagramCatalog, { logical: values }).edges.filter(edge => edge.kind === 'physical').length, 2);
  assert.throws(() => logicalRelation(diagramCatalog, { ...logical, pairs: [...logical.pairs, ...logical.pairs] }), /distinct visible columns/);
});

test('diagram API persists layout and logical profile scope while rejecting stale diagram actions', async () => {
  const stored = new Map(), messages = [];
  let onCatalog, receive, profile = { id: 'profile-1', host: 'private.example', database: 'example', port: 3306 };
  function stubDisposable() { return { dispose() {} }; }
  const database = {
    catalogSnapshot: () => diagramCatalog, activeConnectionProfile: () => profile,
    onDidChangeDatabase(callback) { onCatalog = callback; return stubDisposable(); },
    async refreshSchema() { onCatalog({ epoch: 1 }); }
  };
  const vscode = {
    workspace: { isTrusted: true, workspaceFolders: [{}] },
    commands: { registerCommand: stubDisposable }, ViewColumn: { One: 1 },
    window: { createWebviewPanel(type) {
      assert.equal(type, 'rocketbrain.schemaDiagram');
      return {
        webview: {
          onDidReceiveMessage(callback) { receive = callback; return stubDisposable(); },
          postMessage(message) { messages.push(message); }
        },
        onDidDispose: stubDisposable, dispose() {}
      };
    } }
  };
  const tools = registerSchemaDiagrams({
    workspaceState: { get: (key, fallback) => stored.get(key) ?? fallback, async update(key, value) { stored.set(key, structuredClone(value)); } }
  }, vscode, { database });
  onCatalog({ epoch: 1 });
  const opened = await tools.openDiagram();
  await receive({ type: 'ready' });
  assert.equal(messages[0].diagram.identity, opened.diagram.identity);
  opened.layout.positions[0].x += 44;
  await tools.saveLayout(opened.token, opened.layout);
  assert.deepEqual(tools.importLayout(opened.token, tools.layoutDocument(opened.token, opened.layout)), opened.layout);
  const withRelation = await tools.addRelation(opened.token, { name: 'Local relation', child: 'child', parent: 'parent',
    pairs: [{ child: 'other', parent: 'pk2' }] });
  const local = withRelation.diagram.edges.find(edge => edge.kind === 'logical');
  assert.ok(local);
  const reopened = await tools.openDiagram();
  assert.deepEqual(reopened.layout, opened.layout);
  assert.ok(reopened.diagram.edges.some(edge => edge.id === local.id));
  await receive({ type: 'refresh', token: reopened.token });
  const refreshed = messages.at(-1);
  assert.equal(refreshed.type, 'diagram');
  assert.notEqual(refreshed.token, reopened.token);
  assert.equal(refreshed.keepPositions, true);
  assert.deepEqual(refreshed.layout, opened.layout);
  const persisted = JSON.stringify([...stored]);
  assert.equal(persisted.includes(profile.host), false);
  assert.equal(persisted.includes(profile.id), false);
  onCatalog({ epoch: 2 });
  assert.equal(messages.at(-1).type, 'stale');
  await assert.rejects(tools.saveLayout(refreshed.token, reopened.layout), /catalog changed/i);
  profile = { ...profile, port: 3307 };
  const another = await tools.openDiagram();
  assert.notDeepEqual(another.layout, opened.layout);
  assert.equal(another.diagram.edges.some(edge => edge.kind === 'logical'), false);
  await tools.dispose();
});

test('PNG payload validator rejects unframed or malformed messages', () => {
  for (const bad of ['', 'not%base64', Buffer.alloc(64).toString('base64')]) {
    assert.throws(() => parseDiagramPng(bad), /PNG/);
  }
});
