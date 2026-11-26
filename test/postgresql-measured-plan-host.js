'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { setTimeout: delay } = require('node:timers/promises');
const { startPostgreSqlFixture } = require('./helpers/postgresql-fixture');
const { jdbcReadback } = require('./java-source-analysis-host');
const { createJdbcProfiles } = require('../src/db/jdbc-profiles');
const { renderPostgreSqlPlan, renderPostgreSqlPlanReview } = require('../src/db/postgresql-plan');

const statement = 'SELECT id, payload FROM measured_events WHERE id = 9007199254740994';
const settings = () => ({ bin: process.env.ROCKETBRAIN_POSTGRES_TEST_BIN, jar: process.env.ROCKETBRAIN_POSTGRES_TEST_JAR,
  javaHome: process.env.ROCKETBRAIN_POSTGRES_JAVA_HOME });

async function waitFor(query, probe, timeoutMs = 3000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if ((await query(probe)).trim() === '1') return;
    await delay(40);
  }
  throw Error('Expected owned PostgreSQL state did not arrive.');
}

async function cancelActiveMeasurement(api, fixture) {
  await fixture.ownerQuery(`CREATE TABLE pilot.measured_sample AS SELECT g::bigint AS id FROM generate_series(1,5000000) g;
    GRANT SELECT, MAINTAIN ON pilot.measured_sample TO rb_fixture;`);
  const review = await api.reviewPostgreSqlMeasurement('SELECT id FROM measured_sample');
  const watcher = fixture.ownerQuery(`DO $$ BEGIN
    FOR tick IN 1..1400 LOOP
      PERFORM pg_stat_clear_snapshot();
      IF EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name='Rocketbrain PostgreSQL Plan'
          AND state='active' AND query LIKE 'EXPLAIN (ANALYZE TRUE, BUFFERS TRUE,%') THEN RETURN; END IF;
      PERFORM pg_sleep(0.01);
    END LOOP;
    RAISE EXCEPTION 'Owned EXPLAIN ANALYZE did not become active';
  END $$;`);
  const controller = new AbortController();
  const result = api.measurePostgreSqlPlan(review.id, true, { signal: controller.signal });
  const outcome = result.then(value => ({ value }), error => ({ error }));
  // Abort the exact attempt only after pg_stat_activity observed EXPLAIN ANALYZE in flight.
  try { await watcher; }
  finally { controller.abort(); }
  assert.equal((await outcome).error?.code, 'ROCKETBRAIN_JDBC_CANCELLED');
  await waitFor(fixture.ownerQuery, `SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM pg_stat_activity
    WHERE application_name='Rocketbrain PostgreSQL Plan' AND state='active');`);
  assert.equal((await fixture.ownerQuery('SELECT count(*) FROM pilot.measured_sample')).trim(), '5000000');
  return true;
}

