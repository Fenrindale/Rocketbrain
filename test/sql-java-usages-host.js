'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { jdbcReadback } = require('./java-source-analysis-host');

const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const sql = 'SELECT p.display_name FROM rb_spring_person p';
const prepared = sql + ' WHERE p.id > ?;';
const program = [
  'import org.springframework.jdbc.core.JdbcTemplate;',
  'class Dynamic {',
  '  void run(JdbcTemplate jdbc, String table) {',
  '    jdbc.queryForList("SELECT display_name FROM " + table);',
  '  }',
  '}'
].join('\n');
const inputPaths = root => ({ java: path.join(root, 'java'), sql: path.join(root, 'sql') });
const lineOffset = (text, position) => text.split('\n').slice(0, position.line).reduce((sum, line) => sum + line.length + 1, 0) + position.character;
const pathIdentity = file => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
const sameFile = (left, right) => pathIdentity(left) === pathIdentity(right);

async function withUsageFixture(workspace, action) {
  const runtime = await read(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG);
  const ownerDirectory = path.dirname(await fs.realpath(runtime.dbConfigPath));
  const config = await read(runtime.dbConfigPath), owner = await read(path.join(ownerDirectory, 'owner.json'));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(owner.kind));
  assert.equal(owner.id, path.basename(ownerDirectory));
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.database, 'rocketbrain_fixture');
  assert.equal(runtime.dbEngine, process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE);
  const jdbc = await jdbcReadback();
  const response = await fetch(runtime.baseUrl + '/probe/sql-usages', { signal: AbortSignal.timeout(6000) });
  assert.ok(response.ok, 'The real Spring SQL usage probe did not run.');
  const springQueries = await response.json();
  assert.deepEqual(springQueries, { textBlock: 2, literalConcatenation: 2 });
  const projectFile = path.join(runtime.projectPath, 'src/main/java/fixture/boot/SqlUsageProbe.java');
  const contents = await fs.readFile(projectFile, 'utf8');

  const parent = await fs.realpath(workspace), root = await fs.mkdtemp(path.join(parent, 'rb-sql-usages-'));
  const markerPath = path.join(root, 'ownership'), mark = randomUUID(), files = inputPaths(root);
  await fs.writeFile(markerPath, mark, { flag: 'wx' });
  try {
    await Promise.all(Object.values(files).map(directory => fs.mkdir(directory)));
    const javaFile = path.join(files.java, 'SqlUsageProbe.java'), sqlFile = path.join(files.sql, 'used.sql');
    const dynamicFile = path.join(files.java, 'Dynamic.java'), preparedFile = path.join(files.sql, 'prepared.sql');
    await Promise.all([fs.writeFile(javaFile, contents), fs.writeFile(sqlFile, sql + ';'),
      fs.writeFile(path.join(root, 'unselected.sql'), sql + ';'), fs.writeFile(path.join(root, 'unselected.java'), contents)]);
    const result = await action({ root, config, files, contents, javaFile, sqlFile, dynamicFile, preparedFile, runtime });
    assert.deepEqual(await jdbcReadback(), jdbc);
    return { engine: runtime.dbEngine, jdbc, springQueries, ...result };
  } finally {
    assert.equal(await fs.readFile(markerPath, 'utf8'), mark);
    assert.equal(path.dirname(await fs.realpath(root)), parent);
    assert.ok(path.basename(root).startsWith('rb-sql-usages-'));
    await fs.rm(root, { recursive: true, force: true });
  }
}

const targetFor = database => ({ kind: 'column', database, table: 'rb_spring_person', column: 'display_name' });

async function verifyFindUsages(fixture, api) {
  const { javaFile, sqlFile, dynamicFile, preparedFile, contents, config } = fixture;
  const target = targetFor(config.database);
  const initial = await api.findCatalogReferences(target);
  assert.equal(initial.coverage.complete, true);
  assert.equal(initial.coverage.sourceRenameEligible, false);
  assert.deepEqual(initial.coverage.java, { enabled: true, analyzedFiles: 1, recognizedFragments: 3, references: 3 });
  assert.equal(initial.references.length, 4);
  assert.equal(initial.executedSql, false);
  for (const ref of initial.references) {
    const sourceFile = fileURLToPath(ref.uri);
    const isJava = sameFile(sourceFile, javaFile);
    assert.ok(isJava || sameFile(sourceFile, sqlFile));
    const origin = isJava ? contents : sql + ';';
    assert.equal(origin.slice(ref.start, ref.end), 'display_name');
    assert.equal(lineOffset(origin, ref.range.start), ref.start);
    assert.equal(ref.editEligible, !isJava);
  }
  await assert.rejects(api.planCatalogRename(target, 'display_label'), { code: 'SQL_PROJECT_EMBEDDED_READ_ONLY' });

  await Promise.all([fs.writeFile(dynamicFile, program), fs.writeFile(preparedFile, prepared)]);
  const partial = await api.findCatalogReferences(target);
  assert.equal(partial.references.length, 5);
  assert.equal(partial.coverage.complete, false);
  assert.equal(partial.coverage.java.references, 3);
  assert.ok(partial.references.some(ref => workPath(ref.uri, preparedFile)));
  assert.ok(!partial.references.some(ref => workPath(ref.uri, dynamicFile)));
  const unknown = partial.coverage.unknownFiles.find(item => workPath(item.uri, dynamicFile));
  assert.equal(unknown.language, 'java');
  assert.ok(unknown.reasons.some(item => item.code === 'java-sql-dynamic' && item.range.start.line === 3));
  return { exactSqlAndJavaLocations: 5, embeddedReferences: 3, boundParameters: true, dynamicCoverage: true,
    selectedRootsOnly: true, renameReadOnlyGuard: true, noSqlExecutedBySearch: true };
}

