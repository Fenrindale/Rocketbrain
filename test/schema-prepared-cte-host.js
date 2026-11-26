'use strict';

const assert = require('node:assert/strict');
const fixture = require('./helpers/schema-prepared-join-fixture');
const { jdbcReadback } = require('./java-source-analysis-host');

async function runPreparedCteChecks(api, vscode, checks) {
  const owned = fixture.ownedConfig();
  assert.ok(owned, 'Use an owned Spring fixture with its related schema.');
  const control = await fixture.create(owned.config, owned.related, { withCte: true });
  try {
    const version = (await control.actor.query('SELECT VERSION() AS version'))[0][0].version;
    await api.connectMysql(owned.config);
    const inspect = async () => api.schemaPrograms.inspect({ routines: [control.root] });
    const compare = () => api.schemaComparison.compare(control.desired, { current: control.current });
    const planRebuild = async () => api.schemaComparison.planRebuild((await compare()).id, [control.base]);
    if (version === '11.4.8-MariaDB') {
      await assert.rejects(inspect, /requires observed MySQL 8.4\+ or MariaDB 12.3\+/u);
      await control.dropAlien();
      await assert.rejects(planRebuild, /requires observed MySQL 8.4\+ or MariaDB 12.3\+/u);
      await assert.rejects(control.invokeFixtureProcedure(7, 1), { code: 'ER_PARSE_ERROR', errno: 1064 });
      assert.deepEqual(await control.kinds(), [1, 2]);
      checks.push('MariaDB 11.4 refuses the prepared CTE at inspection, rebuild review and its actual SQL parser.');
      return { version, supported: false, readOnlyInspectionRefused: true, rebuildReviewRefused: true,
        vendorParserError: 1064, writesUnchanged: true, jdbc: await jdbcReadback() };
    }

    assert.match(version, /^(?:8\.4\.13|12\.3\.4-MariaDB)$/u);
    const observed = await inspect();
    fixture.assertReport(observed.report, control);
    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(observed.uri));
    assert.match(document.getText(), /selected_lookup/u);
    const readAfterReport = await control.lookupValues();
    await control.dropAlien();
    await control.removeLookupKey();
    try { await assert.rejects(inspect, /unique lookup key/u); }
    finally { await control.restoreLookupKey(); }
    assert.deepEqual(await control.kinds(), [1, 2]);

    const definition = await control.show();
    const plan = await planRebuild();
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
    assert.deepEqual(await control.show(), definition);
    assert.deepEqual(await control.kinds(), [1, 2]);
    await control.invokeFixtureProcedure(7, 1, 20);
    assert.deepEqual(await control.kinds(), [1, 2]);
    await control.invokeFixtureProcedure(7, 1);
    assert.deepEqual(await control.kinds(), [37, 2]);
    assert.deepEqual(await control.lookupValues(), readAfterReport);
    await control.assertNoEffects();
    checks.push('The installed read-only CTE report, guarded rebuild and original recovery track the physical lookup without replaying the prepared statement.');
    return { version, supported: true, readOnlyReport: true, exactCompositeCteLineage: true, observedVersionBound: true,
      lookupKeyRequired: true, physicalLookupLocked: true, migrationAndRecoveryNeverExecutedCte: true,
      laterOwnedProcedureEffect: [37, 2], boundFilterSelectedNoRows: true, unchangedLookup: true, definitionRetained: true,
      jdbc: await jdbcReadback() };
  } finally {
    await vscode.commands.executeCommand('rocketbrain.useDemo');
    await control.close();
  }
}

module.exports = { runPreparedCteChecks };
