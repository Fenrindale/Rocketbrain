'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const mysql = require('mysql2/promise');

const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));

async function verifySavedVirtualSchemas(runtime, adapter) {
  const config = await read(runtime.dbConfigPath);
  const folder = path.dirname(runtime.dbConfigPath);
  const owner = await read(path.join(folder, 'owner.json'));
  const cross = await read(path.join(folder, 'cross-schema.json'));
  assert.deepEqual(cross.schemas, [config.database, 'rocketbrain_related']);
  assert.equal(cross.fixtureId, owner.id);
  assert.ok(['RocketbrainDisposableOracleMysqlFixture-v1', 'RocketbrainDisposableMariaDbFixture-v1'].includes(owner.kind));
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.database, 'rocketbrain_fixture');
  assert.ok(Number.isInteger(config.port) && config.port >= 1024 && config.port <= 65535);
  const connect = next => adapter.connectMysql(next ?? config);
  const raw = await mysql.createConnection(config), sql = adapter.sql, overlays = sql.virtualSchemas;
  const suffix = randomBytes(5).toString('hex');
  const base = 'rb_overlay_base_' + suffix, view = 'rb_overlay_' + suffix;
  const peerTable = 'rocketbrain_related.rb_overlay_data_' + suffix;
  const peerView = 'rocketbrain_related.rb_overlay_source_' + suffix;
  const requested = [{ schema: 'rocketbrain_related', name: peerView.split('.')[1], kind: 'view' }];
  const label = 'Virtual catalogue ' + suffix;
  const source = 'ALTER TABLE ' + base + ' ADD COLUMN computed_cost DECIMAL(22,4) GENERATED ALWAYS AS (amount * 2) VIRTUAL;\n' +
    'CREATE VIEW ' + view + ' AS SELECT b.computed_cost, n.caption FROM ' + base + ' b JOIN ' + peerView + ' n ON b.id=n.id;';
  const query = 'SELECT v.computed_cost, v.caption FROM ' + view + ' v';
  let saved;
  try {
    const spring = await adapter.probe();
    assert.equal(spring.people, 2);
    await raw.query('CREATE TABLE ' + base + ' (id INT PRIMARY KEY, amount DECIMAL(18,4) NOT NULL) ENGINE=InnoDB');
    await raw.query('INSERT INTO ' + base + ' SELECT id, 3.5 FROM rb_spring_person');
    await raw.query('CREATE TABLE ' + peerTable + ' (id INT PRIMARY KEY, caption VARCHAR(32)) ENGINE=InnoDB');
    await raw.query('INSERT INTO ' + peerTable + " VALUES(1,'compared')");
    const external = alias => 'CREATE VIEW ' + peerView + ' AS SELECT id, caption AS ' + alias + ' FROM ' + peerTable;
    await raw.query(external('caption'));
    await connect();
    const document = await adapter.open(query);
    assert.notEqual(sql.analyzeDocument(document).state, 'known');
    await assert.rejects(overlays.save({ label, source: 'DROP TABLE ' + base }), /accept CREATE VIEW/);
    saved = await overlays.save({ label, source });
    assert.deepEqual(saved.externalInputs, requested);
    assert.deepEqual(saved.changes.map(value => value.action), ['alter', 'create']);
    const applied = await overlays.use(document, saved.id);
    assert.equal(applied.state, 'known', JSON.stringify(applied.unknown));
    assert.equal(applied.catalogVisibility, 'saved-virtual-schema');
    assert.equal(applied.executedSql, false);
    assert.equal(applied.virtualSchema.revision, 1);
    assert.equal(applied.validityVerified, false);
    assert.deepEqual(applied.statements[0].model.projections.map(p => p.type.dbType.toLowerCase()), ['decimal(22,4)', 'varchar(32)']);
    assert.equal(sql.analysisOnly(document), true);
    assert.ok((await adapter.complete(document, query.indexOf('v.computed_cost') + 2)).includes('computed_cost'));
    assert.throws(() => sql.prepareRename(document, document.positionAt(query.indexOf('computed_cost'))), /virtual DDL preview/);
    await adapter.assertScriptBlocked(document);

    const next = await overlays.save({ ...saved, label, source: source.replace('22,4', '24,6') });
    assert.equal(next.revision, 2);
    assert.equal(sql.analyzeDocument(document).reason, 'virtual-schema-stale');
    assert.equal(sql.analysisOnly(document), true);
    await connect({ ...config, database: 'rocketbrain_related' });
    assert.ok(!overlays.list().some(record => record.id === saved.id));
    assert.equal(sql.analyzeDocument(document).reason, 'virtual-schema-stale');
    assert.equal(sql.analysisOnly(document), true);
    await connect();
    assert.equal(overlays.read(saved.id).revision, 2);
    assert.equal((await overlays.use(document, saved.id)).statements[0].model.projections[0].type.dbType.toLowerCase(), 'decimal(24,6)');

    await raw.query('DROP VIEW ' + peerView);
    await raw.query(external('changed_caption'));
    await sql.refreshMetadata();
    assert.equal(sql.analyzeDocument(document).reason, 'virtual-schema-stale');
    await assert.rejects(overlays.use(document, saved.id), /could not be bound to known columns/);
    assert.equal(sql.analysisOnly(document), true);
    const [columns] = await raw.execute('SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?', [base, 'computed_cost']);
    const [views] = await raw.execute('SELECT TABLE_NAME FROM information_schema.VIEWS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?', [view]);
    assert.deepEqual(columns, []);
    assert.deepEqual(views, []);
    assert.deepEqual(await adapter.probe(), spring);
    assert.equal(await overlays.remove(saved.id, 2), true);
    saved = undefined;
    assert.ok(!overlays.list().some(record => record.label === label));
    assert.equal(sql.clearDdlPreview(document), true);
    assert.equal(sql.analysisOnly(document), false);
    return { savedRevisionReopened: 2, routeIsolation: true, crossSchemaView: true, generatedDecimal: true, completion: true,
      overlayExecutionAndRenameBlocked: true, changedExternalViewRefused: true, physicalCatalogUnchanged: true, spring };
  } finally {
    try {
      if (saved) {
        await connect();
        const remaining = overlays.list().find(record => record.id === saved.id);
        if (remaining) await overlays.remove(remaining.id, remaining.revision);
      }
      await raw.query('DROP VIEW IF EXISTS ' + peerView);
      await raw.query('DROP TABLE IF EXISTS ' + peerTable);
      await raw.query('DROP TABLE IF EXISTS ' + base);
    } finally { await raw.end(); }
  }
}

async function runVirtualSchemaOverlayChecks(api, vscode, checks) {
  const runtime = await read(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG);
  assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.sql.manageVirtualSchemas'));
  checks.savedVirtualSchemas = await verifySavedVirtualSchemas(runtime, {
    sql: api.sqlAnalysis,
    connectMysql: config => api.connectMysql(config),
    open: content => vscode.workspace.openTextDocument({ language: 'sql', content }),
    async complete(document, offset) {
      const result = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', document.uri, document.positionAt(offset));
      return result.items.map(item => item.label.label ?? item.label);
    },
    assertScriptBlocked: document => assert.rejects(api.sqlScripts.describe(document), /Exit the saved virtual schema preview/),
    async probe() {
      const response = await fetch(runtime.baseUrl + '/probe/testing-state', { signal: AbortSignal.timeout(5000) });
      assert.ok(response.ok);
      return response.json();
    }
  });
}

module.exports = { runVirtualSchemaOverlayChecks, verifySavedVirtualSchemas };
