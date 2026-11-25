'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createMetadataCache, observeCatalogIdentity, storageKey, limits } = require('../src/db/metadata-cache');

const route = value => createHash('sha256').update(value).digest('hex');
const one = route('configuration'), actualAccount = route('actual account / server'),
  differentAccount = route('another actual account / server');
const source = () => ({
  scope: 'database', database: 'app', dialect: 'mysql', serverVersion: '8.4.13-custom.local-secret-host',
  visibility: 'current-account', semanticContextObserved: true, tableNameCaseSensitive: false,
  sqlMode: ['ANSI_QUOTES', 'STRICT_TRANS_TABLES'], coverage: { tables: 'loaded', columns: 'loaded' },
  tables: [{ name: 'people', kind: 'table', engine: 'InnoDB', createSql: 'CREATE TABLE sensitive_definition_text',
    comment: 'private_table_comment', columns: [
      { name: 'id', type: 'BIGINT(20) UNSIGNED', nullable: false, primaryKey: true, defaultValue: 'private_default' },
      { name: 'status', type: "enum('private_enum_value')", nullable: true, primaryKey: false, comment: 'private_column_comment' }
    ], indexes: [{ name: 'hidden_index_private' }], foreignKeys: [] }],
  views: [],
  routines: [{ name: 'private_routine', body: 'SELECT 1' }]
});
const current = () => true;
function store() {
  const data = new Map();
  return { data, get: key => structuredClone(data.get(key)), async update(key, value) { data.set(key, structuredClone(value)); } };
}
const options = { isTrusted: current, now: () => '2026-11-25T07:20:00.000Z' };

test('the durable cache contains only bounded structural metadata and reopens with explicit offline provenance', async () => {
  const state = store(), cache = createMetadataCache(state, options);
  const saved = await cache.capture(one, actualAccount, source(), current);
  const raw = JSON.stringify([...state.data.values()]);
  for (const privateField of ['custom.local-secret-host', 'private_default', 'private_enum_value', 'private_table_comment',
    'private_column_comment', 'hidden_index_private', 'private_routine', 'sensitive_definition_text']) {
    assert.ok(!raw.includes(privateField), privateField);
  }
  const restarted = createMetadataCache(state, options);
  assert.deepEqual(restarted.list(), [saved]);
  const opened = restarted.open(one, saved.fingerprint);
  assert.equal(opened.catalog.complete, false);
  assert.deepEqual(opened.catalog.coverage, {});
  assert.equal(opened.catalog.visibility, 'cached-current-account');
  assert.deepEqual(opened.catalog.cachedMetadata, saved);
  assert.deepEqual(opened.catalog.tables[0].columns.map(column => column.type), ['bigint(20) unsigned', 'enum']);
  assert.equal(opened.catalog.tables[0].columns[0].primaryKey, true);
  assert.equal(opened.catalog.serverVersion, '8.4.13');
  opened.catalog.tables[0].columns[0].name = 'tampered_local_result';
  assert.equal(restarted.open(one).catalog.tables[0].columns[0].name, 'id');
});

test('online verification preserves the capture time and invalidates changed structure, version or matched account', async () => {
  const state = store();
  let clock = '2026-11-25T07:20:00.000Z';
  const cache = createMetadataCache(state, { ...options, now: () => clock });
  const capture = () => cache.capture(one, actualAccount, source(), current);
  const saved = await capture();
  clock = '2026-11-25T07:30:00.000Z';
  assert.equal(await cache.revalidate(one, actualAccount, source(), current), 'matched');
  const verified = cache.open(one).provenance;
  assert.equal(verified.fingerprint, saved.fingerprint);
  assert.equal(verified.capturedAt, saved.capturedAt);
  assert.equal(verified.checkedAt, clock);
  assert.equal(await cache.revalidate(one, differentAccount, source(), current), 'invalidated');
  assert.equal(cache.has(one), false);
  await capture();
  assert.equal(await cache.revalidate(one, actualAccount, { ...source(), serverVersion: '8.4.14' }, current), 'invalidated');
  await capture();
  const changed = source();
  changed.tables[0].columns[0].name = 'renamed_id';
  assert.equal(await cache.revalidate(one, actualAccount, changed, current), 'invalidated');
  assert.throws(() => cache.open(one, saved.fingerprint), /Choose the current/);
  const other = await cache.capture(route('other connection'), actualAccount, source(), current);
  await capture();
  assert.equal(await cache.revalidate(one, differentAccount, source(), () => false), 'unverified');
  assert.equal(cache.has(one), true);
  await cache.remove(other.id, other.fingerprint);
  assert.equal(cache.list().length, 1);
});

test('offline storage refuses malformed entries, incomplete scope, stale mutations and trust loss', async () => {
  const state = store();
  let trust = true;
  const cache = createMetadataCache(state, { ...options, isTrusted: () => trust });
  const item = await cache.capture(one, actualAccount, source(), current);
  await assert.rejects(cache.capture(route('stale'), actualAccount, source(), () => false), /changed/);
  await assert.rejects(cache.capture(route('limited'), actualAccount, { ...source(), scope: 'table' }, current), /Refresh visible/);
  await assert.rejects(cache.remove(item.id, route('wrong fingerprint')), /Choose the current/);
  trust = false;
  assert.throws(() => cache.list(), /Trust/);
  trust = true;
  const corrupt = state.get(storageKey);
  corrupt.entries[0].catalog.tables[0].columns[0].name = 'on_disk_mutation';
  await state.update(storageKey, corrupt);
  assert.deepEqual(cache.list(), []);
});

test('serialized cache writes enforce entry limits and preserve the most recent complete scopes', async () => {
  const state = store(), cache = createMetadataCache(state, options);
  await Promise.all(Array.from({ length: limits.entries + 2 }, (_, index) =>
    cache.capture(route(String(index)), actualAccount, { ...source(), database: 'schema' + index }, current)));
  assert.equal(cache.list().length, limits.entries);
  assert.equal(cache.list()[0].database, 'schema' + (limits.entries + 1));
  assert.ok(!cache.has(route('0')));
  assert.ok(!cache.has(route('1')));
  const oversized = { ...source(), tables: Array.from({ length: limits.objects + 1 }, (_, index) => ({
    name: 'table_' + index, kind: 'table', columns: []
  })) };
  await assert.rejects(cache.capture(route('large'), actualAccount, oversized, current), /supported table and column catalog/);
});

test('the cache hashes observed server and account identity using the selected dialect and exact schema', async () => {
  const seen = [];
  const db = { async _metadataQuery(sql) {
    seen.push(sql);
    return { rows: sql.startsWith('SELECT CURRENT_USER') ? [['fixture@origin', 'app']] : [['observed-server-uuid']] };
  }};
  const key = await observeCatalogIdentity(db, source());
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.deepEqual(seen, ['SELECT CURRENT_USER(), DATABASE()', 'SELECT @@server_uuid']);
  await observeCatalogIdentity(db, { ...source(), dialect: 'mariadb' });
  assert.equal(seen.at(-1), 'SELECT @@server_uid');
  await assert.rejects(observeCatalogIdentity(db, { ...source(), database: 'other' }), /changed/);
});
