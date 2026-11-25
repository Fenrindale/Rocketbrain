'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const mysql = require('mysql2/promise');

async function runRoutineCallChecks(api, vscode, checks) {
  const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
  const runtime = await read(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG);
  const ownership = await read(path.join(path.dirname(runtime.dbConfigPath), 'owner.json'));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(ownership.kind));
  const config = await read(runtime.dbConfigPath);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.database, 'rocketbrain_fixture');
  const raw = await mysql.createConnection(config), prefix = 'rb_call_' + randomBytes(5).toString('hex');
  const table = prefix + '_log', procedure = prefix + '_proc', outputs = prefix + '_out';
  const target = name => ({ schema: config.database, name, kind: 'procedure' });
  const stamp = '9007199254740993', decimal = '1234567890123456789.123456';
  const values = [{ kind: 'integer', value: stamp }, { kind: 'decimal', value: decimal }];
  const probe = async () => {
    const response = await fetch(runtime.baseUrl + '/probe/testing-state', { signal: AbortSignal.timeout(5000) });
    assert.ok(response.ok);
    return response.json();
  };
  const count = async () => (await raw.query('SELECT COUNT(*) AS n FROM ' + table))[0][0].n;
  const calls = api.routineCalls;
  try {
    const initial = await probe();
    assert.deepEqual(initial, { people: 2, departments: 1, rolledBackNames: 0 });
    await raw.query('CREATE TABLE ' + table + ' (id BIGINT PRIMARY KEY, amount DECIMAL(30,6)) ENGINE=InnoDB');
    await raw.query('CREATE PROCEDURE ' + procedure + ' (IN i BIGINT, IN a DECIMAL(30,6)) SQL SECURITY INVOKER ' +
      'BEGIN INSERT INTO ' + table + ' VALUES (i,a); SELECT i AS n, i AS n; ' +
      'SELECT id,amount FROM ' + table + ' WHERE id=i; SELECT id AS empty_id FROM ' + table + ' WHERE 1=0; END');
    await raw.query('CREATE PROCEDURE ' + outputs + ' (OUT i INT) SET i=1');
    await api.connectMysql(config);
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('rocketbrain.db.reviewProcedureCall'));
    assert.ok(commands.includes('rocketbrain.db.openProcedureResult'));
    await assert.rejects(calls.inspect(target(outputs)), /supports IN/);
    const draft = await calls.inspect(target(procedure));
    assert.deepEqual(draft.parameters.map(input => [input.name, input.kind]), [['i', 'integer'], ['a', 'decimal']]);
    const prepared = calls.prepare(draft.id, values);
    const document = await vscode.workspace.openTextDocument(prepared.uri);
    await vscode.window.showTextDocument(document, { preview: false });
    const text = document.getText();
    assert.ok(text.includes(draft.source.replace(/\r\n/g, '\n')) || text.includes(draft.source.replace(/\r?\n/g, '\r\n')));
    assert.ok(text.includes(prepared.fingerprint) && text.includes(prepared.sql));
    assert.equal(text.includes(stamp) || text.includes(decimal), false);
    await assert.rejects(calls.run(prepared.id), /Approve the exact/);
    assert.equal(await count(), 0);
    const executed = await calls.run(prepared.id, { approved: true });
    await assert.rejects(calls.run(prepared.id, { approved: true }), /expired or the connection changed/);
    assert.equal(executed.state, 'completed');
    assert.equal(executed.callerTransactionCommitted, true);
    assert.equal(await count(), 1);
    assert.deepEqual(executed.resultSets.map(set => set.columns), [['n', 'n'], ['id', 'amount'], ['empty_id']]);
    assert.deepEqual(executed.resultSets.map(set => set.rows), [[[stamp, stamp]], [[stamp, decimal]], []]);
    const summary = api.results().find(result => result.id === executed.resultId);
    assert.deepEqual(summary.result.scriptStatements.map(set => set.index), [0, 1, 2]);
    const grid = await vscode.commands.executeCommand('rocketbrain.db.openProcedureResult', { resultId: executed.resultId, index: 1 });
    assert.equal(grid.executedSql, false);
    assert.deepEqual(api.results().find(result => result.id === grid.resultId).result.rows, [[stamp, decimal]]);
    const empty = await vscode.commands.executeCommand('rocketbrain.db.openProcedureResult', { resultId: executed.resultId, index: 2 });
    assert.deepEqual(api.results().find(result => result.id === empty.resultId).result.columns, ['empty_id']);
    assert.equal(await count(), 1);

    const stale = calls.prepare((await calls.inspect(target(procedure))).id, values);
    await raw.query("ALTER PROCEDURE " + procedure + " COMMENT 'changed after review'");
    await assert.rejects(calls.run(stale.id, { approved: true }), /signature changed/);
    const otherRoute = calls.prepare((await calls.inspect(target(procedure))).id, values);
    await api.connectMysql({ ...config, writeProtection: { tables: [{ schema: config.database, name: table }] } });
    await assert.rejects(calls.run(otherRoute.id, { approved: true }), /connection changed/);
    const guarded = calls.prepare((await calls.inspect(target(procedure))).id, values);
    await assert.rejects(calls.run(guarded.id, { approved: true }), /profile protects tables/);
    assert.equal(await count(), 1);
    assert.deepEqual(await probe(), initial);
    checks.routineCalls = { multipleGrids: 3, duplicateColumns: true, emptySetColumns: true, exactTypedInputs: true,
      noCallsWithoutApproval: true, oneShotReview: true, staleDefinitionAndRouteDenied: true, guardedProfileDenied: true,
      nativeReview: true, capturedGridsDoNotReexecute: true, definitionCheck: executed.definitionCheck, spring: initial };
  } finally {
    try {
      await api.connectMysql(config);
      await raw.query('DROP PROCEDURE IF EXISTS ' + procedure);
      await raw.query('DROP PROCEDURE IF EXISTS ' + outputs);
      await raw.query('DROP TABLE IF EXISTS ' + table);
    } finally { await raw.end(); }
  }
}

module.exports = { runRoutineCallChecks };
