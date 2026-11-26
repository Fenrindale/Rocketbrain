'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { test } = require('node:test');
const fixture = require('./helpers/schema-prepared-join-fixture');

const owned = fixture.ownedConfig();

test('owned prepared UPDATE JOIN retains its composite lookup through guarded rebuild and original recovery', {
  skip: !owned && 'Use an owned Spring fixture with its related schema.', timeout: 180000
}, async context => {
  const control = await fixture.create(owned.config, owned.related);
  let fresh;
  try {
    const observed = await control.db.analyzeSchemaPrograms({ routines: [control.root] });
    fixture.assertReport(observed, control);
    const [template] = observed.routines[0].dynamic.templates;
    assert.equal(template.ast.assignment, 'kind');
    const explicit = await control.db.analyzeSchemaPrograms({ routines: [control.contextual], inputs: [
      { ...control.contextual, arguments: [12, 1, control.sql] }
    ] });
    fixture.assertReport(explicit, control);
    assert.equal(explicit.dynamicContext.contextReusableForMigration, false);
    await assert.rejects(control.db.analyzeSchemaPrograms({ routines: [control.contextual] }), /finite/u);
    await assert.rejects(control.db.analyzeSchemaPrograms({ routines: [control.alien] }), /Expected JOIN/u);
    await control.dropAlien();
    await control.removeLookupKey();
    try {
      await assert.rejects(control.db.analyzeSchemaPrograms({ routines: [control.root] }), /unique lookup key/u);
      await assert.rejects(control.review(), /unique lookup key/u);
    } finally { await control.restoreLookupKey(); }
    assert.deepEqual(await control.kinds(), [1, 2]);
    const keys = await control.lookupValues(), definition = await control.show();
    const review = await control.review();
    fixture.assertPlan(review.plan, control);
    assert.equal(review.plan.requiresDependencyChangeApproval, true);
    const applied = await control.db.applySchemaRebuild({ reviewId: review.reviewId, ...fixture.flags });
    assert.equal(applied.state, 'applied', JSON.stringify(applied));
    assert.deepEqual(await control.kinds(), [1, 2]);
    assert.deepEqual(await control.lookupValues(), keys);
    fresh = new fixture.MysqlService(owned.config);
    const restored = await fresh.recoverSchemaRebuild({ operationId: applied.id, ...fixture.flags });
    assert.equal(restored.state, 'recovered', JSON.stringify(restored));
    assert.equal(restored.normalClientFencesReleased, true);
    assert.deepEqual(await control.show(), definition);
    assert.deepEqual(await control.kinds(), [1, 2]);
    await control.invokeFixtureProcedure(7, 1);
    assert.deepEqual(await control.kinds(), [37, 2]);
    assert.deepEqual(await control.lookupValues(), keys);
    await control.assertNoEffects();
    const runtime = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
    assert.match(runtime.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/u);
    const response = await fetch(runtime.baseUrl + '/probe/testing-state', { signal: AbortSignal.timeout(6000) });
    assert.equal(response.ok, true);
    const jdbc = await response.json();
    assert.deepEqual(jdbc, { people: 2, departments: 1, rolledBackNames: 0 });
    const version = (await control.actor.query('SELECT VERSION() AS version'))[0][0].version;
    const details = { sourceCommit: process.env.GITHUB_SHA || null, engine: runtime.dbEngine, version, jdbc,
      compositeUniqueLookup: true, crossSchemaSeparateDirectReadWrite: true, explicitInputsOnly: true, outerJoinRefused: true,
      droppedLookupKeyRefused: true, lookupIncludedInLocks: true, migrationAndRecoveryNeverExecutedJoin: true,
      procedureDefinitionRetained: true, actualLaterFixtureEffect: [37, 2], actualLookupUnchanged: true };
    const receipt = process.env.ROCKETBRAIN_SCHEMA_PREPARED_JOIN_RECEIPT;
    if (receipt) await fs.writeFile(receipt, JSON.stringify(details, null, 2) + '\n');
    context.diagnostic(JSON.stringify(details));
  } finally {
    await fresh?.dispose();
    await control.close();
  }
});
