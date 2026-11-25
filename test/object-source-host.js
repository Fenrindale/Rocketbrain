'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const mysql = require('mysql2/promise');

const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const quote = value => '`' + value.replaceAll('`', '``') + '`';

async function waitForText(document, expected) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (document.getText() === expected) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(document.getText(), expected);
}

async function runObjectSourceChecks(api, vscode, checks) {
  const runtime = await read(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG);
  const config = await read(runtime.dbConfigPath);
  const owner = await read(path.join(path.dirname(runtime.dbConfigPath), 'owner.json'));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(owner.kind));
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.database, 'rocketbrain_fixture');
  assert.equal(runtime.dbEngine, process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE);
  assert.equal(new URL(runtime.baseUrl).hostname, '127.0.0.1');
  const db = await mysql.createConnection(config), viewer = api.objectSources;
  const prefix = 'rb41_source_' + randomBytes(4).toString('hex');
  const schema = config.database, target = suffix => quote(schema) + '.' + quote(prefix + suffix);
  const cleanup = [], examples = [];
  const ddl = async (kind, statement, suffix, field, tail) => {
    await db.query('CREATE ' + statement + ' ' + target(suffix) + ' ' + tail);
    cleanup.unshift('DROP ' + statement + ' IF EXISTS ' + target(suffix));
    examples.push({ schema, name: prefix + suffix, kind, statement, field });
  };
  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes('rocketbrain.db.openObjectSource') && commands.includes('rocketbrain.db.refreshObjectSource'));
  try {
    await ddl('table', 'TABLE', '_table', 'Create Table', '(id INT PRIMARY KEY, value INT, KEY rb_key_value (value)) ENGINE=InnoDB');
    await ddl('view', 'VIEW', '_view', 'Create View', 'AS SELECT id, value FROM ' + target('_table'));
    await ddl('procedure', 'PROCEDURE', '_proc', 'Create Procedure', '(IN n INT) BEGIN SELECT n + 1; END');
    await ddl('function', 'FUNCTION', '_func', 'Create Function', '(n INT) RETURNS INT DETERMINISTIC NO SQL RETURN n + 1');
    await ddl('trigger', 'TRIGGER', '_trigger', 'SQL Original Statement',
      'BEFORE INSERT ON ' + target('_table') + ' FOR EACH ROW BEGIN SET NEW.value = COALESCE(NEW.value, 1); END');
    await ddl('event', 'EVENT', '_event', 'Create Event',
      'ON SCHEDULE AT CURRENT_TIMESTAMP + INTERVAL 1 DAY DISABLE DO SET @rb_viewer_fixture = 1');
    if (runtime.dbEngine === 'mariadb') {
      await ddl('sequence', 'SEQUENCE', '_sequence', 'Create Table', 'START WITH 29 INCREMENT BY 3');
      const [[{ mode }]] = await db.query('SELECT @@SESSION.sql_mode AS mode');
      await db.query("SET SESSION sql_mode='ORACLE'");
      try {
        await ddl('package', 'PACKAGE', '_pack', 'Create Package', 'AS PROCEDURE put_value(n INT); END');
        await ddl('package-body', 'PACKAGE BODY', '_pack', 'Create Package Body', 'AS PROCEDURE put_value(n INT) AS BEGIN NULL; END; END');
      } finally { await db.query('SET SESSION sql_mode=?', [mode]); }
    }
    await api.connectMysql(config);
    const schemas = await viewer.listSchemas({ prefix: 'rocketbrain' });
    assert.equal(schemas.dialect, runtime.dbEngine);
    const selected = schemas.items.find(item => item.name === schema);
    assert.deepEqual(selected, { schema, name: schema, kind: 'schema' });
    const schemaSource = await viewer.open(selected);
    const [[schemaCreate]] = await db.query('SHOW CREATE DATABASE ' + quote(schema));
    assert.equal(schemaSource.source, schemaCreate['Create Database']);
    const insertsBefore = await db.query('SELECT COUNT(*) AS n FROM ' + target('_table'));
    let viewedTable;
    for (const { schema, name, kind, statement, field } of examples) {
      const names = await viewer.listObjects({ kind, schema, prefix });
      const choice = names.items.find(item => item.name === name);
      assert.deepEqual(choice, { schema, name, kind });
      const opened = await viewer.open(choice), uri = vscode.Uri.parse(opened.documentUri);
      const [[direct]] = await db.query('SHOW CREATE ' + statement + ' ' + quote(schema) + '.' + quote(name));
      assert.equal(opened.source, direct[field]);
      assert.equal(opened.rowDataIncluded, false);
      assert.equal(uri.scheme, 'rocketbrain-object-source');
      const document = await vscode.workspace.openTextDocument(uri);
      assert.equal(document.getText(), opened.source);
      assert.equal(document.languageId, 'sql');
      if (kind === 'table') viewedTable = { uri, document };
    }

    const fromTree = await vscode.commands.executeCommand('rocketbrain.db.openObjectSource', { table: { kind: 'table', name: 'rb_spring_person' } });
    assert.equal(fromTree.object.name, 'rb_spring_person');
    assert.ok(fromTree.source.startsWith('CREATE TABLE'));
    const sourceEditor = vscode.window.activeTextEditor;
    assert.equal(sourceEditor?.document.uri.toString(), fromTree.documentUri);
    await vscode.commands.executeCommand('type', { text:'-- Read-only probe\n' });
    assert.equal(sourceEditor.document.getText(), fromTree.source);
    assert.equal(sourceEditor.document.isDirty, false);

    await db.query('ALTER TABLE ' + target('_table') + ' ADD COLUMN refreshed INT');
    const newSource = await vscode.commands.executeCommand('rocketbrain.db.refreshObjectSource', viewedTable.uri);
    assert.equal(newSource.documentUri, viewedTable.uri.toString());
    assert.match(newSource.source, /refreshed/);
    await waitForText(viewedTable.document, newSource.source);
    assert.deepEqual((await db.query('SELECT COUNT(*) AS n FROM ' + target('_table')))[0], insertsBefore[0]);

    let crossSchema = false;
    if (process.env.ROCKETBRAIN_SCHEMA_CROSS_CONFIG) {
      const cross = await read(process.env.ROCKETBRAIN_SCHEMA_CROSS_CONFIG);
      assert.equal(cross.fixtureId, owner.id);
      assert.ok(cross.schemas.includes('rocketbrain_related'));
      const name = prefix + '_cross', table = quote('rocketbrain_related') + '.' + quote(name);
      await db.query('CREATE TABLE ' + table + ' (other_id INT PRIMARY KEY)');
      cleanup.unshift('DROP TABLE IF EXISTS ' + table);
      const crossPage = await viewer.listObjects({ kind: 'table', schema: 'rocketbrain_related', prefix });
      assert.deepEqual(crossPage.items, [{ schema: 'rocketbrain_related', name, kind: 'table' }]);
      const source = await viewer.open(crossPage.items[0]);
      const [[direct]] = await db.query('SHOW CREATE TABLE ' + table);
      assert.equal(source.source, direct['Create Table']);
      crossSchema = true;
    }

    let permissionDenied = false;
    if (process.env.ROCKETBRAIN_DBADMIN_TEST_CONFIG) {
      const restricted = await read(process.env.ROCKETBRAIN_DBADMIN_TEST_CONFIG);
      assert.equal(restricted.sourceConfigPath, runtime.dbConfigPath);
      assert.equal(restricted.owner, owner.id);
      assert.equal(restricted.admin.port, config.port);
      await api.connectMysql(restricted.admin);
      const page = await viewer.listObjects({ schema, kind: 'view', prefix });
      assert.ok(page.items.some(item => item.name === prefix + '_view'));
      await assert.rejects(viewer.open(page.items[0]), { code: 'ROCKETBRAIN_OBJECT_SOURCE_PERMISSION' });
      permissionDenied = true;
    } else {
      await api.disconnectMysql();
    }
    await assert.rejects(viewer.refresh(viewedTable.uri), /Open the database object source/);
    await waitForText(viewedTable.document, '-- This database source is no longer available on the current connection. Open the object source again.');
    const response = await fetch(runtime.baseUrl + '/probe/testing-state', { signal: AbortSignal.timeout(9000) });
    const springIsolation = { people: 2, departments: 1, rolledBackNames: 0 };
    assert.equal(response.ok, true);
    assert.deepEqual(await response.json(), springIsolation);
    checks.push('Opened exact server object sources as native read-only SQL documents, refreshed one definition, and expired its view on a connection change.');
    return { engine: runtime.dbEngine, kinds: ['schema', ...examples.map(item => item.kind)], sourceCompared: true, treeSource: true,
      readOnlyDocument: true, refreshed: true, connectionChanged: true, crossSchema, permissionDenied, springIsolation };
  } finally {
    try {
      const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input?.uri?.scheme === 'rocketbrain-object-source');
      if (tabs.length) await vscode.window.tabGroups.close(tabs);
      await api.disconnectMysql();
    } finally {
      try { for (const statement of cleanup) await db.query(statement); }
      finally { await db.end(); }
    }
  }
}

module.exports = { runObjectSourceChecks };
