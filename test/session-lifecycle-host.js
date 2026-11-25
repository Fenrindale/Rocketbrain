'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');
const mysql = require('mysql2/promise');
const { jdbcReadback } = require('./java-source-analysis-host');
const { until } = require('./helpers/stdio-lsp');

async function runSessionLifecycleChecks(api, vscode, checks) {
  const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
  const runtime = await read(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG);
  const config = await read(runtime.dbConfigPath);
  const owner = await read(path.join(path.dirname(runtime.dbConfigPath), 'owner.json'));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(owner.kind));
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.database, 'rocketbrain_fixture');
  const profiles = api.dbConnections;
  const table = 'rb_console_lifecycle_' + randomBytes(5).toString('hex');
  const actor = await mysql.createConnection(config);
  const profile = { id: randomUUID(), name: 'Console lifecycle fixture', group: 'Owned tests', color: 'none',
    host: config.host, port: config.port, user: config.user, database: config.database, tls: { mode: 'disabled' },
    sessionLifecycle: { initialSql: "SET SESSION time_zone = '+05:00'; SET SESSION sql_mode = 'STRICT_TRANS_TABLES';" +
      ' SET SESSION sql_safe_updates = 1; SET SESSION group_concat_max_len=256;', keepAliveSeconds: 1, idleSeconds: 3 } };
  const expectedJdbc = { people: 2, departments: 1, rolledBackNames: 0 };
  let saved;
  async function query(document, sql) {
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    const content = document.getText();
    if (content !== sql) assert.equal(await editor.edit(edit => {
      edit.replace(new vscode.Range(document.positionAt(0), document.positionAt(content.length)), sql);
    }), true);
    editor.selection = new vscode.Selection(document.positionAt(0), document.positionAt(sql.length));
    const id = await vscode.commands.executeCommand('rocketbrain.runQuery');
    const result = api.results().find(item => item.id === id);
    assert.ok(result?.result, result?.error || 'The native SQL command returned no result.');
    return result;
  }
  const values = 'SELECT @@session.time_zone,@@session.sql_mode,@@session.sql_safe_updates,@@session.group_concat_max_len;';
  const expected = [['+05:00','STRICT_TRANS_TABLES','1','256']];
  try {
    await actor.query('CREATE TABLE ' + table + ' (id INT PRIMARY KEY,label VARCHAR(20)) ENGINE=InnoDB');
    await actor.query(`INSERT INTO ${table} VALUES (1,'original')`);
    assert.deepEqual(await jdbcReadback(), expectedJdbc);
    await assert.rejects(profiles.save({ profile: { ...profile, id: randomUUID(), sessionLifecycle: { initialSql: 'DROP TABLE ' + table } },
      password: config.password }), /SET SESSION/);
    await assert.rejects(profiles.save({ profile: { ...profile, id: randomUUID(), sessionLifecycle: { initialSql: "SET SESSION time_zone='Invalid/FixtureZone';" } },
      password: config.password }), /server rejected.*initialization/);
    saved = await profiles.save({ profile, password: config.password, rememberPassword: true });
    assert.equal(profiles.exportProfiles().version, 5);
    assert.equal(profiles.exportProfiles().credentialsIncluded, false);
    await profiles.connect({ id: saved.id });
    assert.ok((await api.databaseCatalog()).sqlMode.includes('STRICT_TRANS_TABLES'));
    const document = await vscode.workspace.openTextDocument({ language: 'sql', content: values });
    const first = await query(document, values), id = first.sessionId;
    assert.deepEqual(first.result.rows.map(row => row.map(String)), expected);
    const session = () => api.sessions().find(item => item.id === id);
    const before = session();
    assert.equal(before.lifecycle.initializedStatements, 4);
    assert.ok(before.connectionId);
    await until(() => session()?.lifecycle.keepAliveChecks >= 1, 5000);
    assert.equal(session().connectionId, before.connectionId);
    const expired = await until(() => session()?.lifecycle.disconnectedByIdleTimeout && session(), 7500);
    assert.equal(expired.needsReconnect, true);
    assert.equal(expired.outcomeUnknown, false);
    assert.equal(expired.inTransaction, false);
    await assert.rejects(api.dbSessionTools.inspectConsoleIsolation(document), /reconnect/i);
    const reset = await api.reconnectConsoleSession(id);
    assert.notEqual(reset.connectionId, before.connectionId);
    assert.equal(reset.lifecycle.initializedStatements, 4);
    assert.deepEqual((await query(document, values)).result.rows.map(row => row.map(String)), expected);
    assert.equal(session().lifecycle.initializedStatements, 4);

    await api.configureConsoleSession(id, { readOnly: false, autocommit: false });
    await api.controlConsoleSession(id, 'begin');
    await query(document, `UPDATE ${table} SET label='pending' WHERE id=1;`);
    await new Promise(resolve => setTimeout(resolve, 3400));
    const retained = session();
    assert.equal(retained.connectionId, reset.connectionId);
    assert.equal(retained.inTransaction, true);
    assert.equal(retained.lifecycle.disconnectedByIdleTimeout, false);
    assert.ok(retained.lifecycle.keepAliveChecks > 0);
    await api.controlConsoleSession(id, 'rollback');
    const [[found]] = await actor.query('SELECT label FROM ' + table);
    assert.equal(found.label, 'original');
    await api.configureConsoleSession(id, { readOnly: true, autocommit: true });

    assert.match(String(reset.connectionId), /^\d+$/);
    await actor.query('KILL CONNECTION ' + Number(reset.connectionId));
    const lost = await until(() => session()?.needsReconnect && session(), 5000);
    assert.equal(lost.lifecycle.disconnectedByIdleTimeout, false);
    const restarted = await api.reconnectConsoleSession(id);
    assert.notEqual(restarted.connectionId, reset.connectionId);
    assert.deepEqual((await query(document, values)).result.rows.map(row => row.map(String)), expected);
    assert.equal(session().lifecycle.initializedStatements, 4);
    const jdbc = await jdbcReadback();
    assert.deepEqual(jdbc, expectedJdbc);
    checks.push('The installed SQL console applied the reviewed initialization once per physical connection, refreshed health, disconnected safely when idle and kept an open transaction through the timer.');
    return { engine: runtime.dbEngine, initialStatements: 4, keepAliveObserved: true, idleDisconnectObserved: true,
      idleTransactionRetained: true, invalidInitializationRefused: true, observedServerLoss: true,
      reconnectInitialized: true, credentialFreeExport: true, jdbc };
  } finally {
    try {
      for (const session of api.sessions()) await api.closeConsoleSession(session.id);
      await api.disconnectMysql();
      if (saved) await profiles.remove({ id: saved.id, expectedRevision: saved.revision });
    } finally {
      try { await actor.query('DROP TABLE IF EXISTS ' + table); }
      finally { await actor.end(); }
    }
  }
}

module.exports = { runSessionLifecycleChecks };
