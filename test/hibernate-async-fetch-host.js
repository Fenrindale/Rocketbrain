'use strict';

const assert = require('node:assert/strict');
const { ObserverClient } = require('../src/jpa/observer-client');
const { summarizePerformance } = require('../src/jpa/fetch-performance');
const { withFetchFixture } = require('./hibernate-fetch-performance-host');

const route = name => '/probe/hibernate-fetch/' + name;
const endpoints = ['callable', 'concurrent-join', 'deferred', 'callable-timeout'];

async function exercise({ runtime, secret }) {
  async function request(name, expected) {
    const response = await fetch(runtime.baseUrl + route(name) + '?fixture=' + secret, {
      signal: AbortSignal.timeout(12000), redirect: 'error'
    });
    assert.equal(response.status, 200, name + ': ' + (response.ok ? '' : await response.text()));
    assert.deepEqual(await response.json(), expected);
  }
  const count = { owners: 3, items: 6 };
  await Promise.all([request('callable', count), request('concurrent-join', count)]);
  await request('deferred', count);
  await request('callable-timeout', { timedOut: true });
}

function verify(snapshot, report, secrets) {
  assert.equal(snapshot.performance.available, true, JSON.stringify(snapshot.warnings));
  assert.equal(report.callableObservation, true, JSON.stringify(snapshot.warnings));
  assert.equal(report.rawBindValuesRetained, false);
  assert.equal(report.observerExecutedSql, false);
  const [callable, ordinary, deferred, timeout] = endpoints.map(name => report.requests.find(row => row.route === route(name)));
  const display = JSON.stringify(report.requests, null, 2);
  assert.ok(callable && ordinary && deferred && timeout, display);
  assert.equal(new Set([callable, ordinary, deferred, timeout].map(row => row.id)).size, 4);
  assert.deepEqual([callable, ordinary, deferred, timeout].map(row => row.dispatch),
    ['spring-mvc-callable', 'synchronous', 'unattributed', 'spring-mvc-callable'], display);
  assert.deepEqual([callable, ordinary, deferred, timeout].map(row => row.coverage),
    ['complete-within-supported-hooks', 'complete-within-supported-hooks', 'partial', 'partial'], display);
  assert.deepEqual([callable, ordinary, deferred, timeout].map(row => row.selectCount), [6, 1, 1, 1], display);
  assert.deepEqual([callable, ordinary, deferred, timeout].map(row => row.suspects.length), [1, 0, 0, 0], display);

  const phases = callable.selects.map(row => row.phase);
  assert.deepEqual(phases, ['request', ...Array(4).fill('callable-worker'), 'async-dispatch']);
  assert.deepEqual(callable.selects.map(row => row.sequence), [1, 2, 3, 4, 5, 6]);
  const [finding] = callable.suspects;
  assert.equal(finding.collectionRole, 'fixture.boot.PerformanceOwner.items');
  assert.equal(finding.parent.sequence, 2);
  assert.deepEqual(finding.child.sequences, [3, 4, 5]);
  assert.equal(finding.child.distinctOwnerKeys, 3);
  const childPositions = [{ index: 1, jdbcType: 'BIGINT', source: 'setter' }];
  for (const select of callable.selects.slice(2, 5)) {
    assert.equal(select.session, callable.selects[1].session);
    assert.deepEqual(select.binds, { state: 'complete', placeholders: 1, positions: childPositions });
  }
  for (const marker of [callable.selects[0], callable.selects[5], deferred.selects[0], timeout.selects[0]]) {
    assert.equal(marker.table, 'rb_spring_person');
    assert.deepEqual(marker.binds, { state: 'complete', placeholders: 1, positions: childPositions });
  }
  assert.equal(ordinary.selects[0].phase, 'request');
  assert.equal(timeout.selects[0].phase, 'callable-worker');
  assert.equal(deferred.selects[0].phase, 'request');

  const serialized = JSON.stringify({ performance: snapshot.performance, report });
  for (const value of secrets) assert.ok(!serialized.includes(String(value)), 'A raw bind or request value reached captured data.');
  return { callable: callable.id, phases, childPositions, matchedCollection: finding.collectionRole,
    distinctOwnerKeys: finding.child.distinctOwnerKeys, concurrentOrdinarySelects: ordinary.selectCount,
    deferred: deferred.coverage, timeout: timeout.coverage, rawBindValuesRetained: false, observerExecutedSql: false };
}

async function untilObserved(refresh, readReport, secrets) {
  const limit = Date.now() + 3000;
  for (;;) {
    const snapshot = await refresh();
    const report = readReport(snapshot);
    if (Date.now() >= limit || endpoints.every(name => report.requests.some(row => row.route === route(name)))) {
      return verify(snapshot, report, secrets);
    }
    await new Promise(resolve => setTimeout(resolve, 60));
  }
}

async function runHibernateAsyncFetchChecks(api, vscode, checks) {
  const observer = api.jpa.observer;
  const proof = await withFetchFixture(async fixture => {
    try {
      await observer.connect({ url: fixture.runtime.observerUrl, token: fixture.token });
      await exercise(fixture);
      const result = await untilObserved(() => observer.refresh(), () => observer.performance(),
        [fixture.secret, fixture.token, ...fixture.ownerIds]);
      const detail = await vscode.commands.executeCommand('rocketbrain.jpa.observer.inspectPerformance', result.callable);
      assert.deepEqual(detail.request.selects.map(select => select.phase), result.phases);
      assert.deepEqual(detail.request.selects[2].binds.positions, result.childPositions);
      assert.deepEqual(JSON.parse(vscode.window.activeTextEditor.document.getText()), JSON.parse(JSON.stringify(detail)));
      return { ...result, nativeActivity: true };
    } finally { observer.disconnect(); }
  });
  checks.push('A Spring MVC Callable carried a typed N+1 finding across the request, worker and redispatch. A concurrent ordinary request stayed separate, and deferred and timeout captures remained partial.');
  return proof;
}

async function verifyHibernateAsyncFetch() {
  return withFetchFixture(async fixture => {
    const observer = new ObserverClient({ url: fixture.runtime.observerUrl, token: fixture.token });
    try {
      await exercise(fixture);
      return await untilObserved(() => observer.refresh(), snapshot => summarizePerformance(snapshot.performance),
        [fixture.secret, fixture.token, ...fixture.ownerIds]);
    } finally { observer.dispose(); }
  });
}

if (require.main === module) verifyHibernateAsyncFetch().then(result => console.log(JSON.stringify(result)), error => {
  console.error(error.stack);
  process.exitCode = 1;
});

module.exports = { runHibernateAsyncFetchChecks };
