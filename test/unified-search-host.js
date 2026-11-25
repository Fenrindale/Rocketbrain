'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomBytes } = require('node:crypto');
const mysql = require('mysql2/promise');
const { MysqlService } = require('../src/db/mysql');
const { contextOf, loadSource } = require('../src/db/object-source');
const { searchDatabaseText, textHash } = require('../src/db/unified-search');
const { searchWorkspaceFiles } = require('../src/db/unified-search-vscode');
const { jdbcReadback } = require('./java-source-analysis-host');

const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const quote = name => '`' + name.replaceAll('`', '``') + '`';

async function fixtureState() {
  const runtime = await read(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG);
  const folder = path.dirname(await fs.realpath(runtime.dbConfigPath));
  const owner = await read(path.join(folder, 'owner.json'));
  assert.equal(path.basename(folder), owner.id);
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(owner.kind));
  assert.equal(runtime.dbEngine, process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE);
  const config = await read(runtime.dbConfigPath);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.database, 'rocketbrain_fixture');
  const cross = await read(process.env.ROCKETBRAIN_SCHEMA_CROSS_CONFIG);
  assert.equal(cross.fixtureId, owner.id);
  assert.ok(cross.schemas.includes('rocketbrain_related'));
  const restricted = await read(process.env.ROCKETBRAIN_DBADMIN_TEST_CONFIG);
  assert.equal(restricted.owner, owner.id);
  assert.equal(restricted.sourceConfigPath, runtime.dbConfigPath);
  assert.equal(restricted.admin.port, config.port);
  return { runtime, config, restricted: restricted.admin, schemas: [config.database, 'rocketbrain_related'] };
}

async function withFixtures(parent, test) {
  const fixture = await fixtureState();
  const root = await fs.mkdtemp(path.join(await fs.realpath(parent), 'rb-unified-sql-'));
  const db = await mysql.createConnection(fixture.config);
  const tag = 'rb022_' + randomBytes(4).toString('hex');
  const marker = 'look up ' + tag + ' with 25%_literal';
  const column = tag + '_column', index = tag + '_index', constraint = tag + '_check';
  const table = { schema: fixture.schemas[0], name: tag + '_table', kind: 'table' };
  const view = { schema: fixture.schemas[0], name: tag + '_view', kind: 'view' };
  const crossTable = { schema: fixture.schemas[1], name: tag + '_other', kind: 'table' };
  const identifier = target => quote(target.schema) + '.' + quote(target.name);
  const files = [path.join(root, tag + '.sql'), path.join(root, 'query.SQL')];
  const cleanup = [];
  const programs = [];
  async function program(kind, statement, suffix, body) {
    const target = { schema: table.schema, name: tag + suffix, kind };
    await db.query('CREATE ' + statement + ' ' + identifier(target) + ' ' + body);
    cleanup.unshift('DROP ' + statement + ' IF EXISTS ' + identifier(target));
    programs.push(target);
  }
  try {
    await db.query('CREATE TABLE ' + identifier(table) + ' (id INT PRIMARY KEY,' + quote(column) +
      ' VARCHAR(80), KEY ' + quote(index) + ' (' + quote(column) + '), CONSTRAINT ' + quote(constraint) +
      ' CHECK (id > 0)) ENGINE=InnoDB COMMENT=?', [marker]);
    cleanup.unshift('DROP TABLE ' + identifier(table));
    await db.query('CREATE VIEW ' + identifier(view) + ' AS SELECT id FROM ' + identifier(table));
    cleanup.unshift('DROP VIEW ' + identifier(view));
    await db.query('CREATE TABLE ' + identifier(crossTable) + ' (id INTEGER PRIMARY KEY) ENGINE=InnoDB COMMENT=?', [marker]);
    cleanup.unshift('DROP TABLE ' + identifier(crossTable));
    await program('procedure', 'PROCEDURE', '_proc', '(IN n INT) BEGIN SELECT n; END');
    await program('function', 'FUNCTION', '_func', '(n INT) RETURNS INT DETERMINISTIC NO SQL RETURN n');
    await program('trigger', 'TRIGGER', '_trg', 'BEFORE INSERT ON ' + identifier(table) +
      ' FOR EACH ROW BEGIN SET NEW.' + quote(column) + ' = COALESCE(NEW.' + quote(column) + ', \'\'); END');
    await program('event', 'EVENT', '_evt', 'ON SCHEDULE AT CURRENT_TIMESTAMP + INTERVAL 1 DAY DISABLE DO SET @rb022_test = 1');
    if (fixture.runtime.dbEngine === 'mariadb') {
      await program('sequence', 'SEQUENCE', '_seq', 'START WITH 11');
      const [[{ mode }]] = await db.query('SELECT @@SESSION.sql_mode AS mode');
      await db.query("SET SESSION sql_mode='ORACLE'");
      try {
        await program('package', 'PACKAGE', '_pack', 'AS PROCEDURE put_value(n INT); END');
        await program('package-body', 'PACKAGE BODY', '_pack', 'AS PROCEDURE put_value(n INT) AS BEGIN NULL; END; END');
      } finally { await db.query('SET SESSION sql_mode=?', [mode]); }
    }
    await fs.writeFile(files[0], `-- workspace \r\n-- ${marker.toUpperCase()}\r\nSELECT 1;\r\n`, { flag: 'wx' });
    await fs.writeFile(files[1], Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('-- ' + marker + '\n', 'utf16le')]), { flag: 'wx' });
    const [[raw]] = await db.query('SHOW CREATE TABLE ' + identifier(crossTable));
    const context = { ...fixture, root, files, tag, marker, table, view, crossTable, column, index, constraint, programs, exactDdl: raw['Create Table'],
      changeDdl: () => db.query('ALTER TABLE ' + identifier(crossTable) + ' ADD COLUMN shifted VARCHAR(5)') };
    return await test(context);
  } finally {
    try { for (const statement of cleanup) await db.query(statement); }
    finally {
      await db.end();
      for (const file of files) await fs.unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
      await fs.rmdir(root);
    }
  }
}

