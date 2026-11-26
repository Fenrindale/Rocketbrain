'use strict';

const assert = require('node:assert/strict');
const fixture = require('./helpers/schema-prepared-join-fixture');
const { jdbcReadback } = require('./java-source-analysis-host');

async function runPreparedJoinChecks(api, vscode, checks) {
  const owned = fixture.ownedConfig();
  assert.ok(owned, 'Use an owned Spring fixture with its related schema.');
  const control = await fixture.create(owned.config, owned.related);
  try {
    await api.connectMysql(owned.config);
    const observed = await api.schemaPrograms.inspect({ routines: [control.root] });
    fixture.assertReport(observed.report, control);
    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(observed.uri));
    assert.match(document.getText(), /RocketbrainPreparedJoinUpdate/u);
    await assert.rejects(api.schemaPrograms.inspect({ routines: [control.alien] }), /Expected JOIN/u);
    await control.dropAlien();
    await control.removeLookupKey();
    try { await assert.rejects(api.schemaPrograms.inspect({ routines: [control.root] }), /unique lookup key/u); }
    finally { await control.restoreLookupKey(); }
    assert.deepEqual(await control.kinds(), [1, 2]);

    const contextBefore = await control.show(), lookupBefore = await control.lookupValues();
    const comparison = await api.schemaComparison.compare(control.desired, { current: control.current });
    const plan = await api.schemaComparison.planRebuild(comparison.id, [control.base]);
    control.plans.push(plan);
    fixture.assertPlan(plan, control);
    const applied = await api.schemaComparison.applyRebuild(plan.id, fixture.flags);
    assert.equal(applied.state, 'applied', JSON.stringify(applied));
    assert.deepEqual(await control.kinds(), [1, 2]);
    await vscode.commands.executeCommand('rocketbrain.useDemo');
    await api.connectMysql(owned.config);
    const operations = await api.schemaComparison.listRecoveries();
    const recovered = await api.schemaComparison.recoverRebuild(applied.operationId, {
      ...fixture.flags, connectionEpoch: operations.connectionEpoch
    });
    assert.equal(recovered.state, 'recovered', JSON.stringify(recovered));
    assert.equal(recovered.normalClientFencesReleased, true);
    assert.deepEqual(await control.show(), contextBefore);
    assert.deepEqual(await control.kinds(), [1, 2]);
    await control.invokeFixtureProcedure(7, 1);
    assert.deepEqual(await control.kinds(), [37, 2]);
    assert.deepEqual(await control.lookupValues(), lookupBefore);
    const result = { readOnlyReport: true, compositeReadWriteSets: true, missingUniqueKeyRejected: true, lookupLocked: true,
      buildAndRecoveryNeverExecutedJoin: true, definitionRetained: true, laterOwnedProcedureEffect: [37, 2], jdbc: await jdbcReadback() };
    checks.push('A prepared UPDATE JOIN round trips through the installed inspection and guarded migration with no procedure replay.');
    return result;
  } finally {
    await vscode.commands.executeCommand('rocketbrain.useDemo');
    await control.close();
  }
}

module.exports = { runPreparedJoinChecks };
