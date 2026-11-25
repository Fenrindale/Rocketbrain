'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');
const mysql = require('mysql2/promise');
const { jdbcReadback } = require('./java-source-analysis-host');

const ownerKind = { mysql: 'RocketbrainDisposableOracleMysqlFixture-v1', mariadb: 'RocketbrainDisposableMariaDbFixture-v1' };
const json = async path => JSON.parse(await fs.readFile(path, 'utf8'));

async function runFederatedSelectChecks(api, vscode, checks) {
  const pair = await json(process.env.ROCKETBRAIN_COORDINATOR_TEST_CONFIG);
  assert.equal(pair.format, 'RocketbrainOwnedPairedSpringFixtures');
  assert.deepEqual(pair.participants.map(item => item.engine).sort(), ['mariadb', 'mysql']);
  const suffix = randomBytes(6).toString('hex');
  const table = 'rb_federated_' + suffix;
  const originalSource = api.source();
  const profiles = [], live = [];
  const key = '9007199254740995', differentKey = '9007199254740994';
  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes('rocketbrain.db.newFederatedSelect') && commands.includes('rocketbrain.db.runFederatedSelect'));
  try {
    for (const engine of ['mysql', 'mariadb']) {
      const participant = pair.participants.find(value => value.engine === engine);
      const owner = await json(path.join(path.dirname(participant.configPath), 'owner.json'));
      assert.equal(owner.kind, ownerKind[engine]);
      const config = await json(participant.configPath);
      assert.equal(config.host, '127.0.0.1');
      assert.equal(config.database, 'rocketbrain_fixture');
      const connection = await mysql.createConnection(config);
      const server = { connection, tableCreated: false };
      live.push(server);
      await connection.query(`CREATE TABLE ${table} (id BIGINT UNSIGNED, label VARCHAR(64), enabled INT NOT NULL) ENGINE=InnoDB`);
      server.tableCreated = true;
      const rows = engine === 'mysql' ? [[key, 'large', 1], [differentKey, 'different', 0], [null, 'null', 1]] :
        [[key, "O'Brien", 1], [key, 'other', 0], [null, 'wrong', 1]];
      for (const row of rows) await connection.execute(`INSERT INTO ${table} VALUES (?,?,?)`, row);
      const profile = { id: randomUUID(), name: 'Owned ' + engine + ' federated source', group: '', color: 'none',
        host: config.host, port: config.port, user: config.user, database: config.database, tls: { mode: 'disabled' }, ssh: null };
      const saved = await api.dbConnections.save({ profile, password: config.password, rememberPassword: true });
      profiles.push({ id: saved.id, revision: saved.revision });
    }
    const starter = await vscode.commands.executeCommand('rocketbrain.db.newFederatedSelect');
    const template = await vscode.workspace.openTextDocument(starter);
    assert.ok(api.federation.isFederatedDocument(template));
    assert.equal(api.sqlAnalysis.analyzeDocument(template).state, 'disabled');
    const select = `SELECT a.id AS joined_id, a.label AS left_value, b.label AS right_value FROM source1.${table} a`;
    const join = `JOIN source2.${table} b ON a.id = b.id WHERE a.enabled = 1`;
    const inner = await api.federation.run({ sources: profiles, sql: select + ' INNER ' + join + " AND b.label = 'O''Brien'" });
    assert.deepEqual(inner.rows, [[key, 'large', "O'Brien"]]);
    assert.deepEqual(inner.inputs.map(item => [item.rows, item.sentValues]), [[2,1],[1,1]]);
    const outer = await api.federation.run({ sources: profiles, sql: select + ' LEFT ' + join });
    assert.equal(outer.rowCount, 3);
    assert.ok(outer.rows.some(row => row[0] === null && row[1] === 'null' && row[2] === null));
    assert.deepEqual(outer.rows.filter(row => row[0] === key).map(row => row[2]).sort(), ["O'Brien", 'other']);
    assert.equal(outer.crossServerSnapshot, false);
    assert.equal(api.source(), originalSource);
    await assert.rejects(api.federation.run({ sources: profiles, sql: select + ' LEFT ' + join + ' AND b.label IS NULL' }), /null extension/);
    const uri = await api.federation.show(outer);
    const report = await vscode.workspace.openTextDocument(uri);
    assert.equal(uri.scheme, 'rocketbrain-federated-result');
    assert.deepEqual(JSON.parse(report.getText()).rows, outer.rows);
    const jdbc = await jdbcReadback();
    checks.push('A federated SELECT used two actual saved MySQL and MariaDB profiles, bound per-source filters, and preserved BIGINT, duplicate keys and LEFT JOIN null extension.');
    return { leftEngine: 'mysql', rightEngine: 'mariadb', exactBigInt: true, predicatePushdown: true,
      duplicateMatches: 2, nullExtension: true, resultRows: outer.rowCount, activeConnectionUnchanged: true, jdbc };
  } finally {
    for (const profile of profiles) await api.dbConnections.remove({ id: profile.id, expectedRevision: profile.revision });
    for (const { connection, tableCreated } of live) {
      try { if (tableCreated) await connection.query(`DROP TABLE ${table}`); }
      finally { await connection.end(); }
    }
  }
}

module.exports = { runFederatedSelectChecks };