function checkNames(report, fixture) {
  for (const [name, kind] of [[fixture.table.name, 'table'], [fixture.view.name, 'view'], [fixture.crossTable.name, 'table'],
    [fixture.column, 'column'], [fixture.index, 'index'], [fixture.constraint, 'constraint'],
    ...fixture.programs.map(item => [item.name, item.kind])]) {
    assert.ok(report.some(row => row.object.name === name && row.object.kind === kind), 'Missing typed target ' + kind);
  }
}

function checkProgramSources(report, fixture) {
  for (const object of fixture.programs) {
    assert.ok(report.some(result => result.object.kind === object.kind && result.object.name === object.name),
      'Missing live DDL match for ' + object.kind);
  }
}

async function directSearch(config, term, schemas) {
  const db = new MysqlService(config);
  const query = (sql, values) => db._metadataQuery(sql, values);
  try { return await searchDatabaseText(query, await contextOf(query), { term, schemas }); }
  finally { await db.dispose(); }
}

async function verifyHeadlessUnifiedSearch() {
  return withFixtures(os.tmpdir(), async fixture => {
    const scoped = await directSearch(fixture.config, fixture.tag, fixture.schemas);
    checkNames(scoped.names, fixture);
    checkProgramSources(scoped.ddl, fixture);
    const schema = await directSearch(fixture.config, fixture.schemas[1], fixture.schemas);
    assert.ok(schema.names.some(item => item.object.kind === 'schema' && item.object.name === fixture.schemas[1]));
    const full = await directSearch(fixture.config, fixture.marker, fixture.schemas);
    const cross = full.ddl.find(item => item.object.name === fixture.crossTable.name);
    assert.equal(cross?.hash, textHash(fixture.exactDdl));
    assert.equal(fixture.exactDdl.slice(cross.start, cross.end), fixture.marker);
    const restricted = await directSearch(fixture.restricted, fixture.tag, fixture.schemas);
    assert.ok(restricted.names.some(item => item.object.name === fixture.view.name));
    assert.ok(restricted.coverage.unreadDefinitions.some(item => item.object.name === fixture.view.name && item.reason === 'permission'));
    assert.deepEqual(restricted.coverage.unavailableSchemas, [fixture.schemas[1]]);
    const uri = file => ({ fsPath: file, scheme: 'file', toString: () => file });
    const vscode = { workspace: { findFiles: async () => fixture.files.map(uri), textDocuments: [],
      asRelativePath: value => path.basename(value.fsPath) }, Uri: { file: uri }, RelativePattern: class {} };
    const roots = [{ input: fixture.root, real: fixture.root }];
    const files = await searchWorkspaceFiles(vscode, roots, fixture.marker, () => {});
    assert.equal(files.content.length, 2);
    const fileMatches = await searchWorkspaceFiles(vscode, roots, fixture.tag, () => {});
    assert.equal(fileMatches.names.length, 1);
    const db = new MysqlService(fixture.config);
    try {
      const query = (sql, values) => db._metadataQuery(sql, values);
      await fixture.changeDdl();
      assert.notEqual(textHash((await loadSource(query, await contextOf(query), fixture.crossTable)).source), cross.hash);
    } finally { await db.dispose(); }
    return { engine: fixture.runtime.dbEngine, typedObjects: 6 + fixture.programs.length, exactProgramDefinitions: fixture.programs.length,
      crossSchemaDdl: true, exactDdlSpan: true,
      schemaName: true, fileName: true, fileMatches: 2, utf16: true, restrictedDefinition: true, hiddenSchema: true,
      staleDdlDigestDetected: true, jdbc: await jdbcReadback() };
  });
}

