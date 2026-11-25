'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const { MysqlService } = require('../src/db/mysql');
const { contextOf, loadSource } = require('../src/db/object-source');
const { observeRoutineUsages } = require('../src/db/catalog-routine-usages');
const { analyzeProjectDocument, normalizeTarget, referencesInDocument } = require('../src/db/sql-project');
const { owned } = require('./schema-stored-diff-host');

const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const quote = name => String.fromCharCode(96) + name + String.fromCharCode(96);
const qualified = (schema, name) => quote(schema) + '.' + quote(name);
const digest = value => createHash('sha256').update(value).digest('hex');
const expectedSpring = { people: 2, departments: 1, rolledBackNames: 0 };
const springDescriptors = ['build.gradle', 'settings.gradle'];

async function nativeFixtureProject(project, folders) {
  const expected = await Promise.all(springDescriptors.map(name => fs.readFile(path.join(project, name))));
  const matching = new Set();
  for (const { uri } of folders || []) {
    if (uri.scheme !== 'file' || uri.authority) continue;
    try {
      const root = await fs.realpath(uri.fsPath);
      const actual = await Promise.all(springDescriptors.map(name => fs.readFile(path.join(root, name))));
      if (actual.every((source, index) => source.equals(expected[index]))) matching.add(root);
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    }
  }
  assert.equal(matching.size, 1, 'Locate exactly one native workspace copy of the owned Spring fixture.');
  return matching.values().next().value;
}

async function verifyCatalogUsages(adapter) {
  const runtime = await read(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG);
  const instance = path.dirname(await fs.realpath(runtime.dbConfigPath));
  const crossFile = await fs.realpath(process.env.ROCKETBRAIN_SCHEMA_CROSS_CONFIG);
  assert.equal(path.dirname(crossFile), instance);
  const cross = await read(crossFile);
  assert.equal(cross.fixtureId, path.basename(instance));
  assert.deepEqual(cross.schemas, ['rocketbrain_fixture', 'rocketbrain_related']);
  const [home, peer] = cross.schemas;
  const { actor, config, version } = await owned(runtime.dbConfigPath);
  const tag = 'rb_usages_' + randomBytes(5).toString('hex');
  const target = { schema: peer, name: tag + '_entity', kind: 'table' };
  const related = qualified(peer, target.name);
  const shadow = qualified(home, target.name);
  const procedure = (schema, suffix, body) => {
    const name = tag + '_' + suffix;
    return { object: { schema, name, kind: 'procedure' }, identity: qualified(schema, name),
      body: 'CREATE PROCEDURE ' + qualified(schema, name) + '() READS SQL DATA ' + body };
  };
  const found = procedure(home, 'external', 'BEGIN\n  SELECT id FROM ' + related + ';\n  SELECT id FROM ' + shadow + ';\nEND');
  const sameName = procedure(home, 'same_name', 'SELECT id FROM ' + quote(target.name));
  const inside = procedure(peer, 'inside', 'SELECT id FROM ' + quote(target.name));
  const dynamic = procedure(home, 'dynamic', "BEGIN SET @rb_usage_text='SELECT id FROM " + peer + '.' + target.name + "'; END");
  const procedures = [found, sameName, inside, dynamic];
  const spring = async () => {
    const url = new URL('/probe/testing-state', runtime.baseUrl);
    assert.equal(url.hostname, '127.0.0.1');
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), expectedSpring);
  };
  let folder, file, connected = false;
  try {
    await spring();
    for (const relation of [related, shadow]) {
      await actor.query('CREATE TABLE ' + relation + ' (id INT PRIMARY KEY) ENGINE=InnoDB');
      await actor.query('INSERT INTO ' + relation + ' VALUES (?)', [relation === related ? 21 : 37]);
    }
    for (const routine of procedures) await actor.query(routine.body);
    const project = await fs.realpath(runtime.projectPath);
    const expectedSuffix = path.join('test','fixtures','spring-boot-app');
    assert.ok(project.endsWith(path.sep + expectedSuffix));
    const sourceProject = adapter.native ? await nativeFixtureProject(project, adapter.nativeFolders) : project;
    folder = await fs.mkdtemp(path.join(sourceProject, 'rb-catalog-usages-'));
    file = path.join(folder, 'scope.sql');
    const text = 'SELECT id FROM ' + related + ';\r\nSELECT id FROM ' + shadow + ';\r\n' +
      "SELECT '" + peer + '.' + target.name + "' AS inside_string;";
    await fs.writeFile(file, text, { flag: 'wx' });
    await adapter.connect(config);
    connected = true;
    const request = { target, schemas: [home, peer], includeFiles: true, fileRoots: [folder] };
    const report = await adapter.capture(request, file);
    assert.equal(report.executedSql, false);
    const matches = report.routines.hits;
    assert.equal(matches.length, 2, JSON.stringify(report.routines));
    assert.deepEqual(matches.map(hit => hit.object), [found.object, inside.object]);
    assert.deepEqual(report.routines.opaque.find(item => item.object.name === dynamic.object.name),
      { object: dynamic.object, reason: 'unsupported-procedure-body' });
    assert.match(report.routines.note, /catalog can hide procedures/u);
    assert.equal(report.files.references.length, 1, JSON.stringify(report.files.coverage));
    assert.equal(report.files.coverage.complete, true, JSON.stringify(report.files.coverage));
    const first = await adapter.open(report, 'procedure', 0);
    const interior = await adapter.open(report, 'procedure', 1);
    const member = await adapter.open(report, 'file', 0);
    assert.equal(first, related);
    assert.equal(interior, quote(target.name));
    assert.equal(member, quote(target.name));

    await fs.appendFile(file, '\r\n-- Source changed after the captured reference');
    await assert.rejects(() => adapter.open(report, 'file', 0), /source changed/u);
    const [[{ mode }]] = await actor.query('SELECT @@SESSION.sql_mode mode');
    try {
      await actor.query('DROP PROCEDURE ' + found.identity);
      const selected = [...new Set([...mode.split(',').filter(Boolean), 'NO_BACKSLASH_ESCAPES'])].join(',');
      assert.notEqual(selected, mode);
      await actor.execute('SET SESSION sql_mode=?', [selected]);
      await actor.query(found.body);
    } finally {
      await actor.execute('SET SESSION sql_mode=?', [mode]);
    }
    await assert.rejects(() => adapter.open(report, 'procedure', 0), /settings changed/u);
    const [[left]] = await actor.query('SELECT id FROM ' + related);
    const [[right]] = await actor.query('SELECT id FROM ' + shadow);
    assert.deepEqual([left.id,right.id],[21,37]);
    await spring();
    return { engine: runtime.dbEngine, serverVersion: version, procedureLocations: matches.length, sqlFileLocations: 1,
      exactQualifiedSelection: true, sameBasenameIsolated: true, opaqueBodyReported: true, hiddenScopeExplained: true,
      staleFileRejected: true, sameSourceDifferentModeRejected: true, rowDataUnchanged: true, springJdbcUnchanged: true,
      nativeCatalogNavigation: Boolean(adapter.native) };
  } finally {
    try { if (connected) await adapter.disconnect(); }
    finally {
      try {
        for (const routine of procedures) await actor.query('DROP PROCEDURE IF EXISTS ' + routine.identity);
        for (const relation of [related,shadow]) await actor.query('DROP TABLE IF EXISTS ' + relation);
      } finally {
        await actor.end();
        if (file) await fs.unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
        if (folder) await fs.rmdir(folder);
      }
    }
  }
}