async function verifyPostgreSqlMeasuredPlan(api, { bin, jar, nativeReview, activeCancel = false, readback }) {
  const fixture = await startPostgreSqlFixture(bin);
  let profile;
  try {
    assert.match(fixture.version, /^PostgreSQL 17\.12\b/);
    await fixture.ownerQuery(`CREATE TABLE pilot.measured_events(id bigint PRIMARY KEY, payload text);
      INSERT INTO pilot.measured_events SELECT g, 'observed' FROM generate_series(1,12000) g;
      INSERT INTO pilot.measured_events VALUES (9007199254740994,'exact bigint');
      CREATE TABLE pilot.measured_denied(id int);
      CREATE TABLE pilot.measured_policy(id int);
      ALTER TABLE pilot.measured_policy ENABLE ROW LEVEL SECURITY;
      CREATE POLICY measured_hidden ON pilot.measured_policy FOR SELECT USING (false);
      CREATE TABLE pilot.measured_index_expression(id int);
      CREATE INDEX measured_unapproved_idx ON pilot.measured_index_expression ((abs(id)));
      ANALYZE pilot.measured_events;
      GRANT SELECT, MAINTAIN ON pilot.measured_events,pilot.measured_policy,pilot.measured_index_expression TO rb_fixture;
      GRANT SELECT ON pilot.measured_denied TO rb_fixture;`);
    const grant = await api.prepare({ name: 'PostgreSQL measured plan fixture', jar, driverClass: 'org.postgresql.Driver', postgresql: fixture.route });
    profile = await api.save(grant.id, true);
    const opened = await api.open(profile.id, fixture.auth);
    assert.equal(api.supportsPostgreSqlMeasurements(), true);
    assert.equal((await fixture.query('BEGIN READ ONLY; LOCK TABLE ONLY pilot.measured_events IN SHARE UPDATE EXCLUSIVE MODE NOWAIT;' +
      'SHOW transaction_read_only; ROLLBACK;')).trim(), 'on');
    await assert.rejects(fixture.query('BEGIN READ ONLY; INSERT INTO pilot.guard_write VALUES (7);'), /read-only transaction/);
    await assert.rejects(api.reviewPostgreSqlMeasurement('SELECT id FROM measured_denied'), { code: 'ROCKETBRAIN_JDBC_PLAN_LOCK' });

    const review = await (nativeReview || (sql => api.reviewPostgreSqlMeasurement(sql)))(statement);
    assert.equal(review.estimate.measured, false);
    assert.match(review.estimate.scopeFingerprint, /^[a-f0-9]{64}$/u);
    assert.equal(review.estimate.boundPredicate, 'id=9007199254740994');
    assert.match(review.estimate.executionSql, /OPERATOR\(pg_catalog\.=\) \?::pg_catalog.int8/u);
    assert.doesNotMatch(review.estimate.raw, /Actual |Execution Time/);
    assert.match(renderPostgreSqlPlanReview(review), /SHARE UPDATE EXCLUSIVE/);
    await assert.rejects(api.measurePostgreSqlPlan(review.id, false), /explicitly approve/iu);
    assert.equal(api.postgreSqlPlanCaptures().length, 1);
    const result = await api.measurePostgreSqlPlan(review.id, true);
    assert.equal(result.measured, true);
    assert.equal(result.scopeFingerprint, review.estimate.scopeFingerprint);
    assert.equal(result.executionSql, review.estimate.executionSql);
    assert.equal(result.canonicalSql, review.estimate.canonicalSql);
    assert.equal(result.nodes[0].kind, 'Index Scan');
    const actual = Object.fromEntries(result.nodes[0].actual.map(entry => [entry.label, entry.value]));
    assert.equal(actual['Actual Rows'], '1');
    assert.equal(actual['Actual Loops'], '1');
    assert.ok(Number(actual['Shared Hit Blocks']) + Number(actual['Shared Read Blocks']) > 0);
    assert.equal(JSON.parse(result.raw)[0].Plan['Actual Rows'], 1);
    assert.match(renderPostgreSqlPlan(result), /Execution Time .* ms[\s\S]*Shared Hit Blocks/u);
    assert.equal(api.postgreSqlPlanCapture(result.id).raw, result.raw);
    const comparison = api.comparePostgreSqlPlans(review.estimate.id, result.id);
    assert.equal(comparison.sameReviewedScope, true);
    assert.equal(comparison.optimizerCostUnitsAreNotMilliseconds, true);
    assert.deepEqual(comparison.rowEstimates, [{ operator: 'Index Scan · measured_events', estimatedRows: '1', actualRowsPerLoop: '1', loops: '1' }]);
    await assert.rejects(api.measurePostgreSqlPlan(review.id, true), /Review this exact/iu);

    for (const sql of ['SELECT pilot.test_guard()', 'SELECT random() FROM measured_events', 'SELECT id FROM measured_events FOR UPDATE',
      'SELECT id FROM measured_events; DELETE FROM measured_events', 'SELECT id FROM hidden.outside']) {
      await assert.rejects(api.reviewPostgreSqlMeasurement(sql), /single PostgreSQL SELECT|approved PostgreSQL schema/iu);
    }
    for (const sql of ['SELECT id FROM active_events', 'SELECT id FROM measured_policy', 'SELECT id FROM measured_index_expression']) {
      await assert.rejects(api.reviewPostgreSqlMeasurement(sql), { code: 'ROCKETBRAIN_JDBC_PLAN_SCOPE' });
    }
    const stale = await api.reviewPostgreSqlMeasurement(statement);
    await fixture.ownerQuery('ALTER TABLE pilot.measured_events ADD COLUMN changed text;');
    await assert.rejects(api.measurePostgreSqlPlan(stale.id, true), { code: 'ROCKETBRAIN_JDBC_PLAN_STALE' });

    const busy = await api.reviewPostgreSqlMeasurement(statement);
    const busyOwner = fixture.ownerQuery("SET application_name='Rocketbrain Measured Fixture Lock'; BEGIN; " +
      'LOCK TABLE ONLY pilot.measured_events IN SHARE MODE; SELECT pg_sleep(17); ROLLBACK;')
      .catch(error => { if (!/canceling statement due to user request/iu.test(error.message)) throw error; });
    try {
      await waitFor(fixture.ownerQuery, "SELECT 1 FROM pg_locks WHERE relation='pilot.measured_events'::regclass AND mode='ShareLock' AND granted;");
      await assert.rejects(api.measurePostgreSqlPlan(busy.id, true), { code: 'ROCKETBRAIN_JDBC_PLAN_BUSY' });
    } finally {
      await fixture.ownerQuery("SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE application_name='Rocketbrain Measured Fixture Lock';");
      await busyOwner;
    }

    const pending = await api.reviewPostgreSqlMeasurement(statement);
    const beforeApproval = new AbortController();
    beforeApproval.abort();
    await assert.rejects(api.measurePostgreSqlPlan(pending.id, true, { signal: beforeApproval.signal }), /cancelled/iu);
    assert.equal((await fixture.query('SELECT count(*) FROM pilot.guard_write')).trim(), '0');
    assert.equal((await fixture.query('SELECT count(*) FROM pilot.measured_events')).trim(), '12001');
    const cancelledWhileMeasuring = activeCancel ? await cancelActiveMeasurement(api, fixture) : false;
    api.close();
    await api.open(profile.id, fixture.auth);
    await assert.rejects(api.measurePostgreSqlPlan(pending.id, true), /Review this exact/iu);
    const timings = Object.fromEntries(result.summary.map(entry => [entry.label, entry.value]));
    return { server: fixture.version, driver: opened.connection.driverVersion, readOnlyLocked: true,
      observed: { operation: result.nodes[0].kind, estimatedRows: comparison.rowEstimates[0].estimatedRows,
        rowsPerLoop: actual['Actual Rows'], loops: actual['Actual Loops'], planningMs: timings['Planning Time'], executionMs: timings['Execution Time'],
        sharedHitBlocks: actual['Shared Hit Blocks'], sharedReadBlocks: actual['Shared Read Blocks'] },
      lockedEstimateBeforeExecution: true, actualTimingAndBuffers: true, matchingRowsCompared: true, exactBigintParameter: true,
      unsafeSelectAndCatalogRejected: true, singleUseApproval: true, staleAndBusyRejected: true,
      cancelledBeforeExecution: true, cancelledWhileMeasuring, unchangedData: true,
      ...(readback && { spring: await readback() }) };
  } finally {
    api.close();
    if (profile) await api.remove(profile.id);
    await fixture.close();
    await assert.rejects(fs.stat(fixture.folder), { code: 'ENOENT' });
  }
}

