'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');
const mysql = require('mysql2/promise');
const { jdbcReadback } = require('./java-source-analysis-host');

async function runDedicatedProfileConsoleChecks(api, vscode, checks) {
  const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
  const runtime = await read(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG);
  const config = await read(runtime.dbConfigPath);
  const owner = await read(path.join(path.dirname(runtime.dbConfigPath), 'owner.json'));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(owner.kind));
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.database, 'rocketbrain_fixture');
  const table = 'rb_console_route_' + randomBytes(5).toString('hex');
  const main = config.database, other = 'rocketbrain_related';
  const actor = await mysql.createConnection(config), profiles = api.dbConnections;
  const created = [];
  const sourceProfile = (name, database, writeProtection) => ({ id: randomUUID(), name, group: 'Owned routing test', color: 'none',
    host: config.host, port: config.port, user: config.user, database, tls: { mode: 'disabled' }, ...(writeProtection && { writeProtection }) });
  const controls = api.dbSessionTools;
  const select = 'SELECT DATABASE(), label FROM ' + table + ' WHERE id=1;';
  const jdbcBaseline = { people: 2, departments: 1, rolledBackNames: 0 };
  const documents = new Set();

  async function remember(profile) {
    const saved = await profiles.save({ profile, password: config.password, rememberPassword: true });
    created.push(saved);
    return saved;
  }
  async function activate(document) {
    documents.add(document);
    return vscode.window.showTextDocument(document, { preview: false });
  }
  async function query(document, sql = select) {
    const editor = await activate(document);
    const text = document.getText();
    if (text !== sql) assert.equal(await editor.edit(edit => {
      edit.replace(new vscode.Range(document.positionAt(0), document.positionAt(text.length)), sql);
    }), true);
    editor.selection = new vscode.Selection(document.positionAt(0), document.positionAt(sql.length));
    const resultId = await vscode.commands.executeCommand('rocketbrain.runQuery');
    const result = api.results().find(item => item.id === resultId);
    assert.ok(result?.result, result?.error || 'The native SQL command returned no result.');
    return result;
  }
  async function open(saved) {
    const result = await vscode.commands.executeCommand('rocketbrain.connections.openDedicatedConsole', { profileId: saved.id });
    assert.equal(result.profile.id, saved.id);
    const uri = vscode.Uri.parse(result.uri);
    assert.equal(uri.scheme, 'rocketbrain-profile-sql');
    const document = await vscode.workspace.openTextDocument(uri);
    assert.equal(document.languageId, 'sql');
    return { document, id: result.sessionId };
  }

  try {
    for (const [schema, label] of [[main, 'active'], [other, 'dedicated']]) {
      await actor.query(`CREATE TABLE ${schema}.${table} (id INT PRIMARY KEY,label VARCHAR(20)) ENGINE=InnoDB`);
      await actor.execute(`INSERT INTO ${schema}.${table} VALUES (1,?)`, [label]);
    }
    assert.deepEqual(await jdbcReadback(), jdbcBaseline);
    const primary = await remember(sourceProfile('Primary', main));
    const secondary = await remember(sourceProfile('Secondary', other));
    const protectedSource = await remember(sourceProfile('Protected secondary', other, { connectionReadOnly: true }));
    await profiles.connect({ id: primary.id });
    const ordinary = await vscode.workspace.openTextDocument({ language: 'sql', content: select });
    const active = await query(ordinary);
    assert.deepEqual(active.result.rows, [[main, 'active']]);
    const first = await open(secondary), protectedConsole = await open(protectedSource);
    assert.equal(await first.document.save(), true);
    assert.deepEqual((await query(first.document)).result.rows, [[other, 'dedicated']]);
    assert.equal(await first.document.save(), true);
    assert.equal(Buffer.from(await vscode.workspace.fs.readFile(first.document.uri)).toString(), select);
    assert.deepEqual((await query(protectedConsole.document)).result.rows, [[other, 'dedicated']]);
    assert.equal(api.activeConnectionProfile().id, primary.id);
    assert.equal((await api.databaseCatalog()).database, main);
    assert.equal(api.sqlAnalysis.analyzeDocument(first.document).state, 'disabled');
    await assert.rejects(api.describeSqlScript(select, { document: first.document }), /active database/);
    await assert.rejects(api.configureConsoleSession(protectedConsole.id, { readOnly: false }), /read.only/i);
    await assert.rejects(profiles.remove({ id: secondary.id, expectedRevision: secondary.revision }), /dedicated SQL sessions/i);
    await assert.rejects(profiles.save({ profile: { ...secondary.profile, database: main }, expectedRevision: secondary.revision }), /dedicated SQL sessions/i);

    const isolated = await controls.inspectConsoleIsolation(first.document);
    await activate(first.document);
    const shared = (await vscode.commands.executeCommand('rocketbrain.openSharedConsole')).document;
    const sibling = await controls.inspectConsoleIsolation(shared);
    assert.equal(sibling.connectionId, isolated.connectionId);
    assert.notEqual((await controls.inspectConsoleIsolation(ordinary)).connectionId, isolated.connectionId);
    assert.notEqual((await controls.inspectConsoleIsolation(protectedConsole.document)).connectionId, isolated.connectionId);
    await api.configureConsoleSession(first.id, { readOnly: false, autocommit: false });
    await activate(first.document);
    await vscode.commands.executeCommand('rocketbrain.beginTransaction');
    await query(first.document, `UPDATE ${table} SET label='pending' WHERE id=1;`);
    assert.deepEqual((await query(shared)).result.rows, [[other, 'pending']]);
    assert.deepEqual((await query(protectedConsole.document)).result.rows, [[other, 'dedicated']]);
    assert.deepEqual((await query(ordinary)).result.rows, [[main, 'active']]);
    await profiles.disconnect();
    assert.equal(api.activeConnectionProfile(), null);
    assert.equal((await controls.inspectConsoleIsolation(shared)).connectionId, isolated.connectionId);
    assert.deepEqual((await query(shared)).result.rows, [[other, 'pending']]);
    await vscode.commands.executeCommand('rocketbrain.rollback');
    assert.deepEqual((await query(protectedConsole.document)).result.rows, [[other, 'dedicated']]);
    await profiles.connect({ id: primary.id });
    assert.deepEqual((await query(ordinary)).result.rows, [[main, 'active']]);

    await api.closeConsoleSession(first.id);
    for (const document of [first.document, shared]) {
      await assert.rejects(controls.inspectConsoleIsolation(document), /new dedicated console/);
    }
    assert.ok(!api.sessions().some(session => session.id === first.id));
    await profiles.remove({ id: secondary.id, expectedRevision: secondary.revision });
    created.splice(created.indexOf(secondary), 1);
    const jdbc = await jdbcReadback();
    assert.deepEqual(jdbc, jdbcBaseline);
    checks.push('Two saved profile routes and the active catalog used separate connections. An explicitly shared sibling kept its dedicated transaction through an active-catalog disconnect and rollback.');
    return { engine: runtime.dbEngine, nativeProfileCommand: true, sameNamedObjectsIsolated: true, separateActiveCatalog: true,
      dedicatedSharedTransaction: true, durableAcrossCatalogDisconnect: true, protectedProfileEnforced: true,
      staleBindingsRefused: true, savedProfileChangesGuarded: true, inMemorySave: true, jdbc };
  } finally {
    try {
      for (const session of api.sessions()) await api.closeConsoleSession(session.id);
      await api.disconnectMysql();
      for (const saved of created) await profiles.remove({ id: saved.id, expectedRevision: saved.revision });
    } finally {
      try {
        for (const schema of [main, other]) await actor.query(`DROP TABLE IF EXISTS ${schema}.${table}`);
      } finally { await actor.end(); }
    }
  }
}

module.exports = { runDedicatedProfileConsoleChecks };
