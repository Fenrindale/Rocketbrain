'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const mysql = require('mysql2/promise');
const { ObserverClient } = require('../src/jpa/observer-client');
const { VERSION } = require('../scripts/jpa-observer-build');
const { summarizePerformance } = require('../src/jpa/fetch-performance');
const { jdbcReadback } = require('./java-source-analysis-host');

const endpoint = name => '/probe/hibernate-fetch/' + name;
const comparable = value => process.platform === 'win32' ? value.toLowerCase() : value;
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));

async function withFetchFixture(run) {
  const runtime = await read(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG);
  const ownerFolder = path.dirname(await fs.realpath(runtime.dbConfigPath)), owner = await read(path.join(ownerFolder, 'owner.json'));
  const config = await read(runtime.dbConfigPath);
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1','RocketbrainDisposableOracleMysqlFixture-v1'].includes(owner.kind));
  assert.equal(path.basename(ownerFolder), owner.id);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.database, 'rocketbrain_fixture');
  assert.equal(runtime.dbEngine, process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE);
  assert.match(runtime.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(runtime.observerUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  const token = (await fs.readFile(runtime.observerTokenFile, 'utf8')).trim();
  const connection = await mysql.createConnection(config);
  const spring = await jdbcReadback();
  const ownerIds = [481725139, 481725140, 481725141];
  const itemRows = ownerIds.flatMap((id, index) => [[1+2*index,id],[2+2*index,id]]);
  let seeded = false;
  try {
    const [[{ datadir }]] = await connection.query('SELECT @@datadir AS datadir');
    assert.equal(comparable(path.dirname(await fs.realpath(datadir))), comparable(ownerFolder));
    await connection.beginTransaction();
    try {
      await connection.query('INSERT INTO rb_perf_owner (id) VALUES ?', [ownerIds.map(id => [id])]);
      await connection.query('INSERT INTO rb_perf_item (id,owner_id) VALUES ?', [itemRows]);
      await connection.commit();
      seeded = true;
    } catch (error) { await connection.rollback(); throw error; }
    const secret = randomBytes(12).toString('hex');
    const invoke = async () => {
      const count = await Promise.all(['lazy','join','manual'].map(async name => {
        const response = await fetch(runtime.baseUrl + endpoint(name) + '?fixture=' + secret,
          { signal: AbortSignal.timeout(12000), redirect: 'error' });
        assert.equal(response.status, 200, name);
        return response.json();
      }));
      for (const result of count) assert.deepEqual(result, { owners: 3, items: 6 });
      return count.length;
    };
    const result = await run({ runtime, token, invoke, secret, ownerIds });
    assert.deepEqual(await jdbcReadback(), spring);
    return { engine: runtime.dbEngine, spring, ...result };
  } finally {
    try {
      if (seeded) {
        await connection.query('DELETE FROM rb_perf_item WHERE id IN (?)', [itemRows.map(([id]) => id)]);
        await connection.query('DELETE FROM rb_perf_owner WHERE id IN (?)', [ownerIds]);
      }
    } finally { await connection.end(); }
  }
}

function checkPerformance(snapshot, report, secrets) {
  assert.equal(snapshot.agentVersion, VERSION);
  assert.equal(snapshot.performance.enabled, true);
  assert.equal(snapshot.performance.available, true, JSON.stringify(snapshot.warnings));
  assert.equal(snapshot.performance.rawBindValuesRetained, false);
  assert.equal(report.state, 'observed');
  const [lazy, joined, manual] = ['lazy','join','manual'].map(name => report.requests.find(request => request.route === endpoint(name)));
  assert.ok(lazy && joined && manual);
  assert.equal(new Set([lazy.id, joined.id, manual.id]).size, 3);
  for (const request of [lazy,joined,manual]) assert.equal(request.coverage, 'complete-within-supported-hooks');
  assert.deepEqual([lazy.selectCount, joined.selectCount, manual.selectCount],[4,1,4]);
  assert.deepEqual([lazy.suspects.length,joined.suspects.length,manual.suspects.length],[1,0,0]);
  const candidate = lazy.suspects[0];
  assert.equal(candidate.collectionRole, 'fixture.boot.PerformanceOwner.items');
  assert.equal(candidate.entity,'fixture.boot.PerformanceOwner');
  assert.equal(candidate.ownerTable,'rb_perf_owner');
  assert.equal(candidate.childTable,'rb_perf_item');
  assert.equal(candidate.keyColumn,'owner_id');
  assert.equal(candidate.parent.sequence, 1);
  assert.deepEqual(candidate.child.sequences,[2,3,4]);
  assert.equal(candidate.child.distinctOwnerKeys,3);
  assert.ok(candidate.parent.durationMicros >= 0 && candidate.child.totalDurationMicros >= 0);
  assert.match(candidate.child.sql,/owner_id\s*=\s*\?/i);
  const inspected = JSON.stringify({ performance: snapshot.performance, classified: report });
  for (const value of secrets) assert.ok(!inspected.includes(String(value)), 'A raw bind value or request parameter reached captured output.');
  assert.equal(snapshot.performance.observerExecutedSql,false);
  return { lazyRequest: lazy.id, count: [lazy.selectCount,joined.selectCount,manual.selectCount],
    findings: [lazy.suspects.length,joined.suspects.length,manual.suspects.length],
    distinctOwnerKeys: candidate.child.distinctOwnerKeys, role: candidate.collectionRole, rawValuesRetained: false };
}

async function runHibernateFetchPerformanceChecks(api, vscode, checks) {
  return withFetchFixture(async ({runtime,token,invoke,secret,ownerIds}) => {
    const observer = api.jpa.observer;
    try {
      const prepared = await vscode.commands.executeCommand('rocketbrain.jpa.observer.prepare');
      assert.equal(prepared.performanceCaptureEnabled, false);
      assert.equal((await read(prepared.configFile)).performance, false);
      await observer.connect({url:runtime.observerUrl,token});
      await invoke();
      const snapshot = await observer.refresh(), report = observer.performance();
      const verified = checkPerformance(snapshot, report, [secret,token,...ownerIds]);
      const detail = await vscode.commands.executeCommand('rocketbrain.jpa.observer.inspectPerformance', verified.lazyRequest);
      assert.equal(detail.request.id, verified.lazyRequest);
      assert.equal(detail.request.suspects[0].collectionRole, verified.role);
      assert.deepEqual(JSON.parse(vscode.window.activeTextEditor.document.getText()), JSON.parse(JSON.stringify(detail)));
      checks.push('Three identical-data Spring/Hibernate requests record four, one and four actual SELECTs. The observer flags the three distinct collection-key reads and does not classify unrelated explicit repeats.');
      checks.push('The native fetch activity view shows owner and child SQL templates, collection role and timing for one retained request without raw bind values or request parameters.');
      return { ...verified, nativeView: true, defaultCaptureDisabled: true };
    } finally { observer.disconnect(); }
  });
}

async function verifyHibernateFetchBackend() {
  return withFetchFixture(async ({runtime,token,invoke,secret,ownerIds}) => {
    const observer = new ObserverClient({url:runtime.observerUrl,token});
    try {
      await invoke();
      const snapshot = await observer.refresh();
      return { ...checkPerformance(snapshot,summarizePerformance(snapshot.performance),[secret,token,...ownerIds]), nativeView: false };
    } finally { observer.dispose(); }
  });
}

if (require.main === module) verifyHibernateFetchBackend().then(result => console.log(JSON.stringify(result)), error => {
  console.error(error.stack);
  process.exitCode=1;
});
module.exports={runHibernateFetchPerformanceChecks,verifyHibernateFetchBackend,withFetchFixture};
