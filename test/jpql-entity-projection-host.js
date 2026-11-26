'use strict';

const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const { ObserverClient } = require('../src/jpa/observer-client');
const { readConfig } = require('./jpql-console-host');

const ROOT = 'select p from Person p where p.id >= :floor order by p.id';
const DISTINCT = 'select distinct d from Person p join p.department d where p.id >= ?1 order by d.id';
const LEFT = 'select d from Person p left join p.department d on d.id = :wanted order by p.id';
const CALLBACK = 'select c from FetchSnapshotCallback c where c.id = :callback';
const CALLBACK_ID = 390061;

async function withProjection(operation) {
  const { config, database, token } = readConfig();
  const client = new ObserverClient({ url: config.observerUrl, token, timeoutMs: 15000 });
  const db = await mysql.createConnection(database);
  let inserted = false;
  try {
    const [[before]] = await db.execute('SELECT COUNT(*) AS count FROM rb_fetch_snapshot_callback WHERE id = ?', [CALLBACK_ID]);
    assert.equal(Number(before.count), 0);
    await db.execute('INSERT INTO rb_fetch_snapshot_callback (id,owner_id) VALUES (?,NULL)', [CALLBACK_ID]);
    inserted = true;
    return await operation({ config, client, db, token });
  } finally {
    try {
      if (inserted) await db.execute('DELETE FROM rb_fetch_snapshot_callback WHERE id = ?', [CALLBACK_ID]);
    } finally {
      await db.end();
      client.dispose();
    }
  }
}

