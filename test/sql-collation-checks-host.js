'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const mysql = require('mysql2/promise');
const { randomBytes } = require('node:crypto');

const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));

async function verifySqlCollationChecks(runtime, adapter) {
  const config = await read(runtime.dbConfigPath), folder = path.dirname(await fs.realpath(runtime.dbConfigPath));
  const owner = await read(path.join(folder, 'owner.json'));
  assert.ok(['RocketbrainDisposableOracleMysqlFixture-v1', 'RocketbrainDisposableMariaDbFixture-v1'].includes(owner.kind));
  assert.equal(owner.id, path.basename(folder));
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.database, 'rocketbrain_fixture');
  assert.equal(runtime.dbEngine, owner.kind.includes('MariaDb') ? 'mariadb' : 'mysql');
  const actor = await mysql.createConnection(config), table = 'rb_collation_fixture_' + randomBytes(5).toString('hex');
  const direct = 'SELECT p.label COLLATE latin1_swedish_ci FROM ' + table + ' p';
  const nested = 'WITH c AS (SELECT p.label FROM ' + table + ' p) SELECT c.label COLLATE latin1_swedish_ci FROM c';
  const explicit = "SELECT _utf8mb4'x' COLLATE utf8mb4_general_ci = _utf8mb4'X' COLLATE utf8mb4_unicode_ci";
  const mismatch = 'ER_COLLATION_CHARSET_MISMATCH', clash = 'ER_CANT_AGGREGATE_2COLLATIONS', unknown = 'ER_UNKNOWN_COLLATION';
  const cases = [
    [direct, mismatch, 'sql.collation.charset', 'latin1_swedish_ci'],
    [nested, mismatch, 'sql.collation.charset', 'latin1_swedish_ci'],
    ['SELECT CAST(label AS CHAR(32) CHARACTER SET latin1) COLLATE utf8mb4_general_ci FROM ' + table, mismatch,
      'sql.collation.charset','utf8mb4_general_ci'],
    [explicit, clash, 'sql.collation.explicitConflict', '='],
    ["SELECT _utf8mb4'x' COLLATE rb_missing_collation", unknown, 'sql.collation.unknown','rb_missing_collation'],
    ['SELECT p.label COLLATE utf8mb4_general_ci FROM ' + table + ' p'],
    ["SELECT _utf8'x' COLLATE utf8_general_ci"],
    ["SELECT _utf8mb4'x' COLLATE utf8mb4_general_ci = _utf8mb4'X' COLLATE utf8mb4_general_ci"],
    runtime.dbEngine === 'mariadb' ? ["SELECT _utf8mb4'x' COLLATE uca1400_ai_ci"] :
      ["SELECT _utf8mb4'x' COLLATE uca1400_ai_ci", unknown, 'sql.collation.unknown','uca1400_ai_ci']
  ];
  try {
    const [[{ datadir }]] = await actor.query('SELECT @@datadir AS datadir');
    assert.equal(path.dirname(await fs.realpath(datadir)).toLowerCase(), folder.toLowerCase());
    const spring = await adapter.probe();
    assert.equal(spring.people, 2);
    await actor.query('CREATE TABLE ' + table + ' (id INT PRIMARY KEY, label VARCHAR(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci) ENGINE=InnoDB');
    await actor.query('INSERT INTO ' + table + " SELECT id, 'verified' FROM rb_spring_person");
    await adapter.connect(config);
    const originalDocument = await adapter.open(direct);
    assert.deepEqual(adapter.inspect(originalDocument), []);
    const lease = await adapter.refresh();
    assert.equal(lease.dialect, runtime.dbEngine);
    assert.equal(lease.executedSql, false);
    assert.ok(lease.collations > 100);
    for (const [sql, error, code, token] of cases) {
      const doc = await adapter.open(sql);
      const checked = adapter.inspect(doc);
      const expected = error ? [[code, token]] : [];
      assert.deepEqual(checked.map(item => [item.code,sql.slice(item.start,item.end)]), expected, sql);
      await adapter.assertDiagnostics?.(doc, expected);
      if (error) await assert.rejects(actor.query(sql), { code: error });
      else await actor.query(sql);
    }
    const boundary = await adapter.open('SELECT 1; SET NAMES latin1; ' + direct);
    assert.deepEqual(adapter.inspect(boundary), []);
    await adapter.assertVirtualDisabled?.(originalDocument);
    await adapter.assertLiveEditorChange?.(originalDocument);
    await adapter.disconnect();
    assert.deepEqual(adapter.inspect(originalDocument), []);
    await adapter.assertDiagnostics?.(originalDocument, []);
    assert.deepEqual(await adapter.probe(), spring);
    return { liveNames: lease.collations, serverParity: cases.length, ranges: true, boundNestedColumn: true, characterCast: true,
      operatorConflict: true, vendorCollations: true, legacyAliasPreserved: true,
      priorContextChangeAndDisconnectClear: true, nativeLiveEditorChange: Boolean(adapter.assertLiveEditorChange),
      userQueryExecutedByChecker: false, spring };
  } finally {
    try { await actor.query('DROP TABLE IF EXISTS ' + table); }
    finally { await actor.end(); }
  }
}

async function runSqlCollationChecks(api, vscode, checks) {
  const runtime = await read(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG);
  assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.sql.refreshCollationChecks'));
  checks.sqlCollationChecks = await verifySqlCollationChecks(runtime, {
    connect: config => api.connectMysql(config),
    disconnect: () => api.disconnectMysql(),
    refresh: () => vscode.commands.executeCommand('rocketbrain.sql.refreshCollationChecks'),
    inspect: api.sqlCollations.inspect,
    open: text => vscode.workspace.openTextDocument({language:'sql',content:text}),
    async assertDiagnostics(document, expected) {
      const diagnostics = vscode.languages.getDiagnostics(document.uri).filter(item => String(item.code).startsWith('sql.collation.'));
      assert.deepEqual(diagnostics.map(item => [item.code, document.getText(item.range)]), expected);
    },
    async assertVirtualDisabled(document) {
      const diagnostics = () => vscode.languages.getDiagnostics(document.uri).filter(item => String(item.code).startsWith('sql.collation.'));
      await api.sqlAnalysis.useDdlPreview(document);
      assert.deepEqual(diagnostics(), []);
      assert.equal(api.sqlAnalysis.clearDdlPreview(document), true);
      assert.equal(diagnostics().length, 1);
    },
    async assertLiveEditorChange(document) {
      const diagnostics = () => vscode.languages.getDiagnostics(document.uri).filter(item => String(item.code).startsWith('sql.collation.'));
      assert.equal(diagnostics().length, 1);
      const start = document.getText().indexOf('latin1_swedish_ci'), edit = new vscode.WorkspaceEdit();
      const range = new vscode.Range(document.positionAt(start), document.positionAt(start + 'latin1_swedish_ci'.length));
      edit.replace(document.uri, range, 'utf8mb4_general_ci');
      assert.equal(await vscode.workspace.applyEdit(edit), true);
      assert.deepEqual(diagnostics(), []);
    },
    async probe() {
      const response = await fetch(runtime.baseUrl + '/probe/testing-state', {signal:AbortSignal.timeout(5000)});
      assert.ok(response.ok);
      return response.json();
    }
  });
}

module.exports = { verifySqlCollationChecks, runSqlCollationChecks };