async function runUnifiedSearchChecks(api, vscode, checks) {
  const root = (vscode.workspace.workspaceFolders ?? []).find(folder => folder.uri.scheme === 'file')?.uri.fsPath;
  assert.ok(root, 'Open the owned local workspace for unified search verification.');
  return withFixtures(root, async fixture => {
    assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.db.searchSources'));
    await api.connectMysql(fixture.config);
    const options = { schemas: fixture.schemas, roots: [fixture.root] };
    try {
      const names = await api.databaseSearch.search({ ...options, term: fixture.tag });
      checkNames(names.results.filter(item => item.type === 'database-name'), fixture);
      checkProgramSources(names.results.filter(item => item.type === 'database-ddl'), fixture);
      assert.ok(names.results.some(item => item.type === 'file-name'));
      const report = await api.databaseSearch.search({ ...options, term: fixture.marker });
      const file = report.results.findIndex(item => item.type === 'file-content' && item.label === path.basename(fixture.files[0]));
      const cross = report.results.findIndex(item => item.type === 'database-ddl' && item.object.name === fixture.crossTable.name);
      const member = names.results.findIndex(item => item.type === 'database-name' && item.object.name === fixture.column);
      assert.ok(file >= 0 && cross >= 0 && member >= 0);
      const fileOpened = await api.databaseSearch.open(report.id, file);
      assert.match(fileOpened.uri, /\.sql$/);
      assert.equal(vscode.window.activeTextEditor.document.getText(fileOpened.selection), fixture.marker.toUpperCase());
      const definition = await api.databaseSearch.open(report.id, cross);
      assert.equal(definition.source, fixture.exactDdl);
      let editor = vscode.window.activeTextEditor;
      assert.equal(editor.document.uri.scheme, 'rocketbrain-object-source');
      assert.equal(editor.document.getText(editor.selection), fixture.marker);
      const parent = await api.databaseSearch.open(names.id, member);
      assert.deepEqual(parent.object, fixture.table);
      editor = vscode.window.activeTextEditor;
      assert.equal(editor.document.getText(editor.selection).replaceAll('`', ''), fixture.column);
      await fixture.changeDdl();
      await assert.rejects(api.databaseSearch.open(report.id, cross), /definition changed/);
      await api.connectMysql(fixture.restricted);
      await assert.rejects(api.databaseSearch.open(names.id, member), /active database changed/);
      const limited = await api.databaseSearch.search({ ...options, term: fixture.tag });
      assert.ok(limited.coverage.database.unreadDefinitions.some(item => item.object.name === fixture.view.name && item.reason === 'permission'));
      assert.deepEqual(limited.coverage.database.unavailableSchemas, [fixture.schemas[1]]);
      const jdbc = await jdbcReadback();
      assert.deepEqual(jdbc, { people: 2, departments: 1, rolledBackNames: 0 });
      checks.push('The installed unified search navigated to exact workspace SQL text, a cross-schema DDL span, and a column in its parent DDL. Live permission and stale-result boundaries were preserved.');
      return { engine: fixture.runtime.dbEngine, nativeFileSelection: true, nativeDdlSelection: true, nativeColumnSelection: true,
        fileAndDatabaseResultsCombined: true, restrictedDefinition: true, staleDdlRejected: true, staleConnectionRejected: true, jdbc };
    } finally {
      await api.disconnectMysql();
      const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs)
        .filter(tab => fixture.files.includes(tab.input?.uri?.fsPath) ||
          tab.input?.uri?.scheme === 'rocketbrain-object-source' && tab.input.uri.path.includes(fixture.tag));
      if (tabs.length) await vscode.window.tabGroups.close(tabs);
    }
  });
}

if (require.main === module) verifyHeadlessUnifiedSearch().then(result => console.log(JSON.stringify(result)))
  .catch(error => { console.error(error.stack); process.exitCode = 1; });

module.exports = { runUnifiedSearchChecks, verifyHeadlessUnifiedSearch };
