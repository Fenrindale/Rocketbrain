'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const mysql = require('mysql2/promise');
const { jdbcReadback } = require('./java-source-analysis-host');

const q = String.fromCharCode(96);
const quote = name => q + name.replaceAll(q, q + q) + q;
const qualified = (schema, name) => quote(schema) + '.' + quote(name);
const json = async file => JSON.parse(await fs.readFile(file, 'utf8'));

function atCursor(source) {
  const offset = source.indexOf('|');
  assert.ok(offset >= 0);
  return { text: source.replace('|', ''), offset };
}

async function withDefinitionFixture(action) {
  const runtime = await json(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG);
  const ownerFolder = path.dirname(await fs.realpath(runtime.dbConfigPath));
  const marker = await json(path.join(ownerFolder, 'owner.json'));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(marker.kind));
  assert.equal(path.basename(ownerFolder), marker.id);
  const config = await json(runtime.dbConfigPath);
  const cross = await json(path.join(ownerFolder, 'cross-schema.json'));
  const restricted = await json(process.env.ROCKETBRAIN_DBADMIN_TEST_CONFIG);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(cross.fixtureId, marker.id);
  assert.deepEqual(cross.schemas, [config.database, 'rocketbrain_related']);
  assert.equal(restricted.owner, marker.id);
  assert.equal(restricted.sourceConfigPath, runtime.dbConfigPath);
  assert.equal(restricted.admin.port, config.port);
  assert.equal(restricted.admin.host, config.host);
  assert.equal(restricted.admin.database, config.database);
  assert.equal(runtime.dbEngine, process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE);
  const spring = await jdbcReadback();
  const [local, remote] = cross.schemas, tag = randomBytes(5).toString('hex');
  const table = 'rb_nav_t_' + tag, view = 'rb_nav_v_' + tag, fn = 'rb_nav_f_' + tag, proc = 'rb_nav_p_' + tag;
  const actor = await mysql.createConnection(config);
  const cleanup = [];
  async function create(schema, kind, name, tail) {
    const target = qualified(schema, name);
    await actor.query('CREATE ' + kind + ' ' + target + ' ' + tail);
    cleanup.unshift('DROP ' + kind + ' IF EXISTS ' + target);
  }
  const target = (kind, schema, name) => ({ kind, schema, name });
  try {
    const [[server]] = await actor.query('SELECT @@datadir AS datadir');
    assert.equal(path.dirname(await fs.realpath(server.datadir)).toLowerCase(), ownerFolder.toLowerCase());
    await create(local, 'TABLE', table, '(id INT PRIMARY KEY,score INT NOT NULL,KEY idx_score(score)) ENGINE=InnoDB');
    await create(remote, 'TABLE', table, '(remote_id BIGINT PRIMARY KEY) ENGINE=InnoDB');
    await create(local, 'VIEW', view, 'AS SELECT p.score AS original_score,p.id AS score FROM ' + qualified(local, table) + ' p');
    await create(remote, 'VIEW', view, 'AS SELECT p.remote_id AS source_id FROM ' + qualified(remote, table) + ' p');
    await create(local, 'PROCEDURE', proc, '(IN n INT) BEGIN SELECT n; END');
    await create(local, 'FUNCTION', fn, '(n INT) RETURNS INT DETERMINISTIC NO SQL RETURN n + 1');
    await create(remote, 'FUNCTION', fn, '(n INT) RETURNS INT DETERMINISTIC NO SQL RETURN n + 2');
    const cases = [
      { label: 'Spring table', text: 'SELECT p.id FROM rb_spring_per|son p', object: target('table', local, 'rb_spring_person'), anchor: 'rb_spring_person' },
      { label: 'Spring column', text: 'SELECT p.display_|name FROM rb_spring_person p', object: target('table', local, 'rb_spring_person'), anchor: 'display_name', member: true },
      { label: 'table column', text: 'SELECT p.sco|re FROM ' + quote(table) + ' p', object: target('table', local, table), anchor: 'score', member: true },
      { label: 'view header', text: 'SELECT * FROM ' + quote(view).replace('nav_v', 'nav_|v') + ' p', object: target('view', local, view), anchor: view },
      { label: 'view output', text: 'SELECT p.sco|re FROM ' + quote(view) + ' p', object: target('view', local, view), anchor: 'score', member: true, output: true },
      { label: 'remote root', text: 'SELECT * FROM ' + quote(remote) + '.' + quote(table).replace('nav_t', 'nav_|t') + ' p',
        object: target('table', remote, table), anchor: table },
      { label: 'remote column', text: 'SELECT p.remote_|id FROM ' + qualified(remote, table) + ' p',
        object: target('table', remote, table), anchor: 'remote_id', member: true },
      { label: 'remote view column', text: 'SELECT p.sour|ce_id FROM ' + qualified(remote, view) + ' p',
        object: target('view', remote, view), anchor: 'source_id', member: true, output: true },
      { label: 'direct CALL', text: 'CALL ' + quote(proc).replace('nav_p','nav_|p') + '(1);', object: target('procedure', local, proc), anchor: proc },
      { label: 'local stored function', text: 'SELECT ' + quote(local) + '.' + quote(fn).replace('nav_f','nav_|f') + '(1);',
        object: target('function', local, fn), anchor: fn },
      { label: 'remote stored function', text: 'SELECT ' + quote(remote) + '.' + quote(fn).replace('nav_f','nav_|f') + '(1);',
        object: target('function', remote, fn), anchor: fn }
    ];
    const expectedSource = async ({ schema, name, kind }) => {
      const keyword = kind[0].toUpperCase() + kind.slice(1);
      const [[row]] = await actor.query('SHOW CREATE ' + kind.toUpperCase() + ' ' + qualified(schema, name));
      return row['Create ' + keyword];
    };
    const result = await action({ config, restricted: restricted.admin, cases, actor, local, remote, table, view, expectedSource });
    assert.deepEqual(await jdbcReadback(), spring);
    return { engine: runtime.dbEngine, spring, ...result };
  } finally {
    try { for (const statement of cleanup) await actor.query(statement); }
    finally { await actor.end(); }
  }
}

