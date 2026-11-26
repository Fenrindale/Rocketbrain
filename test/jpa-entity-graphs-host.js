'use strict';

const assert = require('node:assert/strict');
const { withFetchFixture } = require('./hibernate-fetch-performance-host');
const { ObserverClient } = require('../src/jpa/observer-client');
const { summarizePerformance } = require('../src/jpa/fetch-performance');
const { registeredGraphApplications } = require('../src/jpa/entity-graphs');

const name = 'PerformanceOwner.withItems';
const rootJavaType = 'fixture.boot.PerformanceOwner';
const path = ['items', 'items.snapshotLabel'];
const expected = { name, rootJavaType, paths: path, complete: true };
const routes = ['graph-fetch', 'graph-load', 'graph-dynamic', 'lazy'];
const route = page => '/probe/hibernate-fetch/' + page;

async function runGraphCalls({ runtime, secret }) {
  for (const page of routes) {
    const response = await fetch(runtime.baseUrl + route(page) + '?fixture=' + secret,
      { signal: AbortSignal.timeout(9000), redirect: 'error' });
    assert.equal(response.status, 200, page + ': ' + (response.ok ? '' : await response.text()));
    assert.deepEqual(await response.json(), { owners: 3, items: 6 });
  }
}

async function verify(fixture, refresh, graphs) {
  const before = await refresh();
  assert.equal(before.capabilities.entityGraphs, true);
  const available = before.factories.filter(value => value.entities.some(type => type.javaType === rootJavaType));
  assert.equal(available.length, 1);
  const factory = available[0];
  assert.equal(factory.statistics.enabled, true);
  const unopened = await graphs(factory.id);
  assert.equal(unopened.state, 'observed', JSON.stringify(unopened));
  assert.equal(unopened.basis, 'jakarta-named-entity-graphs');
  assert.deepEqual(unopened.graphs.find(value => value.name === name), expected);
  assert.deepEqual(registeredGraphApplications(unopened, expected), []);
  const afterRegistry = await refresh();
  assert.deepEqual(afterRegistry.factories.find(value => value.id === factory.id).statistics, factory.statistics);

  await runGraphCalls(fixture);
  const observed = await refresh();
  const observedFactory = observed.factories.find(value => value.id === factory.id);
  const registry = await graphs(factory.id);
  const report = summarizePerformance(observed.performance);
  assert.equal(report.entityGraphObservation, 'hibernate-applied-query-graph-v1');
  const rows = routes.map(page => report.requests.find(value => value.route === route(page)));
  const display = JSON.stringify(rows, null, 2);
  assert.ok(rows.every(Boolean), display);
  assert.deepEqual(rows.map(row => row.selectCount), [1, 1, 1, 4], display);
  assert.deepEqual(rows.map(row => row.suspects.length), [0, 0, 0, 1], display);
  const [fetch, load, dynamic, lazy] = rows;
  for (const row of [fetch, load, dynamic]) {
    assert.equal(row.coverage, 'complete-within-supported-hooks');
    assert.deepEqual(row.selects[0].binds.positions, [{ index: 1, jdbcType: 'BIGINT', source: 'setter' }]);
  }
  assert.deepEqual(fetch.selects[0].entityGraph, { factoryId: factory.id, semantic: 'FETCH', graph: expected }, display);
  assert.deepEqual(load.selects[0].entityGraph, { factoryId: factory.id, semantic: 'LOAD', graph: expected });
  assert.deepEqual(dynamic.selects[0].entityGraph, { factoryId: factory.id, semantic: 'FETCH',
    graph: { name: null, rootJavaType, paths: ['items'], complete: true } });
  assert.ok(lazy.selects.every(value => !value.entityGraph));
  const matched = registeredGraphApplications(registry, expected);
  assert.deepEqual(matched.map(item => [item.requestId, item.route, item.semantic, item.select]), [
    [fetch.id, route('graph-fetch'), 'FETCH', 1], [load.id, route('graph-load'), 'LOAD', 1]
  ]);
  const wrongFactory = await graphs('factory-999999');
  assert.deepEqual([wrongFactory.state, wrongFactory.reason, wrongFactory.graphs.length], ['unknown', 'factory_unavailable', 0]);
  assert.equal(wrongFactory.activity, undefined);
  const after = await refresh();
  assert.deepEqual(after.factories.find(value => value.id === factory.id).statistics, observedFactory.statistics);
  for (const secret of [fixture.secret, fixture.token, ...fixture.ownerIds]) {
    assert.ok(!JSON.stringify({ registry, report }).includes(String(secret)), 'A fixture value reached graph evidence');
  }
  return { factoryId: factory.id, graph: expected, registeredApplications: matched,
    controls: { namedSelects: [fetch.selectCount, load.selectCount], namedFindings: [fetch.suspects.length, load.suspects.length],
      lazySelects: lazy.selectCount, lazyFindings: lazy.suspects.length, dynamic: dynamic.selects[0].entityGraph.graph },
    liveBindPositions: fetch.selects[0].binds.positions, observerExecutedSql: false, valuesRetained: false, sameStatementCounters: true };
}

async function runJpaEntityGraphChecks(api, vscode, checks) {
  const observer = api.jpa.observer;
  const proof = await withFetchFixture(async fixture => {
    const direct = new ObserverClient({ url: fixture.runtime.observerUrl, token: fixture.token });
    try {
      await observer.connect({ url: fixture.runtime.observerUrl, token: fixture.token });
      const tested = await verify(fixture, () => observer.refresh(), id => direct.entityGraphs(id));
      const absent = await vscode.commands.executeCommand('rocketbrain.jpa.observer.inspectEntityGraph',
        { factoryId: tested.factoryId, name: 'ignored.dynamic.name' });
      assert.equal(absent.registration, 'absent');
      assert.deepEqual(absent.retainedApplications, []);
      const selection = { factoryId: tested.factoryId, name };
      const shown = await vscode.commands.executeCommand('rocketbrain.jpa.observer.inspectEntityGraph', selection);
      assert.equal(shown.registration, 'observed');
      assert.deepEqual(shown.graph, tested.graph);
      assert.deepEqual(shown.retainedApplications, tested.registeredApplications);
      assert.deepEqual(JSON.parse(vscode.window.activeTextEditor.document.getText()), shown);
      return { ...tested, nativeView: true };
    } finally { direct.dispose(); observer.disconnect(); }
  });
  checks.push('The running factory’s named graph and nested paths matched two application SELECTs using FETCH and LOAD. A dynamic graph and the lazy N+1 control were kept separate.');
  return proof;
}

if (require.main === module) withFetchFixture(async fixture => {
  const observer = new ObserverClient({ url: fixture.runtime.observerUrl, token: fixture.token });
  try { return await verify(fixture, () => observer.refresh(), id => observer.entityGraphs(id)); }
  finally { observer.dispose(); }
}).then(proof => console.log(JSON.stringify(proof)), error => { console.error(error.stack); process.exitCode = 1; });

module.exports = { runJpaEntityGraphChecks };
