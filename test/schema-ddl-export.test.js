'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSnapshot } = require('../src/db/schema-diff');
const { buildDdlExport } = require('../src/db/schema-ddl-export');
const { registerSchemaDdlExport } = require('../src/db/schema-ddl-export-vscode');

const state = { dialect: 'mysql', version: '8.4.13', serverUniqueId: 'private-uuid',
  hostname: 'private-host', port: 3306, serverId: 1, currentUser: 'private-account',
  database: 'fixture', sqlMode: '', tableNameCaseSensitive: true };
const loaded = Object.fromEntries(['tables', 'columns', 'indexes', 'foreignKeys', 'checks', 'partitions', 'definitions'].map(area => [area, 'loaded']));
const columns = [{ name: 'id', type: 'int', nullable: false, ordinal: 1 }];
const table = (name, createSql, foreignKeys = []) => ({ name, kind: 'table', engine: 'InnoDB', createSql, columns, foreignKeys });
const view = (name, definition) => ({ name, kind: 'view', columns,
  createSql: 'CREATE ALGORITHM=UNDEFINED DEFINER=`fixture`@`localhost` SQL SECURITY DEFINER VIEW `' + name + '` AS ' + definition });
const fk = (name, referencedTable, referencedSchema = 'fixture') => ({ name, referencedSchema, referencedTable,
  columns: [{ name: 'id', referencedColumn: 'id' }] });
const base = 'CREATE TABLE `zz_parent` (\n  `id` int NOT NULL AUTO_INCREMENT,\n  `note` varchar(40) DEFAULT \'AUTO_INCREMENT=700; x\',\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB';
const child = table('aa_child', 'CREATE TABLE `aa_child` (\n  `id` int NOT NULL,\n  CONSTRAINT `fk_parent` FOREIGN KEY (`id`) REFERENCES `zz_parent` (`id`) ON DELETE CASCADE\n) ENGINE=InnoDB', [fk('fk_parent', 'zz_parent')]);
const parent = counter => table('zz_parent', base + (counter ? ' AUTO_INCREMENT=' + counter : '') + ' DEFAULT CHARSET=utf8mb4');
const leaf = view('a_leaf', 'select `id` AS `id` from `z_relay` WITH CASCADED CHECK OPTION');
const relay = view('z_relay', 'select `id` AS `id` from `aa_child`');

function snapshot(objects, { server = state, scope = { kind: 'database', tables: [] }, coverage = loaded } = {}) {
  return normalizeSnapshot({ format: 'RocketbrainSchemaSnapshot', formatVersion: 1,
    database: server.database, server, scope, coverage, tables: objects }, { verifyFingerprint: false });
}

test('DDL is stable, ordered and preserves column/default/view source text', () => {
  const left = buildDdlExport(snapshot([leaf, relay, child, parent(13)]));
  const right = buildDdlExport(snapshot([parent(1337), child, relay, leaf]));
  const noCounter = buildDdlExport(snapshot([leaf, relay, child, parent(0)]));
  assert.equal(left.sql, right.sql);
  assert.equal(left.sql, noCounter.sql);
  assert.equal(left.fingerprint, right.fingerprint);
  assert.equal(left.state, 'account-visible-scope');
  assert.equal(left.executedSql, false);
  assert.equal(left.rowDataIncluded, false);
  assert.deepEqual(left.statements.map(entry => [entry.kind, entry.name]), [
    ['table', 'zz_parent'], ['table', 'aa_child'], ['foreignKey', 'fk_parent'], ['view', 'z_relay'], ['view', 'a_leaf']
  ]);
  assert.match(left.statements[0].sql, /DEFAULT 'AUTO_INCREMENT=700; x'/);
  assert.doesNotMatch(left.statements[0].sql, /ENGINE=InnoDB AUTO_INCREMENT/);
  assert.doesNotMatch(left.statements[1].sql, /CONSTRAINT|REFERENCES/);
  assert.match(left.statements[2].sql, /^ALTER TABLE `aa_child` ADD CONSTRAINT `fk_parent`/);
  assert.match(left.statements[4].sql, /WITH CASCADED CHECK OPTION$/);
  assert.doesNotMatch(left.sql, /private-host|private-uuid|private-account/);
});

