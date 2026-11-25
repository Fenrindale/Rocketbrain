'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { normalizeTerm, matches, searchDatabaseText, textHash } = require('../src/db/unified-search');
const { registerUnifiedSearch, coverageNarrative } = require('../src/db/unified-search-vscode');
const { memberLocation } = require('../src/db/object-source-vscode');

test('literal text folds case while retaining UTF-16 offsets and wildcard characters', () => {
  const source = '🙂 A%_B.*\nsecond a%_b.*\nthird A%_b.*\nextra a%_b.*';
  const result = matches(source, normalizeTerm('a%_b.*'));
  assert.equal(result.extra, true);
  assert.equal(result.found[0].start, '🙂 '.length);
  assert.deepEqual(result.found.map(item => source.slice(item.start, item.end)), ['A%_B.*', 'a%_b.*', 'A%_b.*']);
  assert.throws(() => normalizeTerm('  '), /literal/);
  assert.throws(() => normalizeTerm('a\nb'), /literal/);
});

test('database search separates observed names, exact DDL and a withheld definition', async () => {
  const visible = { schema: 'inventory', name: 'item_%', kind: 'table' };
  const hidden = { schema: 'inventory', name: 'hidden_%', kind: 'view' };
  const sql = 'CREATE TABLE `item_%` (`number` INT) COMMENT="Literal %_"';
  const query = async (statement, params) => {
    if (statement.startsWith('SELECT SCHEMA_NAME FROM')) return { rows: [['inventory']] };
    if (statement.startsWith('SELECT schema_id')) {
      if (statement.includes("LIKE CAST(? AS BINARY)")) assert.ok(params.includes('%=%=_%'));
      return { rows: [visible, hidden].map(item => [item.schema, item.name, item.kind, null, null]) };
    }
    if (statement.startsWith('SELECT TABLE_NAME')) return { rows: [[params[1]]] };
    if (statement.startsWith('SHOW CREATE TABLE')) return { rows: [[visible.name, sql]], columns: ['Table', 'Create Table'] };
    if (statement.startsWith('SHOW CREATE VIEW')) throw Object.assign(Error('private'), { code: 'ER_TABLEACCESS_DENIED_ERROR' });
    assert.fail('Unexpected metadata statement');
  };
  const report = await searchDatabaseText(query, { dialect: 'mysql', database: 'inventory' }, { term: '%_', schemas: ['inventory', 'other'] });
  assert.equal(report.names.length, 2);
  assert.equal(report.ddl.length, 1);
  assert.equal(report.ddl[0].hash, textHash(sql));
  assert.deepEqual(report.coverage.unavailableSchemas, ['other']);
  assert.deepEqual(report.coverage.unreadDefinitions, [{ object: hidden, reason: 'permission' }]);
  assert.equal(report.coverage.inspectedDefinitions, 1);
  assert.ok(!JSON.stringify(report).includes('private'));
  await assert.rejects(searchDatabaseText(query, { database: 'inventory' }, { term: '%_' }, () => { throw Error('cancelled'); }), /cancelled/);
});

test('child targets select exact column, index and constraint tokens in their owning DDL', () => {
  const source = 'CREATE TABLE `owner` (\n  `column name` VARCHAR(20), KEY `token` (`column name`),\n' +
    'CONSTRAINT `valid` CHECK (`column name` IS NOT NULL))';
  for (const [kind, name] of [['column', 'column name'], ['index', 'token'], ['constraint', 'valid']]) {
    const found = memberLocation({ source, dialect: 'mysql', object: { kind: 'table' } }, { kind, name });
    assert.equal(source.slice(found.start, found.end), '`' + name + '`');
  }
});

test('unified file and database handles reject stale content and keep available local matches', async t => {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'rb-search-unit-'));
  const file = path.join(root, 'token.sql');
  await fs.writeFile(file, '-- first\r\nSELECT \'TOKEN\';\r\n');
  t.after(async () => { await fs.unlink(file); await fs.rmdir(root); });
  const uri = fsPath => ({ fsPath, scheme: 'file', toString: () => fsPath });
  const disposables = { dispose() {} };
  const shown = [];
  let databaseChanged, databaseFail = false;
  const vscode = {
    Uri: { file: uri, parse: uri }, RelativePattern: class {},
    Position: class { constructor(line, character) { this.line = line; this.character = character; } },
    Range: class { constructor(start, end) { this.start = start; this.end = end; } },
    workspace: { isTrusted: true, workspaceFolders: [{ uri: uri(root) }], textDocuments: [],
      findFiles: async () => [uri(file)], asRelativePath: doc => path.basename(doc.fsPath),
      async openTextDocument(doc) { const source = await fs.readFile(doc.fsPath, 'utf8'); return { getText: () => source }; } },
    commands: { registerCommand: () => disposables }, window: { async showTextDocument(_document, options) { shown.push(options); } }
  };
  const context = { subscriptions: [] };
  const owned = { schema: 'inventory', name: 'token', kind: 'table' };
  const api = registerUnifiedSearch(context, vscode, { database: { liveCatalogSnapshot: () => ({ database: 'inventory' }),
    onDidChangeDatabase(callback) { databaseChanged = callback; return disposables; } }, objectSources: {
    async search() {
      if (databaseFail) throw Error('engine unavailable');
      return { names: [{ type: 'database-name', object: owned }], ddl: [],
        coverage: { dialect: 'mysql', scopes: ['inventory'], unreadDefinitions: [], unavailableSchemas: [] } };
    },
    async openSearchResult(result) { return result.object; }
  } });
  const result = await api.search({ term: 'token' });
  assert.deepEqual(result.results.map(item => item.type), ['file-name', 'file-content', 'database-name']);
  const opened = await api.open(result.id, 1);
  assert.equal(opened.selection.start.line, 1);
  assert.equal(opened.selection.start.character, 8);
  assert.equal(shown[0].selection.end.character, 13);
  assert.deepEqual(await api.open(result.id, 2), owned);
  await fs.writeFile(file, '-- changed\n\nSELECT \'TOKEN\';');
  await assert.rejects(api.open(result.id, 1), /file changed/);
  databaseChanged();
  await assert.rejects(api.open(result.id, 2), /active database changed/);
  await api.open(result.id, 0);
  databaseFail = true;
  const local = await api.search({ term: 'token' });
  assert.deepEqual(local.results.map(item => item.type), ['file-name', 'file-content']);
  assert.match(coverageNarrative(local), /Live database search did not finish/);
});
