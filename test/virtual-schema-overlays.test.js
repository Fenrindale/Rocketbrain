'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createOverlayStore, overlayScope, buildOverlay } = require('../src/db/virtual-schema-overlays');
const { analyzeDdlScript } = require('../src/db/ddl-model');

const catalog = {
  database: 'workspace_db', dialect: 'mysql', semanticContextObserved: true,
  coverage: { tables: 'loaded', columns: 'loaded' }, sqlMode: [], tableNameCaseSensitive: true,
  tables: [{ kind: 'table', name: 'people', columns: [
    { name: 'id', type: 'int', nullable: false },
    { name: 'external_key', type: 'int', nullable: false, extra: 'auto_increment' }
  ] }],
  views: []
};
const route = { connection: 'a'.repeat(64), database: catalog.database };
const scope = overlayScope(route, catalog);
const defs = 'ALTER TABLE people ADD COLUMN doubled DECIMAL(22, 4) GENERATED ALWAYS AS (id * 2) VIRTUAL;' +
  ' CREATE VIEW proposed AS SELECT p.doubled, x.caption FROM people p JOIN related.notes_view x ON x.id = p.id;';
const source = { label: 'Proposal', source: defs };
const foreign = { schema: 'related', name: 'notes_view', kind: 'view', columns: [
  { name: 'id', type: 'int', nullable: false },
  { name: 'caption', type: 'varchar(32)', nullable: true }
] };

test('saved overlays are local, revisioned and scoped to the exact active database account route', async () => {
  let data, trusted = true;
  const storage = { get: () => data, async update(_key, next) { data = structuredClone(next); } };
  const first = createOverlayStore(storage, () => trusted);
  const saved = await first.save(scope, source, () => {});
  const reopened = createOverlayStore(storage, () => trusted);
  assert.deepEqual(reopened.list(scope), [saved]);
  assert.deepEqual(reopened.read(scope, saved.id), { ...saved, source: defs });
  const other = overlayScope({ ...route, connection: 'b'.repeat(64) }, catalog);
  assert.deepEqual(reopened.list(other), []);
  assert.throws(() => reopened.read(other, saved.id), /unavailable for this database/);
  assert.throws(() => overlayScope(route, { ...catalog, cachedMetadata: {} }), /complete visible catalog/);
  const edited = await reopened.save(scope, { ...saved, ...source, label: 'Revision' }, () => {});
  assert.equal(edited.revision, 2);
  await assert.rejects(reopened.remove(scope, saved.id, 1, () => {}), /changed or is unavailable/);
  await assert.rejects(reopened.save(scope, { ...edited, ...source }, () => { throw Error('scope changed'); }), /scope changed/);
  trusted = false;
  assert.throws(() => reopened.read(scope, saved.id), /Trust the workspace/);
  trusted = true;
  assert.equal(await reopened.remove(scope, saved.id, 2, () => {}), true);
  assert.deepEqual(createOverlayStore(storage, () => true).list(scope), []);
});

test('an additive overlay binds generated columns and exact external view dependencies without mutating its seed', async () => {
  const report = await buildOverlay(source, catalog, { async loadForeign(scope) {
    assert.deepEqual(scope, { endpoints: [{ schema: 'related', table: 'notes_view' }], includeEdges: false });
    return { tables: [foreign] };
  } });
  assert.equal(catalog.tables[0].columns.length, 2);
  assert.deepEqual(catalog.views, []);
  assert.deepEqual(report.externalInputs, [{ schema: 'related', name: 'notes_view', kind: 'view' }]);
  assert.deepEqual(report.model.views[0].externalDependencies, [{ schema: 'related', table: 'notes_view' }]);
  assert.equal(report.model.tables[0].columns[2].generationExpression, 'id * 2');
  assert.equal(report.model.tables[0].columns[2].extra, 'VIRTUAL GENERATED');
  const projected = analyzeDdlScript('SELECT v.doubled, v.caption FROM proposed v', report.model);
  assert.equal(projected.state, 'known');
  assert.deepEqual(projected.statements[0].model.projections.map(p => p.type.dbType.toLowerCase()), ['decimal(22,4)', 'varchar(32)']);
});

test('unsafe overlays fail before saving, and missing or changed foreign metadata does not bind', async () => {
  const build = (source, options) => buildOverlay({ label: 'blocked', source }, catalog, options);
  await assert.rejects(build('DROP TABLE people'), /accept CREATE VIEW and ALTER TABLE ADD COLUMN/);
  await assert.rejects(build('CREATE OR REPLACE VIEW proposed AS SELECT id FROM people'), /accept CREATE VIEW/);
  await assert.rejects(build('SELECT id FROM people'), /contains only CREATE VIEW/);
  await assert.rejects(build('ALTER TABLE people ADD a INT, ADD b INT'), /one additive column/);
  await assert.rejects(build('ALTER TABLE people ADD id INT'), /distinct simple appended column/);
  await assert.rejects(build('ALTER TABLE people ADD x INT AS (external_key * 2)'), /without AUTO_INCREMENT/);
  await assert.rejects(build('ALTER TABLE people ADD x INT AS (sleep(1))'), /earlier signed numeric base columns/);
  await assert.rejects(build('ALTER TABLE people ADD x INT AS (missing)'), /earlier signed numeric base columns/);
  await assert.rejects(build('ALTER TABLE people ADD x INT AS (id * 2) PERSISTENT'), /Use STORED or VIRTUAL/);
  await assert.rejects(build(defs, { loadForeign: async () => ({ tables: [] }) }), /External view input related.notes_view is unavailable/);
  let stale = false;
  await assert.rejects(build(defs, { loadForeign: async () => { stale = true;return { tables: [foreign] }; },
    assertCurrent: () => { if (stale) throw Error('Catalog switched.'); } }), /Catalog switched/);
});
