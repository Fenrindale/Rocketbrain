'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const mysql = require('mysql2/promise');
const { JOURNAL } = require('../src/db/object-editor');

async function runFunctionDeploymentChecks(api, vscode, checks) {
  const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
  const runtime = await read(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG);
  const owner = await read(path.join(path.dirname(runtime.dbConfigPath), 'owner.json'));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(owner.kind));
  const config = await read(runtime.dbConfigPath);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.database, 'rocketbrain_fixture');
  const actor = await mysql.createConnection({ ...config, supportBigNumbers: true, bigNumberStrings: true });
  const suffix = randomBytes(5).toString('hex'), name = 'rb_fn_review_' + suffix, dependent = 'rb_fn_view_' + suffix;
  const author = api.dbAuthoring, operations = new Set();
  const flags = { allowImplicitCommit: true, allowRoutineReplacement: true };
  const target = { kind: 'function', name };
  const probe = async () => {
    const response = await fetch(runtime.baseUrl + '/probe/testing-state', { signal: AbortSignal.timeout(5000) });
    assert.ok(response.ok);
    return response.json();
  };
  async function replace(model, text) {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(model.uri)), edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);
    assert.ok(await vscode.workspace.applyEdit(edit));
    const deadline = Date.now() + 2000;
    while (document.getText() !== text && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(document.getText(), text);
  }
  async function review(model, text) {
    await replace(model, text);
    const result = await author.reviewObject(model.modelId);
    operations.add(result.operationId);
    return result;
  }
  const selectedValue = async () => String((await actor.query('SELECT ' + name + '(40) AS result'))[0][0].result);
  try {
    const initial = await probe();
    assert.deepEqual(initial, { people: 2, departments: 1, rolledBackNames: 0 });
    await actor.query('CREATE FUNCTION ' + name + "(i BIGINT) RETURNS BIGINT DETERMINISTIC NO SQL SQL SECURITY INVOKER COMMENT 'Owned sample' RETURN i + 1");
    await api.connectMysql(config);
    const observed = await api.objectSources.open({ ...target, schema: config.database });
    assert.match(observed.document.getText(), /RETURN i \+ 1/);
    assert.ok((await api.listSchemaObjects()).objects.some(object => object.kind === 'function' && object.name === name));
    const model = await author.openObject(target);
    assert.equal(model.security, 'INVOKER');
    assert.match(model.returnType, /^BIGINT(?:\(\d+\))?$/);
    await replace(model, 'RETURN (SELECT 5)');
    await assert.rejects(author.reviewObject(model.modelId), /unsupported/i);
    await actor.query('CREATE VIEW rocketbrain_related.' + dependent + ' AS SELECT rocketbrain_fixture.' + name + '(1) AS value');
    await replace(model, 'RETURN i + 2');
    await assert.rejects(author.reviewObject(model.modelId), /object may depend/);
    await actor.query('DROP VIEW rocketbrain_related.' + dependent);
    const first = await review(model, 'RETURN i + 2');
    assert.equal(first.requiresRoutineReplacementApproval, true);
    assert.deepEqual(first.validation, { compiled: true, executed: false, cleaned: true });
    const preview = await vscode.workspace.openTextDocument(vscode.Uri.parse('rocketbrain-object-review:/' + model.modelId + '/review.sql'));
    assert.match(preview.getText(), /Non-atomic replacement/);
    assert.match(preview.getText(), /DROP FUNCTION/);
    assert.match(preview.getText(), /RETURNS BIGINT/);
    assert.equal(await selectedValue(), '41');
    await assert.rejects(author.deployObject(model.modelId, { allowImplicitCommit: true }), /temporary-unavailability approval/);
    assert.equal(await selectedValue(), '41');
    const second = await review(model, 'RETURN ABS(i) + 2;');
    const deployed = await author.deployObject(model.modelId, flags);
    assert.equal(deployed.state, 'applied');
    assert.equal(deployed.nonAtomicReplacement, true);
    assert.equal(deployed.grantsPreserved, true);
    assert.equal(deployed.contextPreserved, true);
    assert.equal(await selectedValue(), '42');
    await api.connectMysql(config);
    const recovered = await author.recoverObject(second.operationId, flags);
    assert.equal(recovered.state, 'recovered');
    assert.ok(recovered.originalDefinitionContextGrantsVerified);
    assert.equal(await selectedValue(), '41');
    assert.deepEqual(await probe(), initial);
    checks.functionDeployment = { nativeSourceAndReview: true, functionSignatureRetained: true, explicitNonAtomicApproval: true,
      actualCompileAndDeploy: true, sourceAndGrantsVerified: true, outgoingAndCrossSchemaDependentsRefused: true,
      recoveredAfterReconnect: true, stagedBodyNotExecuted: true, spring: initial };
  } finally {
    try {
      await actor.query('DROP VIEW IF EXISTS rocketbrain_related.' + dependent);
      await actor.query('DROP FUNCTION IF EXISTS ' + name);
      for (const id of operations) await actor.execute('DELETE FROM `' + JOURNAL + '` WHERE operation_id=?', [id]);
    } finally { await actor.end(); }
  }
}

module.exports = { runFunctionDeploymentChecks };