function verifySelection(item, source, selection, start) {
  assert.equal(selection, quote(item.anchor), item.label);
  assert.equal(source.slice(start, start + selection.length), selection);
  if (item.output) {
    assert.match(source.slice(0, start), /\bas\s*$/i, item.label);
    assert.ok(source.slice(0, start).includes('select') || source.slice(0, start).includes('SELECT'));
  }
}

async function runSqlLiveDefinitionChecks(api, vscode, checks) {
  return withDefinitionFixture(async fixture => {
    const { cases, config, restricted, local, table, view, expectedSource, actor } = fixture;
    const definitions = async source => {
      const { text, offset } = atCursor(source);
      const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: text });
      await vscode.window.showTextDocument(doc);
      const position = doc.positionAt(offset);
      const results = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', doc.uri, position);
      assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), doc.uri.toString(), 'Definition request must leave focus on the SQL reference.');
      return { doc, position, results };
    };
    const targetFrom = items => items.find(item => (item.uri || item.targetUri)?.scheme === 'rocketbrain-object-source');
    const lookup = async item => {
      const result = await definitions(item.text);
      const link = targetFrom(result.results);
      assert.ok(link, 'Missing DDL link for ' + item.label);
      const document = await vscode.workspace.openTextDocument(link.uri || link.targetUri);
      const selection = link.range || link.targetSelectionRange;
      assert.equal(document.getText(), await expectedSource(item.object), item.label);
      verifySelection(item, document.getText(), document.getText(selection), document.offsetAt(selection.start));
      return { ...result, document, uri: document.uri.toString() };
    };
    try {
      await api.connectMysql(config);
      await api.sqlAnalysis.refreshMetadata();
      for (const item of cases) {
        const found = await lookup(item);
        if (item.label === 'remote column' || item.label === 'Spring column') {
          const hovers = await vscode.commands.executeCommand('vscode.executeHoverProvider', found.doc.uri, found.position);
          const values = hovers.flatMap(hover => hover.contents.map(value => typeof value === 'string' ? value : value.value)).join('\n');
          assert.ok(values.includes(item.object.schema + '.' + item.object.name + '.' + item.anchor));
          assert.match(values, /DDL was read from the current account/);
        }
      }
      const cte = await definitions('WITH t(person_key) AS (SELECT p.id FROM rb_spring_person p) SELECT t.person_|key FROM t');
      assert.ok(cte.results.some(value => (value.uri || value.targetUri).toString() === cte.doc.uri.toString()));
      assert.equal(targetFrom(cte.results), undefined);
      for (const source of ['SELECT COU|NT(*) FROM rb_spring_person', 'USE ' + quote(local) + '; SELECT * FROM rb_spring_per|son',
        'SELECT missing.i|d FROM rb_spring_person p']) assert.equal(targetFrom((await definitions(source)).results), undefined);

      const tableColumn = cases.find(item => item.label === 'table column');
      const earlier = await lookup(tableColumn), before = earlier.document.getText();
      await actor.query('ALTER TABLE ' + qualified(local, table) + ' ADD COLUMN fresh_navigation_probe INT');
      const latest = await lookup(tableColumn);
      assert.notEqual(latest.uri, earlier.uri);
      assert.equal(earlier.document.getText(), before);
      assert.match(latest.document.getText(), /fresh_navigation_probe/);

      await api.connectMysql(restricted);
      await api.sqlAnalysis.refreshMetadata();
      await assert.rejects(api.objectSources.definition({ object: { schema: local, name: view, kind: 'view' } }),
        { code: 'ROCKETBRAIN_OBJECT_SOURCE_PERMISSION' });
      assert.equal(targetFrom((await definitions(cases.find(item => item.label === 'view output').text)).results), undefined);
      checks.push('SQL Go to Definition selects exact tokens in fresh read-only table, view, and routine DDL and leaves CTE navigation within the query.');
      checks.push('Explicit remote references distinguish identical names across schemas, while Quick Info uses observed metadata. Withheld sources produce no location.');
      return { nativeProviders: true, objectTargets: cases.length, localCte: true, quickInfoRemote: true,
        exactDDL: true, externalDdlNewSnapshot: true, livePermissionDenial: true };
    } finally { await api.disconnectMysql(); }
  });
}

