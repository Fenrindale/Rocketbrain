'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const mysql = require('mysql2/promise');

async function runLocalTransportChecks(api, vscode, checks) {
  const runtime = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const tcp = JSON.parse(await fs.readFile(runtime.dbConfigPath, 'utf8'));
  const owner = JSON.parse(await fs.readFile(path.join(path.dirname(runtime.dbConfigPath), 'owner.json'), 'utf8'));
  const name = process.env.ROCKETBRAIN_TEST_MYSQL_PIPE;
  assert.ok(['RocketbrainDisposableOracleMysqlFixture-v1', 'RocketbrainDisposableMariaDbFixture-v1'].includes(owner.kind));
  assert.equal(tcp.host, '127.0.0.1');
  assert.equal(name, 'rocketbrain-' + runtime.dbEngine + '-' + owner.id);
  const connection = api.dbConnections;
  let profileId;
  try {
    const tcpReader = await mysql.createConnection(tcp);
    let springTableRows;
    try {
      const [[observed]] = await tcpReader.query('SELECT COUNT(*) AS total FROM rb_spring_person');
      springTableRows = Number(observed.total);
      assert.ok(springTableRows > 0);
    } finally { await tcpReader.end(); }
    const profile = { name: 'Owned Windows pipe', group: 'Local transport verification', database: tcp.database,
      user: tcp.user, transport: { kind: 'named-pipe', address: name } };
    const verified = await connection.test({ profile, password: tcp.password });
    assert.equal(verified.currentUser, tcp.user + '@localhost');
    assert.deepEqual(verified.transport, { kind: 'named-pipe' });
    const saved = await connection.save({ profile, password: tcp.password, rememberPassword: true });
    profileId = saved.id;
    assert.equal(saved.hasSavedPassword, true);
    assert.equal(JSON.stringify(saved).includes(tcp.password), false);
    const schemas = await connection.schemas({ id: saved.id });
    assert.ok(schemas.includes(tcp.database));
    await connection.connect({ id: saved.id });
    assert.deepEqual(api.activeConnectionProfile()?.transport, { kind: 'named-pipe' });
    const catalog = await api.databaseCatalog();
    assert.ok(catalog.tables.some(table => table.name === 'rb_spring_person'));

    const document = await vscode.workspace.openTextDocument({
      language: 'sql', content: 'SELECT CURRENT_USER() AS account, @@socket AS owned_socket, COUNT(*) AS rows_found FROM rb_spring_person;'
    });
    await vscode.window.showTextDocument(document);
    const described = await api.sqlScripts.describe(document);
    try {
      const plan = await api.sqlScripts.preview(described.id, []);
      const report = await api.sqlScripts.run(plan.id);
      assert.equal(report.state, 'completed');
      assert.deepEqual(report.statements[0].result.rows[0].slice(0, 2), [verified.currentUser, name]);
      assert.equal(Number(report.statements[0].result.rows[0][2]), springTableRows);
    } finally { await api.closeConsoleSession(described.sessionId); }
    const snapshot = connection.exportProfiles();
    assert.equal(snapshot.version, 2);
    assert.equal(JSON.stringify(snapshot).includes(name), false);
    assert.equal(JSON.stringify(snapshot).includes(tcp.password), false);
    const state = await fetch(runtime.baseUrl + '/probe/testing-state', { signal: AbortSignal.timeout(9000) });
    assert.ok(state.ok);
    const spring = await state.json();
    assert.deepEqual(spring, { people: 2, departments: 1, rolledBackNames: 0 });
    checks.push('A saved named-pipe profile verified the localhost database account, opened a native SQL console and queried the owned Spring schema.');
    checks.push('Connection export retained the transport kind and omitted the pipe address and password.');
    return { engine: runtime.dbEngine, localProfile: true, metadata: true, localConsole: true, schemaSelection: true,
      pathAndPasswordRedacted: true, springTableRows, spring };
  } finally {
    if (profileId) {
      const current = connection.list().find(row => row.id === profileId);
      if (current) await connection.remove({ id: profileId, expectedRevision: current.revision, disconnect: true });
    }
  }
}

module.exports = { runLocalTransportChecks };
