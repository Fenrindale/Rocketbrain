'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { startPostgreSqlFixture } = require('./helpers/postgresql-fixture');

const statement = 'SELECT id, note FROM plan_events WHERE id = 9007199254740994';

async function verifyPostgreSqlPlans(api, { bin, jar, nativeCapture }) {
  const fixture = await startPostgreSqlFixture(bin);
  let profile;
  try {
    await fixture.ownerQuery(`
      CREATE TABLE pilot.plan_events(id bigint NOT NULL, note text);
      INSERT INTO pilot.plan_events SELECT g, 'payload' FROM generate_series(1, 12000) g;
      INSERT INTO pilot.plan_events VALUES (9007199254740994, 'exact');
      ANALYZE pilot.plan_events;
      CREATE TABLE pilot.plan_policy(id int);
      ALTER TABLE pilot.plan_policy ENABLE ROW LEVEL SECURITY;
      CREATE POLICY plan_hidden ON pilot.plan_policy FOR SELECT USING (false);
      CREATE TABLE pilot.plan_expression(id int);
      CREATE INDEX plan_expression_index ON pilot.plan_expression ((abs(id)));
      CREATE TABLE pilot.plan_constraint(id int CHECK (id > 0));
      CREATE DOMAIN pilot.plan_domain AS integer CHECK (VALUE > 0);
      CREATE TABLE pilot.plan_custom_type(id pilot.plan_domain);
      GRANT SELECT ON pilot.plan_events,pilot.plan_policy,pilot.plan_expression,pilot.plan_constraint,pilot.plan_custom_type TO rb_fixture;
    `);
    const draft = await api.prepare({ name: 'PostgreSQL estimated plan fixture', jar,
      driverClass: 'org.postgresql.Driver', postgresql: fixture.route });
    profile = await api.save(draft.id, true);
    const catalog = await api.open(profile.id, fixture.auth);
    assert.equal(api.supportsPostgreSqlPlans(), true);
    await assert.rejects(fixture.query('CREATE INDEX denied_idx ON pilot.plan_events(id);'), /must be owner|permission denied/);

    const capture = nativeCapture || (sql => api.estimatePostgreSqlPlan(sql));
    const baseline = await capture(statement);
    assert.equal(baseline.engine, 'postgresql');
    assert.equal(baseline.format, 'json');
    assert.equal(baseline.database, fixture.route.database);
    assert.equal(baseline.schema, 'pilot');
    assert.equal(baseline.measured, false);
    assert.equal(baseline.nodes[0].kind, 'Seq Scan');
    assert.equal(baseline.nodes[0].rows.find(x => x.label === 'Plan Rows').value, '1');
    assert.ok(baseline.nodes[0].expressions.some(x => x.value.includes('9007199254740994')));
    assert.ok(!/Actual |Execution Time/.test(baseline.raw));
    assert.equal(JSON.parse(baseline.raw)[0].Plan['Node Type'], 'Seq Scan');
    await fixture.ownerQuery('CREATE INDEX plan_events_id ON pilot.plan_events(id);');
    const indexed = await capture(statement);
    assert.equal(indexed.nodes[0].kind, 'Index Scan');
    assert.ok(indexed.nodes[0].tags.some(x => x.value === 'plan_events_id'));
    assert.equal(indexed.relation, baseline.relation);
    const diff = api.comparePostgreSqlPlans(baseline.id, indexed.id);
    assert.equal(diff.measured, false);
    assert.equal(diff.counts.added, 1);
    assert.equal(diff.counts.removed, 1);
    assert.equal(api.postgreSqlPlanCapture(baseline.id).raw, baseline.raw);

    const different = await api.estimatePostgreSqlPlan('SELECT id FROM plan_events WHERE id = 1');
    assert.throws(() => api.comparePostgreSqlPlans(baseline.id, different.id), /same PostgreSQL statement and relation/);
    for (const sql of ['SELECT id FROM active_events', 'SELECT id FROM cached_events', 'SELECT id FROM plan_policy',
      'SELECT id FROM plan_expression', 'SELECT id FROM plan_constraint', 'SELECT id FROM plan_custom_type',
      'SELECT id FROM plan_events WHERE note = 4']) {
      await assert.rejects(api.estimatePostgreSqlPlan(sql), { code: 'ROCKETBRAIN_JDBC_PLAN_SCOPE' });
    }
    for (const sql of ['SELECT pilot.test_guard()', 'SELECT id FROM hidden.outside', 'SELECT id FROM plan_events; DELETE FROM plan_events']) {
      await assert.rejects(api.estimatePostgreSqlPlan(sql), /single PostgreSQL SELECT|approved PostgreSQL schema/);
    }
    const cancellation = new AbortController();
    cancellation.abort();
    await assert.rejects(api.estimatePostgreSqlPlan(statement, { signal: cancellation.signal }), /cancelled/i);
    assert.equal(api.postgreSqlPlanCaptures().length, 3);
    assert.equal((await fixture.query('SELECT count(*) FROM pilot.guard_write;')).trim(), '0');
    assert.equal((await fixture.query('SELECT count(*) FROM pilot.plan_events;')).trim(), '12001');
    api.close();
    assert.throws(() => api.postgreSqlPlanCapture(baseline.id), /Open a saved JDBC connection/);
    return { server: fixture.version, driver: catalog.connection.driverVersion, estimateOnly: true,
      operatorChange: [baseline.nodes[0].kind, indexed.nodes[0].kind], exactBigint: true, renderer: Boolean(nativeCapture),
      exactJson: true, sameRelationComparison: true, scopeRefusals: 10, readOnlyAccount: true, cancellation: true,
      unchangedRows: true, capturesExpire: true, cleaned: true };
  } finally {
    api.close();
    if (profile) await api.remove(profile.id);
    await fixture.close();
    await assert.rejects(fs.stat(fixture.folder), { code: 'ENOENT' });
  }
}

async function runPostgreSqlPlanChecks(api, vscode, checks) {
  const bin = process.env.ROCKETBRAIN_POSTGRES_TEST_BIN, jar = process.env.ROCKETBRAIN_POSTGRES_TEST_JAR;
  assert.ok(bin && jar, 'Configure the owned PostgreSQL vendor fixture.');
  const result = await verifyPostgreSqlPlans(api.jdbc, { bin, jar, async nativeCapture(sql) {
    const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: 'rocketbrain-jdbc', content: sql }));
    assert.equal(editor.document.getText(), sql);
    const plan = await vscode.commands.executeCommand('rocketbrain.jdbc.estimatePostgreSqlPlan');
    const native = vscode.window.activeTextEditor?.document;
    assert.equal(native?.uri.scheme, 'rocketbrain-jdbc-output');
    assert.ok(native.getText().includes(plan.nodes[0].kind));
    assert.ok(native.getText().includes('Optimizer estimates only'));
    assert.equal(native.isDirty, false);
    return plan;
  } });
  checks.push('PostgreSQL estimated JSON plan tree and same-statement index comparison on the actual scoped read-only JDBC route');
  return result;
}

module.exports = { verifyPostgreSqlPlans, runPostgreSqlPlanChecks };