function workPath(uri, file) {
  return typeof uri === 'string' && sameFile(fileURLToPath(uri), file);
}

async function runSqlJavaUsageChecks(api, vscode, checks) {
  const workspace = vscode.workspace.workspaceFolders[0].uri.fsPath;
  return withUsageFixture(workspace, async fixture => {
    const { files, root, javaFile, sqlFile, config } = fixture;
    const configuration = vscode.workspace.getConfiguration('rocketbrain.sql.project');
    const previous = Object.fromEntries(['roots','javaRoots'].map(key => [key, configuration.inspect(key)?.globalValue]));
    try {
      await configuration.update('roots', [files.sql], vscode.ConfigurationTarget.Global);
      await configuration.update('javaRoots', [files.java], vscode.ConfigurationTarget.Global);
      await api.connectMysql(config);
      await api.sqlAnalysis.refreshMetadata();
      const proof = await verifyFindUsages(fixture, api.sqlAnalysis);
      for (const name of [sqlFile, javaFile]) {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(name));
        const offset = doc.getText().indexOf('display_name') + 2;
        const position = doc.positionAt(offset);
        assert.deepEqual(api.sqlAnalysis.catalogTargetAt(doc, position), targetFor(config.database));
        const refs = await vscode.commands.executeCommand('vscode.executeReferenceProvider', doc.uri, position);
        const relevant = refs.filter(ref => ref.uri.scheme === 'file' && sameFile(path.dirname(path.dirname(ref.uri.fsPath)), root));
        assert.equal(relevant.length, 5);
        assert.equal(relevant.filter(ref => sameFile(ref.uri.fsPath, javaFile)).length, 3);
        for (const ref of relevant) assert.equal((await vscode.workspace.openTextDocument(ref.uri)).getText(ref.range), 'display_name');
      }
      const shown = await vscode.commands.executeCommand('rocketbrain.sql.showUsageCoverage');
      assert.equal(shown.complete, false);
      assert.ok(shown.unknownFiles.some(item => workPath(item.uri, fixture.dynamicFile)));
      checks.push('Native Find All References works from a SQL file and from a Spring Java SQL literal, returning exact host locations across configured roots. Runtime strings remain unresolved in the usage coverage report.');
      return { ...proof, nativeReferencesProvider: true, javaInitiation: true, coverageCommand: true };
    } finally {
      try {
        await configuration.update('roots', previous.roots, vscode.ConfigurationTarget.Global);
        await configuration.update('javaRoots', previous.javaRoots, vscode.ConfigurationTarget.Global);
        const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input?.uri?.scheme === 'file' &&
          sameFile(path.dirname(path.dirname(tab.input.uri.fsPath)), root));
        if (tabs.length) await vscode.window.tabGroups.close(tabs);
      } finally { await api.disconnectMysql(); }
    }
  });
}

function projectHost(fixture, catalog) {
  const { registerSQLAnalysis } = require('../src/db/sql-vscode');
  const disposable = () => ({ dispose() {} });
  const uri = file => ({ scheme: 'file', fsPath: file, toString: () => pathToFileURL(file).href });
  const docFor = new Map();
  const vscode = {
    EventEmitter: class { event = () => disposable(); fire() {} dispose() {} },
    RelativePattern: class { constructor(base, pattern) { Object.assign(this, { base, pattern }); } },
    languages: { createDiagnosticCollection: () => ({ clear() {}, dispose() {} }) },
    commands: { registerCommand: disposable },
    workspace: {
      isTrusted: true, workspaceFolders: [{ uri: uri(fixture.root) }],
      getConfiguration: () => ({ get: (key, fallback) => key === 'roots' ? [fixture.files.sql] : key === 'javaRoots' ? [fixture.files.java] : fallback }),
      onDidChangeTextDocument: disposable, onDidCloseTextDocument: disposable, onDidChangeConfiguration: disposable,
      async findFiles(pattern) {
        const names = await fs.readdir(pattern.base);
        return names.map(name => uri(path.join(pattern.base, name)));
      },
      async openTextDocument(value) {
        if (!docFor.has(value.fsPath)) {
          const text = await fs.readFile(value.fsPath, 'utf8');
          docFor.set(value.fsPath, { uri: value, version: 1, getText: () => text });
        }
        return docFor.get(value.fsPath);
      }
    }
  };
  for (const kind of ['CompletionItem', 'Definition', 'Hover']) vscode.languages['register' + kind + 'Provider'] = disposable;
  return registerSQLAnalysis({}, vscode, { catalogSnapshot: () => catalog });
}

async function verifySpringJavaUsages() {
  const { MysqlService } = require('../src/db/mysql');
  const runtime = await read(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG);
  return withUsageFixture(runtime.projectPath, async fixture => {
    const db = new MysqlService(fixture.config);
    let product;
    try {
      product = projectHost(fixture, await db.metadata());
      return { ...await verifyFindUsages(fixture, product), nativeReferencesProvider: false };
    } finally {
      product?.dispose();
      await db.dispose();
    }
  });
}

if (require.main === module) verifySpringJavaUsages().then(result => console.log(JSON.stringify(result)), error => {
  console.error(error.stack);
  process.exitCode = 1;
});
module.exports = { runSqlJavaUsageChecks, verifySpringJavaUsages };