test('cycles and self FKs use a post-table constraint phase', () => {
  const cyclic = (name, target) => table(name,
    'CREATE TABLE `' + name + '` (`id` int NOT NULL, PRIMARY KEY (`id`), CONSTRAINT `fk_' + name +
    '` FOREIGN KEY (`id`) REFERENCES `' + target + '` (`id`)) ENGINE=InnoDB', [fk('fk_' + name, target)]);
  const report = buildDdlExport(snapshot([cyclic('a', 'b'), cyclic('b', 'a'), cyclic('self', 'self')]));
  assert.deepEqual(report.statements.map(entry => entry.kind), ['table', 'table', 'table', 'foreignKey', 'foreignKey', 'foreignKey']);
  assert.deepEqual(report.omitted, []);
  assert.doesNotMatch(report.sql, /FOREIGN_KEY_CHECKS\b/);
});

test('missing, cross-schema, unavailable and mismatched dependencies are labeled instead of published', () => {
  const source = table('remote_child', 'CREATE TABLE `remote_child` (`id` int, CONSTRAINT `remote` FOREIGN KEY (`id`) REFERENCES `another`.`p` (`id`)) ENGINE=InnoDB',
    [fk('remote', 'p', 'another')]);
  const mismatch = table('mismatch', 'CREATE TABLE `mismatch` (`id` int, CONSTRAINT `bad` FOREIGN KEY (`id`) REFERENCES `zz_parent` (`id`)) ENGINE=InnoDB');
  const report = buildDdlExport(snapshot([child, leaf, relay, source, mismatch, table('hidden', '')],
    { coverage: { ...loaded, definitions: 'unavailable' } }));
  assert.equal(report.state, 'partial');
  assert.equal(report.statements.length, 0);
  assert.deepEqual(report.omitted.map(item => item.name), ['a_leaf', 'aa_child', 'hidden', 'mismatch', 'remote_child', 'z_relay']);
  assert.match(report.sql, /Required definition missing from the export: `another`\.`p`/);
  assert.match(report.sql, /Foreign key metadata does not match/);
  assert.match(report.sql, /Unavailable metadata definitions/);
  assert.doesNotMatch(report.sql, /^USE /m);
});

test('DDL preview reuses exact bytes at save and refuses changed dependencies or connection', async () => {
  let current = snapshot([child, parent(13)]), changed, provider;
  const writes = [];
  const fake = () => ({ dispose() {} });
  const vscode = {
    commands: { registerCommand: fake },
    workspace: { isTrusted: true,
      registerTextDocumentContentProvider(scheme, value) { provider = value; return fake(); },
      fs: { async writeFile(uri, body) { writes.push(Buffer.from(body)); } } }
  };
  const service = registerSchemaDdlExport({}, vscode, { database: {
    async captureSchemaSnapshot() { return current; },
    onDidChangeDatabase(handler) { changed = handler; return fake(); }
  } });
  const local = { scheme: 'file', toString: () => 'file:///review.sql' };
  const first = await service.prepare();
  const body = first.sql;
  assert.equal(provider.provideTextDocumentContent({ path: '/' + first.id + '/schema.sql' }), body);
  first.sql = 'caller edited output';
  current = snapshot([child, parent(150)]);
  assert.equal((await service.saveReview(first.id, local)).statements, 3);
  assert.equal(writes[0].toString(), body);
  current = snapshot([parent(150)]);
  await assert.rejects(service.saveReview(first.id, local), /changed after review/);
  assert.equal(writes.length, 1);
  const second = await service.prepare();
  changed();
  await assert.rejects(service.saveReview(second.id, local), /connection or catalog changed/);
  await service.dispose();
});