async function verifyCatalogUsagesBackend() {
  let db, sqlText, filePath;
  const query = (sql, values) => db._metadataQuery(sql, values);
  return verifyCatalogUsages({
    connect(config) { db = new MysqlService(config); },
    disconnect: () => db.dispose(),
    async capture(request, file) {
      const routines = await observeRoutineUsages(query, await contextOf(query), request);
      const catalog = await db.metadata();
      const joined = await db.joinCompletionCatalog({ endpoints: [{ schema: request.target.schema, table: request.target.name }], includeEdges: false });
      const target = normalizeTarget({ kind: 'table', database: request.target.schema, table: request.target.name },
        { database: request.target.schema, tables: joined.tables }, { database: request.target.schema });
      filePath = file;
      sqlText = await fs.readFile(file, 'utf8');
      const options = { ...catalog, catalogComplete: true, joinOrigins: true, joinTables: joined.tables };
      const report = analyzeProjectDocument(sqlText, catalog, options);
      const references = referencesInDocument(report, target, options);
      return { routines, files: { references, coverage: { complete: report.state === 'known' } }, executedSql: false };
    },
    async open(report, group, index) {
      if (group === 'file') {
        if (await fs.readFile(filePath,'utf8') !== sqlText) throw Error('The SQL source changed.');
        const ref = report.files.references[index];
        return sqlText.slice(ref.start,ref.end);
      }
      const hit = report.routines.hits[index];
      const current = await loadSource(query,await contextOf(query),hit.object);
      assert.equal(digest(current.source),hit.sourceSha256);
      if (digest(JSON.stringify(current.settings)) !== hit.settingsSha256) throw Error('The definition settings changed.');
      return current.source.slice(hit.start, hit.end);
    }
  });
}

async function runCatalogUsagesChecks(api, vscode, checks) {
  const result = await verifyCatalogUsages({
    native: true,
    nativeFolders: vscode.workspace.workspaceFolders,
    connect: config => api.connectMysql(config),
    disconnect: () => api.disconnectMysql(),
    capture: request => vscode.commands.executeCommand('rocketbrain.db.findCatalogUsages',request),
    async open(report, group, index) {
      const result = await api.objectSources.catalogUsages.open(report.reportId,group,index);
      const editor = vscode.window.activeTextEditor;
      assert.equal(editor.document.uri.toString(),result.documentUri);
      return editor.document.getText(editor.selection);
    }
  });
  checks.push('Found and opened exact cross-schema routine and local SQL file references while excluding an identically named home table and opaque dynamic routine.');
  checks.push('Refused stale SQL file and changed procedure creation settings even with identical procedure source bytes.');
  return result;
}

module.exports = { runCatalogUsagesChecks, verifyCatalogUsagesBackend };
if (require.main === module) {
  verifyCatalogUsagesBackend().then(report => console.log(JSON.stringify(report)))
    .catch(error => { console.error(error.stack); process.exitCode = 1; });
}
