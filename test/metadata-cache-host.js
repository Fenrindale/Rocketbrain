'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const mysql = require('mysql2/promise');

const supportedOwners = ['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'];

async function offlineCatalog(api, vscode, entry, table) {
  assert.equal(api.catalogSnapshot(), null);
  const opened = api.cachedMetadata.open(entry.id, entry.fingerprint);
  assert.equal(opened.capturedAt, entry.capturedAt);
  assert.equal(opened.database, entry.database);
  assert.equal(opened.dialect, entry.dialect);
  const catalog = api.catalogSnapshot();
  assert.deepEqual(catalog.coverage, {});
  assert.equal(catalog.complete, false);
  assert.equal(catalog.visibility, 'cached-current-account');
  const object = catalog.tables.find(item => item.name === table);
  assert.ok(object);
  assert.equal(object.columns.find(column => column.name === 'status').type, 'enum');
  const uri = vscode.Uri.from({ scheme: 'rocketbrain-offline-db-metadata',
    path: '/' + entry.id + '/' + entry.fingerprint + '/catalog.txt' });
  const snapshotDocument = await vscode.workspace.openTextDocument(uri);
  assert.equal(snapshotDocument.isUntitled, false);
  assert.ok(snapshotDocument.getText().includes('Captured at ' + entry.capturedAt));
  assert.ok(snapshotDocument.getText().includes('Last matched live at ' + entry.checkedAt));
  assert.match(snapshotDocument.getText(), /Live schema and query validity are unverified/);
  assert.ok(snapshotDocument.getText().includes(table));
  for (const snapshot of [snapshotDocument.getText(), JSON.stringify(catalog)]) {
    assert.doesNotMatch(snapshot, /private_cache_(?:default|comment|enum|row)/);
  }
  const source = 'SELECT t.id, t.missing FROM `' + table + '` t;';
  const query = await vscode.workspace.openTextDocument({ language: 'sql', content: source });
  const report = api.sqlAnalysis.analyzeDocument(query);
  assert.equal(report.state, 'unknown');
  assert.equal(report.validityVerified, false);
  assert.equal(report.executedSql, false);
  assert.equal(report.cachedMetadata.fingerprint, entry.fingerprint);
  assert.ok(vscode.languages.getDiagnostics(query.uri).some(item => item.code === 'sql.catalog.cached'));
  assert.ok(vscode.languages.getDiagnostics(query.uri).every(item => item.severity !== vscode.DiagnosticSeverity.Error));
  await assert.rejects(api.databaseCatalog(), /Connect to MySQL or MariaDB/);
  assert.throws(() => api.sqlAnalysis.prepareRename(query, query.positionAt(source.indexOf('t.id') + 2)), /refresh live metadata/);
  return { checkedAt: opened.checkedAt, columns: object.columns.map(column => column.name) };
}

async function runMetadataCacheChecks(api, vscode, checks = []) {
  const runtime = JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const owner = JSON.parse(fs.readFileSync(path.join(path.dirname(runtime.dbConfigPath), 'owner.json'), 'utf8'));
  assert.ok(supportedOwners.includes(owner.kind));
  const config = JSON.parse(fs.readFileSync(runtime.dbConfigPath, 'utf8'));
  assert.ok(['127.0.0.1', '::1'].includes(config.host));
  const actor = await mysql.createConnection(config);
  const table = 'rb_metadata_cache_' + randomBytes(5).toString('hex');
  let connected = false;
  try {
    await actor.query('CREATE TABLE `' + table + '` (' +
      "id INT NOT NULL PRIMARY KEY, status ENUM('private_cache_enum'), " +
      "note VARCHAR(80) DEFAULT 'private_cache_default' COMMENT 'private_cache_comment')");
    await actor.query('INSERT INTO `' + table + '` (id, note) VALUES (?, ?)', [1, 'private_cache_row']);
    await api.connectMysql(config);
    connected = true;
    const saved = await api.cachedMetadata.capture();
    assert.equal(saved.database, config.database);
    assert.equal(saved.capturedAt, saved.checkedAt);
    assert.equal(saved.dialect, process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE);
    assert.ok(saved.tables > 0);
    await api.disconnectMysql();
    connected = false;
    const offline = await offlineCatalog(api, vscode, saved, table);
    assert.deepEqual(offline.columns, ['id', 'status', 'note']);
    assert.equal(await vscode.commands.executeCommand('rocketbrain.db.closeCachedMetadata'), true);
    assert.equal(api.catalogSnapshot(), null);

    await api.connectMysql(config);
    connected = true;
    const matched = api.cachedMetadata.list().find(item => item.id === saved.id);
    assert.ok(matched.checkedAt >= saved.capturedAt);
    assert.equal(matched.capturedAt, saved.capturedAt);
    assert.equal(matched.fingerprint, saved.fingerprint);
    assert.equal(api.catalogSnapshot().cachedMetadata, undefined);
    await actor.query('ALTER TABLE `' + table + '` ADD COLUMN revised BIGINT UNSIGNED NULL');
    await api.refreshSchema();
    assert.ok(!api.cachedMetadata.list().some(item => item.id === saved.id));
    assert.ok(api.catalogSnapshot().tables.find(item => item.name === table).columns.some(column => column.name === 'revised'));
    const replacement = await api.cachedMetadata.capture();
    assert.equal(replacement.id, saved.id);
    assert.notEqual(replacement.fingerprint, saved.fingerprint);
    await api.disconnectMysql();
    connected = false;
    assert.throws(() => api.cachedMetadata.open(saved.id, saved.fingerprint), /current saved metadata/);
    checks.push('cached table catalog, stale SQL intelligence, live structural invalidation');
    return { explicitOffline: true, redacted: true, liveMatch: true, liveInvalidation: true, restart: { entry: replacement, table } };
  } finally {
    if (connected) await api.disconnectMysql();
    await actor.query('DROP TABLE IF EXISTS `' + table + '`');
    await actor.end();
  }
}

async function checkMetadataCacheRestart(api, vscode, expected) {
  assert.ok(expected?.entry?.id && /^rb_metadata_cache_[a-f0-9]{10}$/.test(expected.table));
  assert.deepEqual(api.cachedMetadata.list().find(item => item.id === expected.entry.id), expected.entry);
  const offline = await offlineCatalog(api, vscode, expected.entry, expected.table);
  assert.deepEqual(offline.columns, ['id', 'status', 'note', 'revised']);
  await api.cachedMetadata.remove(expected.entry.id, expected.entry.fingerprint);
  assert.equal(api.catalogSnapshot(), null);
  assert.ok(!api.cachedMetadata.list().some(item => item.id === expected.entry.id));
  return { survivedHostRestart: true, explicitOffline: true, removed: true, columns: offline.columns };
}

module.exports = { runMetadataCacheChecks, checkMetadataCacheRestart };