function sourceHost(getDb) {
  const { registerObjectSources } = require('../src/db/object-source-vscode');
  let provider;
  const disposable = () => ({ dispose() {} });
  const Position = offset => ({ offset });
  const host = {
    EventEmitter: class { event = () => disposable(); fire() {} dispose() {} },
    Uri: { from: value => ({ ...value, toString: () => value.scheme + ':' + value.path }) },
    Range: class { constructor(start, end) { Object.assign(this, { start, end }); } },
    Location: class { constructor(uri, range) { Object.assign(this, { uri, range }); } },
    commands: { registerCommand: disposable },
    workspace: {
      isTrusted: true,
      onDidCloseTextDocument: disposable,
      registerTextDocumentContentProvider(scheme, value) { provider = value; return disposable(); },
      async openTextDocument(uri) {
        const text = provider.provideTextDocumentContent(uri);
        return { uri, positionAt: Position, getText: () => text };
      }
    },
    window: { showTextDocument: assert.fail }
  };
  const database = { onDidChangeDatabase: disposable, withDatabaseAdmin: action => action({ db: getDb(), epoch: 1, guard: () => true }) };
  return { sources: registerObjectSources(host, { database }), text: uri => provider.provideTextDocumentContent(uri) };
}

async function verifySqlLiveDefinitions() {
  const { MysqlService } = require('../src/db/mysql');
  const { liveNavigation, quickInfo } = require('../src/db/sql-live-navigation');
  return withDefinitionFixture(async fixture => {
    const { cases, config, restricted, local, table, view, expectedSource, actor } = fixture;
    const db = new MysqlService(config), limited = new MysqlService(restricted);
    let route = db;
    const host = sourceHost(() => route), sources = host.sources;
    try {
      const catalog = await db.metadata();
      const options = { sqlMode: catalog.sqlMode, dialect: catalog.dialect, tableNameCaseSensitive: catalog.tableNameCaseSensitive };
      const lookup = async item => {
        const { text, offset } = atCursor(item.text);
        let target = liveNavigation(text, offset, catalog, options);
        if (target?.endpoints) {
          const { tables } = await db.joinCompletionCatalog({ endpoints: target.endpoints, includeEdges: false });
          target = liveNavigation(text, offset, catalog, options, tables);
        }
        assert.deepEqual(target?.object, item.object, item.label);
        if (item.member) assert.equal(target.member.name, item.anchor);
        if (item.label === 'remote column' || item.label === 'Spring column') assert.match(quickInfo(target), /NOT NULL/);
        const location = await sources.definition({ ...target, sqlMode: options.sqlMode });
        assert.ok(location, 'No exact selected source for ' + item.label);
        const source = host.text(location.uri), { start, end } = location.range;
        assert.equal(source, await expectedSource(item.object), item.label);
        verifySelection(item, source, source.slice(start.offset, end.offset), start.offset);
        return { location, source };
      };
      for (const item of cases) await lookup(item);
      const chosen = cases.find(item => item.label === 'table column'), earlier = await lookup(chosen);
      await actor.query('ALTER TABLE ' + qualified(local, table) + ' ADD COLUMN fresh_navigation_probe INT');
      const latest = await lookup(chosen);
      assert.notEqual(latest.location.uri.toString(), earlier.location.uri.toString());
      assert.match(latest.source, /fresh_navigation_probe/);
      assert.equal(host.text(earlier.location.uri), earlier.source);
      route = limited;
      await assert.rejects(sources.definition({ object: { schema: local, kind: 'view', name: view } }),
        { code: 'ROCKETBRAIN_OBJECT_SOURCE_PERMISSION' });
      return { nativeProviders: false, objectTargets: cases.length, exactDDL: true, crossSchema: true,
        quickInfoMetadata: true, livePermissionDenial: true, externalDdlNewSnapshot: true };
    } finally {
      sources.dispose();
      await Promise.all([db.dispose(), limited.dispose()]);
    }
  });
}

if (require.main === module) verifySqlLiveDefinitions().then(result => console.log(JSON.stringify(result)), error => {
  console.error(error.stack);
  process.exitCode = 1;
});

module.exports = { runSqlLiveDefinitionChecks, verifySqlLiveDefinitions };
