'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { randomBytes } = require('node:crypto');
const { owned } = require('./schema-stored-diff-host');

const exact = { identifierCase: 'exact', definer: 'include' };
const noOwner = { ...exact, definer: 'ignore' };
const ignoreCase = { ...exact, identifierCase: 'ascii-insensitive' };
const relaxed = { ...ignoreCase, definer: 'ignore' };
const expectedSpring = { people: 2, departments: 1, rolledBackNames: 0 };

async function verifySchemaCompareOptions(runtime, adapter) {
  assert.equal(new URL(runtime.baseUrl).hostname, '127.0.0.1');
  const probeSpring = async () => {
    const response = await fetch(new URL('/probe/testing-state', runtime.baseUrl), { signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), expectedSpring);
  };
  await probeSpring();
  const engine = runtime.dbEngine;
  assert.ok(['mysql', 'mariadb'].includes(engine));
  const peer = engine === 'mysql' ? await require('../scripts/integration-mysql').startMysqlFixture()
    : await require('../scripts/integration-db-fixture').startFixture();
  const prefix = 'rb_opts_' + randomBytes(5).toString('hex') + '_';
  const name = suffix => prefix + suffix;
  const q = suffix => '`' + name(suffix) + '`';
  const prepare = desired => [
    'CREATE TABLE ' + q('records') + ' (`id` INT PRIMARY KEY, `' + (desired ? 'Payload' : 'payload') + '` VARCHAR(30)) ENGINE=InnoDB',
    'CREATE VIEW ' + q('owner_view') + " AS SELECT 'unchanged' AS content",
    'CREATE VIEW ' + q('literal_view') + ' AS SELECT ' + (desired ? "'DEFINER=Literal'" : "'definer=Literal'") + ' AS content',
    'CREATE SQL SECURITY ' + (desired ? 'INVOKER' : 'DEFINER') + ' VIEW ' + q('security_view') + ' AS SELECT 21 AS content',
    'CREATE PROCEDURE ' + q(desired ? 'MixedRoutine' : 'mixedroutine') + '() SELECT 29 AS content',
    'CREATE PROCEDURE ' + q('owner_proc') + '() SELECT 31 AS content',
    ...(desired ? ['CREATE TABLE ' + q('addable') + ' (id INT PRIMARY KEY) ENGINE=InnoDB'] : [])
  ];
  let original, secondary;
  try {
    original = await owned(runtime.dbConfigPath);
    secondary = await owned(peer.configPath);
    assert.equal(original.version, secondary.version);
    for (const sql of prepare(true)) await original.actor.query(sql);
    // Only the throwaway peer's scoped fixture callback supplies a distinct, existing DEFINER account.
    await peer.withAdmin(async admin => {
      await admin.query('USE `rocketbrain_fixture`');
      for (const sql of prepare(false)) await admin.query(sql);
      const privilege = engine === 'mysql' ? 'SHOW_ROUTINE' : 'SHOW CREATE ROUTINE';
      await admin.query('GRANT ' + privilege + ' ON *.* TO ?@?', [secondary.config.user, '127.0.0.1']);
    });
    await adapter.connect(original.config);
    const desired = await adapter.capture({ includeStoredObjects: true });
    await adapter.connect(secondary.config);
    const current = await adapter.capture({ includeStoredObjects: true });
    assert.notEqual(current.server.serverUniqueId, desired.server.serverUniqueId);
    const profile = options => adapter.compare(desired, { current, ...(options && { comparisonOptions: options }) });
    const strict = await profile(), include = await profile(exact), ownerOnly = await profile(noOwner);
    const caseOnly = await profile(ignoreCase);
    const combined = await adapter.compare(desired, { comparisonOptions: relaxed });
    const changed = (report, suffix) => report.changes.some(change => change.table === name(suffix));
    const routine = report => report.storedObjects.differences.filter(change => change.name.toLowerCase() === name('mixedroutine'));
    assert.equal(strict.changes.find(change => change.table === name('addable')).selectable, true);
    assert.equal(changed(include, 'records'), true);
    assert.equal(changed(ownerOnly, 'records'), true);
    assert.equal(changed(caseOnly, 'records'), false, JSON.stringify(caseOnly.changes));
    assert.equal(changed(combined, 'records'), false);
    assert.equal(changed(include, 'owner_view'), true);
    assert.equal(changed(ownerOnly, 'owner_view'), false, JSON.stringify(ownerOnly.changes));
    assert.equal(changed(caseOnly, 'owner_view'), true);
    assert.equal(changed(combined, 'owner_view'), false);
    for (const suffix of ['literal_view', 'security_view', 'addable']) assert.ok(changed(combined, suffix));
    assert.equal(routine(include).length, 2);
    assert.equal(routine(ownerOnly).length, 2);
    assert.equal(routine(caseOnly).length, 1);
    assert.equal(routine(combined).length, 0);
    assert.ok(caseOnly.storedObjects.differences.some(change => change.name === name('owner_proc')));
    assert.ok(!combined.storedObjects.differences.some(change => change.name === name('owner_proc')));
    assert.ok(combined.storedObjects.matchedByOptions >= 2);
    for (const report of [include, ownerOnly, caseOnly, combined]) {
      assert.equal(report.executedSql, false);
      assert.equal(report.reviewOnly, true);
      assert.equal(report.summary.selectable, 0);
      assert.equal(report.currentFingerprint, current.fingerprint);
      assert.equal(report.desiredFingerprint, desired.fingerprint);
      assert.equal(report.currentServer.tableNameCaseSensitive, current.server.tableNameCaseSensitive);
      assert.equal(report.caseCollisions, 0);
      assert.ok(report.changes.every(change => !change.sql));
    }
    const ordinaryId = strict.changes.find(change => change.table === name('addable')).id;
    await assert.rejects(adapter.plan(combined.id, [ordinaryId]), /review-only/);
    await assert.rejects(adapter.planRebuild(combined.id, [name('records')]), /review-only/);
    const originalDdl = current.tables.find(table => table.name === name('owner_view')).createSql;
    const wantedDdl = desired.tables.find(table => table.name === name('owner_view')).createSql;
    assert.notEqual(originalDdl, wantedDdl);
    if (adapter.openDiff) await adapter.openDiff(combined, name('owner_view'), originalDdl, wantedDdl);
    const after = await adapter.capture({ includeStoredObjects: true });
    assert.equal(after.fingerprint, current.fingerprint);
    assert.equal(after.storedObjects.fingerprint, current.storedObjects.fingerprint);
    await probeSpring();
    return { engine, version: original.version, distinctServerIdentities: true, exactAndFoldedIdentifiers: true,
      caseSensitiveServerLookup: current.server.tableNameCaseSensitive, independentDefinerOption: true,
      bodyLiteralsAndSecurityRetained: true, storedNamesPairedAndOwnerProjected: true,
      rawDdlReadonly: Boolean(adapter.openDiff), originalFingerprintsRetained: true, noMigrationOrRebuildAuthorization: true,
      noLiveSchemaChange: true, springIsolation: expectedSpring };
  } finally {
    try { await adapter.disconnect(); }
    finally {
      try {
        if (original) {
          try {
            for (const [kind, suffix] of [['VIEW', 'security_view'], ['VIEW', 'literal_view'], ['VIEW', 'owner_view'],
              ['PROCEDURE', 'MixedRoutine'], ['PROCEDURE', 'owner_proc'], ['TABLE', 'addable'], ['TABLE', 'records']]) {
              await original.actor.query('DROP ' + kind + ' IF EXISTS ' + q(suffix));
            }
          } finally { await original.actor.end(); }
        }
      } finally {
        try { await secondary?.actor.end(); }
        finally { await peer.stop(); }
      }
    }
  }
}

