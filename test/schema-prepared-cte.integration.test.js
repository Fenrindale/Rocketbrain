'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { test } = require('node:test');
const fixture = require('./helpers/schema-prepared-join-fixture');

const owned = fixture.ownedConfig();

test('owned Spring prepared WITH UPDATE uses physical lookup dependencies and a version-gated, non-replay migration', {
  skip: !owned && 'Use an owned Spring fixture with its related schema.', timeout: 240000
}, async context => {
  const control = await fixture.create(owned.config, owned.related, { withCte: true });
  let fresh;
  try {
    const version = (await control.actor.query('SELECT VERSION() AS version'))[0][0].version;
    const inspect = async () => control.db.analyzeSchemaPrograms({ routines: [control.root] });
    const details = { sourceCommit: process.env.GITHUB_SHA || null, version };
    if (version === '11.4.8-MariaDB') {
      await assert.rejects(inspect, /requires observed MySQL 8.4\+ or MariaDB 12.3\+/u);
      await control.dropAlien();
      await assert.rejects(control.review(), /requires observed MySQL 8.4\+ or MariaDB 12.3\+/u);
      await assert.rejects(control.invokeFixtureProcedure(7, 1), { code: 'ER_PARSE_ERROR', errno: 1064 });
      assert.deepEqual(await control.kinds(), [1, 2]);
      Object.assign(details, { supported: false, analysisRefused: true, rebuildPreviewRefused: true,
        vendorParserError: 1064, writesUnchanged: true });
    } else {
      assert.match(version, /^(?:8\.4\.13|12\.3\.4-MariaDB)$/u);
      const observed = await inspect();
      fixture.assertReport(observed, control);
      const explicit = await control.db.analyzeSchemaPrograms({ routines: [control.contextual], inputs: [
        { ...control.contextual, arguments: [7, 1, 10, control.sql] }
      ] });
      fixture.assertReport(explicit, control);
      assert.equal(explicit.dynamicContext.contextReusableForMigration, false);
      await assert.rejects(control.db.analyzeSchemaPrograms({ routines: [control.contextual] }), /finite/u);
      await assert.rejects(control.db.analyzeSchemaPrograms({ routines: [control.alien] }), /Expected JOIN/u);
      await control.dropAlien();

      const staleReview = await control.review();
      fixture.assertPlan(staleReview.plan, control);
      await control.removeLookupKey();
      try {
        await assert.rejects(inspect, /unique lookup key/u);
        await assert.rejects(control.review(), /unique lookup key/u);
        await assert.rejects(control.db.applySchemaRebuild({ reviewId: staleReview.reviewId, ...fixture.flags }), /unique lookup key/u);
      } finally { await control.restoreLookupKey(); }
      assert.deepEqual(await control.kinds(), [1, 2]);

      const lookupBefore = await control.lookupValues(), definition = await control.show();
      const review = await control.review();
      fixture.assertPlan(review.plan, control);
      const applied = await control.db.applySchemaRebuild({ reviewId: review.reviewId, ...fixture.flags });
      assert.equal(applied.state, 'applied', JSON.stringify(applied));
      assert.deepEqual(await control.kinds(), [1, 2]);
      assert.deepEqual(await control.lookupValues(), lookupBefore);
      fresh = new fixture.MysqlService(owned.config);
      const restored = await fresh.recoverSchemaRebuild({ operationId: applied.id, ...fixture.flags });
      assert.equal(restored.state, 'recovered', JSON.stringify(restored));
      assert.equal(restored.normalClientFencesReleased, true);
      assert.deepEqual(await control.show(), definition);
      assert.deepEqual(await control.kinds(), [1, 2]);
      await control.invokeFixtureProcedure(7, 1, 20);
      assert.deepEqual(await control.kinds(), [1, 2]);
      await control.invokeFixtureProcedure(7, 1);
      assert.deepEqual(await control.kinds(), [37, 2]);
      assert.deepEqual(await control.lookupValues(), lookupBefore);
      Object.assign(details, { supported: true, explicitInputsOnly: true, outerJoinRefused: true, missingUniqueRefused: true,
        staleKeyApplyRefused: true, exactCompositeCteLineage: true, observedVersionBound: true, physicalLookupLocked: true,
        migrationAndRecoveryNeverExecutedCte: true, definitionRetained: true, boundFilterSelectedNoRows: true,
        laterOwnedProcedureEffect: [37, 2], unchangedLookup: true });
    }
    await control.assertNoEffects();
    const runtime = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
    assert.match(runtime.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/u);
    const response = await fetch(runtime.baseUrl + '/probe/testing-state', { signal: AbortSignal.timeout(6000) });
    assert.equal(response.ok, true);
    const jdbc = await response.json();
    assert.deepEqual(jdbc, { people: 2, departments: 1, rolledBackNames: 0 });
    Object.assign(details, { engine: runtime.dbEngine, jdbc });
    const receipt = process.env.ROCKETBRAIN_SCHEMA_PREPARED_CTE_RECEIPT;
    if (receipt) await fs.writeFile(receipt, JSON.stringify(details, null, 2) + '\n');
    context.diagnostic(JSON.stringify(details));
  } finally {
    await fresh?.dispose();
    await control.close();
  }
});
