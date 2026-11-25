'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { parsePostgreSqlPlanQuery, normalizePostgreSqlPlan, comparePostgreSqlPlans, renderPostgreSqlPlan } =
  require('../src/db/postgresql-plan');
const { createJdbcProfiles } = require('../src/db/jdbc-profiles');
const { verifyPostgreSqlPlans } = require('./postgresql-plan-host');

test('PostgreSQL estimate parses only a bounded projection and an exact integer equality', () => {
  const request = parsePostgreSqlPlanQuery('SELECT ID, amount FROM pilot.events\n WHERE ID = -9223372036854775808;', 'pilot');
  assert.deepEqual(request, { schema: 'pilot', table: 'events', columns: ['id', 'amount'], predicate: 'id=-9223372036854775808',
    canonicalSql: 'SELECT "id", "amount" FROM ONLY "pilot"."events" WHERE "id" = -9223372036854775808' });
  assert.deepEqual(parsePostgreSqlPlanQuery('select * from events', 'pilot').columns, ['*']);
  assert.throws(() => parsePostgreSqlPlanQuery('select id from absent.events', 'pilot'), /approved PostgreSQL schema/);
  assert.throws(() => parsePostgreSqlPlanQuery('select id from events where id=9223372036854775808', 'pilot'), /bigint range/);
  assert.throws(() => parsePostgreSqlPlanQuery('select id, ID from events', 'pilot'), /each PostgreSQL plan column once/);
  for (const sql of ['select f() from events', 'select * from events e', 'select * from "events"',
    'select * from events;select 1', 'select * from events where id=1 OR true', 'select * from events for update',
    'select * from events where id=1::int', 'explAIN analyze select * from events', 'select * from events -- query']) {
    assert.throws(() => parsePostgreSqlPlanQuery(sql, 'pilot'), /single PostgreSQL SELECT/);
  }
});

test('PostgreSQL estimated JSON retains exact decimals and nested operator identity', () => {
  const fields = { request: parsePostgreSqlPlanQuery('select id from events', 'pilot'), database: 'fixture', relation: '123', version: '17' };
  const raw = '[{"Plan":{"Node Type":"Gather","Total Cost":120.40,"Plans":[{"Node Type":"Seq Scan","Relation Name":"events","Plan Rows":9007199254740994}]}}]';
  const first = normalizePostgreSqlPlan({ ...fields, raw });
  const second = normalizePostgreSqlPlan({ ...fields, raw: raw.replace('120.40', '12.31') });
  assert.equal(first.nodes[0].costs[0].value, '120.40');
  assert.equal(first.nodes[1].rows[0].value, '9007199254740994');
  assert.equal(first.nodes[1].parentId, first.rootIds[0]);
  assert.match(renderPostgreSqlPlan(first), /  Seq Scan · events/);
  assert.equal(comparePostgreSqlPlans(first, second).counts.changed, 1);
  assert.throws(() => comparePostgreSqlPlans(first, { ...second, relation: '432' }), /same PostgreSQL statement and relation/);
  assert.throws(() => normalizePostgreSqlPlan({ ...fields, raw: raw.replace('120.40', '1,"Actual Rows":1') }), /unsupported/);
});

const { ROCKETBRAIN_POSTGRES_TEST_BIN: bin, ROCKETBRAIN_POSTGRES_TEST_JAR: jar, ROCKETBRAIN_POSTGRES_JAVA_HOME: javaHome } = process.env;
test('actual PostgreSQL JDBC captures a sequential and indexed estimate for the same statement', { skip: !bin || !jar || !javaHome, timeout: 90000 }, async t => {
  let saved;
  const api = createJdbcProfiles({ state: { get: () => saved, async update(_, value) { saved = value; } },
    getJavaHome: () => javaHome, isTrusted: () => true });
  try { t.diagnostic(JSON.stringify(await verifyPostgreSqlPlans(api, { bin, jar }))); }
  finally { api.dispose(); }
});