async function runSchemaCompareOptionsChecks(api, vscode, checks) {
  const runtime = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const comparison = api.schemaComparison;
  const result = await verifySchemaCompareOptions(runtime, {
    connect: config => api.connectMysql({ ...config, readOnly: true }),
    disconnect: () => api.disconnectMysql(),
    capture: options => comparison.capture(options),
    compare: (desired, options) => comparison.compare(desired, options),
    plan: (id, changes) => comparison.plan(id, changes),
    planRebuild: (id, tables) => comparison.planRebuild(id, tables),
    async openDiff(report, tableName, original, wanted) {
      const review = await vscode.workspace.openTextDocument(vscode.Uri.parse('rocketbrain-schema-compare:/' + report.id + '/comparison.md'));
      assert.match(review.getText(), /ASCII case-insensitive/u);
      assert.match(review.getText(), /ignored in recognized CREATE headers/u);
      assert.match(review.getText(), /lower_case_table_names/u);
      const pair = report.definitionPairs.find(value => value.desired === tableName);
      const diff = await comparison.openDefinitionDiff(report.id, pair.id);
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(diff.current));
      const desired = await vscode.workspace.openTextDocument(vscode.Uri.parse(diff.desired));
      assert.equal(doc.getText().replaceAll('\r\n', '\n'), original.replaceAll('\r\n', '\n'));
      assert.equal(desired.getText().replaceAll('\r\n', '\n'), wanted.replaceAll('\r\n', '\n'));
      await vscode.window.showTextDocument(doc, { preview: false });
      await vscode.commands.executeCommand('type', { text: '-- readonly probe' });
      assert.equal(doc.getText().replaceAll('\r\n', '\n'), original.replaceAll('\r\n', '\n'));
      assert.equal(doc.isDirty, false);
      const commands = await vscode.commands.getCommands(true);
      assert.ok(commands.includes('rocketbrain.schema.compareSnapshotWithOptions'));
      assert.ok(commands.includes('rocketbrain.schema.openComparedDefinition'));
    }
  });
  checks.push('Compared independent identifier case and DEFINER options across two distinct servers without authorizing DDL.');
  checks.push('Preserved body literals and SQL SECURITY, opened exact read-only DDL, and verified database fingerprints and Spring JDBC state.');
  return result;
}

module.exports = { verifySchemaCompareOptions, runSchemaCompareOptionsChecks };