async function verifyPostgreSqlMeasuredPlanBackend() {
  const { bin, jar, javaHome } = settings();
  let state;
  const api = createJdbcProfiles({ state: { get: () => state, async update(_, value) { state = value; } },
    isTrusted: () => true, getJavaHome: () => javaHome });
  try {
    return await verifyPostgreSqlMeasuredPlan(api, { bin, jar, activeCancel: process.env.ROCKETBRAIN_POSTGRES_MEASURED_ACTIVE_CANCEL === '1',
      readback: process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG ? jdbcReadback : undefined });
  } finally { api.dispose(); }
}

async function runPostgreSqlMeasuredPlanChecks(api, vscode, checks) {
  const { bin, jar } = settings();
  assert.ok(bin && jar);
  const result = await verifyPostgreSqlMeasuredPlan(api.jdbc, { bin, jar, readback: jdbcReadback, async nativeReview(sql) {
    const source = await vscode.workspace.openTextDocument({ language: 'rocketbrain-jdbc', content: sql });
    await vscode.window.showTextDocument(source, { preview: false });
    const review = await vscode.commands.executeCommand('rocketbrain.jdbc.reviewPostgreSqlMeasurement');
    assert.ok(review?.reviewUri);
    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(review.reviewUri));
    assert.ok(document.getText().includes(review.estimate.executionSql));
    assert.match(document.getText(), /Measurement executes this SELECT/);
    assert.equal(document.isDirty, false);
    assert.equal(source.isClosed, false);
    return review;
  } });
  checks.push('The installed PostgreSQL measurement workflow opened the exact readonly query review and captured real EXPLAIN ANALYZE timings and buffers with stale, lock, and no-approval controls.');
  return { ...result, nativePostgreSqlMeasuredReview: true };
}

module.exports = { verifyPostgreSqlMeasuredPlanBackend, runPostgreSqlMeasuredPlanChecks };
if (require.main === module) verifyPostgreSqlMeasuredPlanBackend().then(value => console.log(JSON.stringify(value)))
  .catch(error => { console.error(error.stack); process.exitCode = 1; });
