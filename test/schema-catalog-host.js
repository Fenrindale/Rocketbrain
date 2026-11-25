'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const mysql = require('mysql2/promise');
const { jdbcReadback } = require('./java-source-analysis-host');

const read = async filename => JSON.parse(await fs.readFile(filename, 'utf8'));
const quote = value => '`' + value.replaceAll('`', '``') + '`';

async function verifyCatalogSelection(api) {
  const runtime = await read(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG);
  const connection = await read(runtime.dbConfigPath);
  const owner = await read(path.join(path.dirname(runtime.dbConfigPath), 'owner.json'));
  const cross = await read(process.env.ROCKETBRAIN_SCHEMA_CROSS_CONFIG);
  const restricted = await read(process.env.ROCKETBRAIN_DBADMIN_TEST_CONFIG);
  const schemas = [connection.database, 'rocketbrain_related'];
  assert.equal(connection.host, '127.0.0.1');
  assert.equal(connection.database, 'rocketbrain_fixture');
  assert.equal(runtime.dbEngine, process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE);
  assert.equal(new URL(runtime.baseUrl).hostname, '127.0.0.1');
  assert.ok(['RocketbrainDisposableOracleMysqlFixture-v1', 'RocketbrainDisposableMariaDbFixture-v1'].includes(owner.kind));
  assert.equal(cross.fixtureId, owner.id);
  assert.ok(cross.schemas.includes(schemas[1]));
  assert.equal(restricted.owner, owner.id);
  assert.equal(restricted.sourceConfigPath, runtime.dbConfigPath);
  assert.equal(restricted.admin.port, connection.port);
  const db = await mysql.createConnection(connection);
  const name = 'rb_catalog_' + randomBytes(4).toString('hex');
  const objects = schemas.map(schema => ({ schema, name, kind: 'table' }));
  const qualified = object => quote(object.schema) + '.' + quote(object.name);
  const created = [];
  const catalog = api.schemaCatalog;
  try {
    for (const [index, object] of objects.entries()) {
      await db.query('CREATE TABLE ' + qualified(object) + ' (id INT PRIMARY KEY, owned_' + index + ' INT) ENGINE=InnoDB');
      created.unshift(object);
    }
    await api.connectMysql(connection);
    const visible = await catalog.visibleSchemas();
    assert.ok(schemas.every(schema => visible.names.includes(schema)));
    assert.deepEqual(await catalog.select(schemas), schemas);
    assert.deepEqual(catalog.selection(), { schemas, excluded: [] });
    for (const [index, object] of objects.entries()) {
      const { items } = await catalog.list(object.schema, 'table');
      assert.ok(items.some(item => item.name === object.name && item.schema === object.schema));
      const opened = await catalog.open(object);
      const [[current]] = await db.query('SHOW CREATE TABLE ' + qualified(object));
      assert.equal(opened.source, current['Create Table']);
      assert.match(opened.source, new RegExp('owned_' + index));
    }
    assert.equal(api.liveCatalogIdentity().database, schemas[0]);
    await catalog.setExcluded(objects[1], true);
    assert.ok(!(await catalog.list(schemas[1], 'table')).items.some(item => item.name === name));
    assert.ok((await catalog.list(schemas[0], 'table')).items.some(item => item.name === name));
    await assert.rejects(catalog.open(objects[1]), /included database object/);
    await api.connectMysql(restricted.admin);
    assert.ok(!(await catalog.visibleSchemas()).names.includes(schemas[1]));
    assert.deepEqual(catalog.selection(), { schemas: [schemas[0]], excluded: [] });
    await assert.rejects(catalog.select(schemas), /visible to the current account/);
    await assert.rejects(catalog.list(schemas[1], 'table'), /included in the current catalog/);
    await api.connectMysql(connection);
    assert.deepEqual(catalog.selection(), { schemas, excluded: [objects[1]] });
    await catalog.setExcluded(objects[1], false);
    assert.ok((await catalog.list(schemas[1], 'table')).items.some(item => item.name === name));
    assert.deepEqual(catalog.selection(), { schemas, excluded: [] });
    const jdbc = await jdbcReadback();
    assert.deepEqual(jdbc, { people: 2, departments: 1, rolledBackNames: 0 });
    return { engine: runtime.dbEngine, concurrentSchemas: 2, exactDdl: 2, sameNameExclusionIsolated: true,
      selectionRetainedOnReconnect: true, hiddenSchemaRejected: true, sqlDefaultPreserved: true, jdbc };
  } finally {
    try { await api.disconnectMysql(); }
    finally {
      try { for (const object of created) await db.query('DROP TABLE IF EXISTS ' + qualified(object)); }
      finally { await db.end(); }
    }
  }
}

async function runSchemaCatalogChecks(api, vscode, checks) {
  const commands = await vscode.commands.getCommands(true);
  for (const name of ['select', 'refresh', 'hide', 'restore', 'open']) {
    assert.ok(commands.includes('rocketbrain.schemaCatalog.' + name));
  }
  const report = await verifyCatalogSelection(api);
  checks.push('Installed catalog selection, scoped DDL and object exclusions stayed bound to the chosen connection and schemas.');
  return { ...report, nativeCatalogCommands: true };
}

module.exports = { runSchemaCatalogChecks, verifyCatalogSelection };
