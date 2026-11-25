'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const mysql = require('mysql2/promise');

async function runMariaDbPackageCallChecks(api, vscode, checks) {
  const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
  const runtime = await read(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG);
  const owner = await read(path.join(path.dirname(runtime.dbConfigPath), 'owner.json'));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(owner.kind));
  const config = await read(runtime.dbConfigPath);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.database, 'rocketbrain_fixture');
  const raw = await mysql.createConnection(config), suffix = randomBytes(5).toString('hex');
  const calls = api.routineCalls;
  const packageName = 'rb_pack_' + suffix, standalone = 'rb_standalone_' + suffix, audit = 'rb_pack_audit_' + suffix;
  const parameters = 'IN v BIGINT, INOUT m DECIMAL(32,6), OUT note_text VARCHAR(24)';
  const packageTarget = { kind: 'package', schema: config.database, name: packageName };
  const callTarget = { kind: 'package-procedure', schema: config.database, package: packageName, name: 'emit_result' };
  const body = addition => 'CREATE PACKAGE BODY ' + packageName + ' DECLARE starts INT DEFAULT 0;' +
    ' PROCEDURE hidden() BEGIN DO 1; END;' + ' PROCEDURE emit_result(' + parameters + ') BEGIN ' +
    'INSERT INTO ' + audit + ' VALUES(v, starts); SELECT v AS record_id, m AS original_amount; ' +
    'SET m=m+' + addition + '; SELECT v AS empty_value WHERE 1=0; END;' +
    ' FUNCTION lookup() RETURNS INT BEGIN RETURN starts; END; SET starts=starts+1; END';
  const probe = async () => {
    const response = await fetch(runtime.baseUrl + '/probe/testing-state', { signal: AbortSignal.timeout(5000) });
    assert.ok(response.ok);
    return response.json();
  };
  const count = async () => (await raw.query('SELECT COUNT(*) AS n FROM ' + audit))[0][0].n;
  const inputs = [{ kind: 'integer', value: '9007199254740993' }, { kind: 'decimal', value: '1234567890123456789.123456' }];
  const maria = owner.kind === 'RocketbrainDisposableMariaDbFixture-v1';
  try {
    const initial = await probe();
    assert.deepEqual(initial, { people: 2, departments: 1, rolledBackNames: 0 });
    await api.connectMysql(config);
    assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.db.reviewPackageCall'));
    if (!maria) {
      await assert.rejects(calls.listPackages({}), /require MariaDB/);
      await raw.query('CREATE PROCEDURE ' + standalone + ' (IN v BIGINT, OUT answer BIGINT) BEGIN SET answer=v; SELECT v AS record_id; END');
      const routine = await calls.inspect({ kind: 'procedure', schema: config.database, name: standalone });
      const review = calls.prepare(routine.id, [inputs[0]]);
      const report = await calls.run(review.id, { approved: true });
      assert.equal(report.definitionCheck, 'transaction-pinned');
      assert.deepEqual(report.resultSets[0].rows, [[inputs[0].value]]);
      assert.equal(report.outputParameters[0].value, inputs[0].value);
      assert.deepEqual(await probe(), initial);
      checks.packageCalls = { dialect: 'mysql', packageGate: true, standaloneProcedure: true, typedOutputs: true, spring: initial };
      return;
    }

    await raw.query('CREATE TABLE ' + audit + ' (id BIGINT, starts INT) ENGINE=InnoDB');
    await raw.query('CREATE PACKAGE ' + packageName + ' SQL SECURITY INVOKER PROCEDURE emit_result(' + parameters + '); FUNCTION lookup() RETURNS INT; END');
    await raw.query(body('0.000001'));
    assert.deepEqual((await calls.listPackages({ prefix: packageName })).items, [packageTarget]);
    const browse = await calls.inspectPackage(packageTarget);
    assert.deepEqual(browse.members.map(item => [item.kind, item.name, item.supported]), [['procedure', 'emit_result', true], ['function', 'lookup', false]]);
    assert.match(browse.spec.source, /CREATE .* PACKAGE /);
    assert.match(browse.body.source, /CREATE .* PACKAGE BODY /);
    await assert.rejects(calls.inspect({ ...callTarget, name: 'hidden' }), /unambiguous public procedure/);
    const draft = await calls.inspect(callTarget);
    assert.deepEqual(draft.parameters.map(item => item.mode), ['IN', 'INOUT', 'OUT']);
    const plan = calls.prepare(draft.id, inputs);
    const review = await vscode.workspace.openTextDocument(plan.uri);
    await vscode.window.showTextDocument(review, { preview: false });
    for (const record of draft.packageSources) assert.ok(review.getText().replaceAll('\r\n', '\n').includes(record.source.replaceAll('\r\n', '\n')));
    assert.match(review.getText(), /initialization code/);
    assert.equal(review.getText().includes(inputs[1].value), false);
    assert.equal(await count(), 0);
    await assert.rejects(calls.run(plan.id), /Approve the exact/);
    const report = await calls.run(plan.id, { approved: true });
    await assert.rejects(calls.run(plan.id, { approved: true }), /expired or the connection changed/);
    assert.equal(await count(), 1);
    assert.equal((await raw.query('SELECT starts FROM ' + audit))[0][0].starts, 1);
    assert.deepEqual(report.resultSets.map(set => set.rows), [[[inputs[0].value, inputs[1].value]], []]);
    assert.deepEqual(report.outputParameters.map(item => item.value), ['1234567890123456789.123457', null]);
    const grid = await vscode.commands.executeCommand('rocketbrain.db.openProcedureResult', { resultId: report.resultId, index: 2 });
    assert.equal(grid.outputParameters, true);
    assert.equal(grid.executedSql, false);
    assert.equal(await count(), 1);
    const stale = calls.prepare((await calls.inspect(callTarget)).id, inputs);
    await raw.query('DROP PACKAGE BODY ' + packageName);
    await raw.query(body('0.000002'));
    await assert.rejects(calls.run(stale.id, { approved: true }), /signature changed/);
    assert.equal(await count(), 1);
    assert.deepEqual(await probe(), initial);
    checks.packageCalls = { dialect: 'mariadb', publicMembers: 2, callableProcedures: 1, exactSpecificationAndBody: true,
      separateResultSets: 2, outputParameters: 2, precisionAndNull: true, noInitializationDuringReview: true, approvedOnlyAndOneShot: true,
      staleBodyRefused: true, separateNativeGridNoReplay: true, spring: initial };
  } finally {
    try {
      if (maria) {
        await raw.query('DROP PACKAGE IF EXISTS ' + packageName);
        await raw.query('DROP TABLE IF EXISTS ' + audit);
      } else await raw.query('DROP PROCEDURE IF EXISTS ' + standalone);
    } finally { await raw.end(); }
  }
}

module.exports = { runMariaDbPackageCallChecks };