async function verifyEntityProjection({ config, client, db }, earlierReview) {
  const observed = await client.refresh();
  assert.equal(observed.consoleSelectEnabled, true);
  assert.equal(observed.consoleEntityProjectionsEnabled, true);
  const factory = observed.factories.find(item => item.entities.some(entity => entity.javaType === 'fixture.boot.Person'));
  assert.ok(factory);
  const factoryId = factory.id;
  const statements = async () => {
    const found = (await client.refresh()).factories.find(item => item.id === factoryId);
    assert.equal(found.statistics.enabled, true);
    return found.statistics.prepareStatementCount;
  };
  const plan = async (query, type, alias, nullable, key) => {
    const before = await statements();
    const desc = await client.describeSelect(query, factoryId);
    assert.equal(desc.state, 'described', JSON.stringify(desc));
    assert.deepEqual(desc.parameters, [{ key, javaType: 'java.lang.Long' }]);
    assert.equal(desc.sqlExecuted, false);
    assert.equal(desc.entityProjection?.javaType, type);
    assert.equal(desc.entityProjection.alias, alias);
    assert.equal(desc.entityProjection.id, 'id');
    assert.equal(desc.entityProjection.nullable, nullable);
    assert.equal(desc.entityProjection.scalarFieldsOnly, true);
    assert.match(desc.entityProjection.review, /^[a-f0-9]{64}$/u);
    assert.equal(await statements(), before);
    return desc;
  };
  const run = async (query, description, values, limit) => {
    const before = await statements();
    const result = await client.select(query, factoryId, values, limit, description.entityProjection.review);
    assert.equal(result.state, 'executed', JSON.stringify(result));
    assert.deepEqual(result.entityProjection, description.entityProjection);
    assert.deepEqual(result.columns, description.columns);
    assert.equal(await statements() - before, 1);
    assert.ok(result.databaseReadOnlyTransaction && result.rolledBack);
    assert.equal(result.boundParameterValuesRetained, false);
    return result;
  };
  const person = await plan(ROOT, 'fixture.boot.Person', 'p', false, ':floor');
  assert.deepEqual(person.columns, [
    { alias: 'id', javaType: 'java.lang.Long' },
    { alias: 'createdAt', javaType: 'java.time.LocalDateTime' },
    { alias: 'displayName', javaType: 'java.lang.String' },
    { alias: 'version', javaType: 'java.lang.Long' }
  ]);
  const root = await run(ROOT, person, { ':floor': '1' }, 1);
  assert.deepEqual(root.rows, [['1', '2026-11-12T00:00', 'Alex', '0']]);
  assert.equal(root.hasMore, true);
  const grouped = await plan(DISTINCT, 'fixture.boot.Department', 'd', false, '?1');
  const unique = await run(DISTINCT, grouped, { '?1': '1' }, 10);
  assert.deepEqual(unique.rows, [['1', '2026-11-12T00:00', 'Engineering', '0']]);
  const optional = await plan(LEFT, 'fixture.boot.Department', 'd', true, ':wanted');
  const missing = await run(LEFT, optional, { ':wanted': '0' }, 10);
  assert.deepEqual(missing.rows, [Array(4).fill(null), Array(4).fill(null)]);
  const callback = await plan(CALLBACK, 'fixture.boot.FetchSnapshotCallback', 'c', false, ':callback');
  assert.deepEqual(callback.columns, [{ alias: 'id', javaType: 'java.lang.Long' }]);
  assert.deepEqual((await run(CALLBACK, callback, { ':callback': String(CALLBACK_ID) }, 2)).rows, [[String(CALLBACK_ID)]]);

  const beforeReject = await statements();
  const controls = [
    [ROOT, { ':floor': '1' }, undefined, 'entity_review_required'],
    [ROOT, { ':floor': '1' }, grouped.entityProjection.review, 'entity_projection_changed'],
    [ROOT.replace('>=', '>'), { ':floor': '1' }, person.entityProjection.review, 'entity_projection_changed'],
    ['select p.department from Person p', {}, undefined, 'scalar_projection_required'],
    ['select d from Department d join d.people p', {}, undefined, 'unsupported_entity_projection_shape'],
    ['select c from CustomRecord c', {}, undefined, 'unsupported_entity_projection_mapping'],
    ['select a from Asset a', {}, undefined, 'unsupported_entity_projection_mapping'],
    ['select p.id from Person p', {}, person.entityProjection.review, 'entity_projection_changed'],
    [ROOT, { ':floor': 'bad' }, person.entityProjection.review, 'invalid_parameter_value']
  ];
  if (earlierReview) controls.push([ROOT, { ':floor': '1' }, earlierReview, 'entity_projection_changed']);
  for (const [query, values, review, code] of controls) {
    assert.deepEqual(await client.select(query, factoryId, values, 5, review), { state: 'rejected', code }, query);
  }
  assert.equal(await statements(), beforeReject);
  const scalar = await client.select('select displayName from Person p order by p.id', factoryId, {}, 10);
  assert.deepEqual(scalar.rows, [['Alex'], ['Mina']]);
  assert.equal(scalar.entityProjection, undefined);
  const finished = await client.refresh();
  assert.ok(!finished.events.some(item => [ROOT, LEFT, DISTINCT, CALLBACK].includes(item.query)));
  const [[version]] = await db.query('SELECT VERSION() AS version');
  assert.equal(/mariadb/iu.test(version.version), config.dbEngine === 'mariadb');
  const [actual] = await db.query('SELECT display_name FROM rb_spring_person ORDER BY id');
  assert.deepEqual(actual.map(item => item.display_name), ['Alex', 'Mina']);
  return { factoryId, review: person.entityProjection.review, report: {
    engine: config.dbEngine, version: version.version, hibernate: factory.version, typedRoot: true,
    distinctJoinedEntity: true, leftJoinNoEntity: true, noEntityHydration: true,
    exactTypedParameters: true, oneSelectPerRun: true, errorsBeforeSql: true,
    staleMappingReviewRefused: true, detachedProjectionRefused: true, earlierFactoryReviewRefused: !!earlierReview, scalarPreserved: true
  } };
}

async function runJpaEntityProjectionChecks(api, vscode, checks) {
  return withProjection(async owned => {
    const { config, token } = owned;
    const { factoryId, report } = await verifyEntityProjection(owned);
    await api.jpa.observer.connect({ url: config.observerUrl, token, timeoutMs: 15000 });
    try {
      const result = await vscode.commands.executeCommand('rocketbrain.jpa.console.run', {
        approved: true, query: LEFT, factoryId, values: { ':wanted': '0' }, limit: 10
      });
      assert.equal(result?.view, 'rocketbrain.jpql.result');
      assert.equal(result.entityProjection?.javaType, 'fixture.boot.Department');
      assert.deepEqual(result.rows, [Array(4).fill(null), Array(4).fill(null)]);
      assert.ok(vscode.window.tabGroups.all.some(group => group.tabs.some(tab => tab.label === 'JPQL Results')));
      checks.push('Reviewed root and joined Hibernate entity fields in the JPQL console and returned exactly one read-only SELECT per run.');
      return { ...report, nativeView: true };
    } finally {
      api.jpa.observer.disconnect();
    }
  });
}

module.exports = { withProjection, verifyEntityProjection, runJpaEntityProjectionChecks };
