'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { openAsyncTrace } = require('../../src/java/async-trace');

function futureTraceFixture() {
  const mainClass = 'dev.rocketbrain.futurefixture.FutureAsyncFixture';
  const source = fs.readFileSync(path.join(__dirname,
    '../fixtures/java/async-future/src/main/java', ...mainClass.split('.').slice(0, -1), 'FutureAsyncFixture.java'), 'utf8');
  return { mainClass, source, line: marker => source.split(/\r?\n/u).findIndex(line => line.endsWith(marker)) + 1 };
}

function checkFutureChain(fixture, report) {
  const [source, map, compose] = report.chain;
  assert.equal(report.chain.length, 3);
  assert.equal(report.taskId, compose.id);
  assert.deepEqual(report.chain.map(task => [task.label, task.handoff, task.parentKind]), [
    ['read-base', 'completable-future', undefined], ['add-adjustment', 'completable-future', 'stage'],
    ['query-orders', 'completable-future', 'stage']
  ]);
  assert.deepEqual([source.parentId, map.parentId, compose.parentId], [0, source.id, map.id]);
  assert.deepEqual(report.chain.map(task => task.state), ['completed', 'completed', 'entered']);
  assert.equal(source.worker.name, 'rb-future-read');
  assert.equal(compose.worker.name, 'rb-future-query');
  assert.notEqual(source.worker.id, compose.worker.id);
  assert.notEqual(map.submittedBy.id, source.worker.id);
  const originFrames = ['FUTURE_ORIGIN', 'FUTURE_ADJUST', 'FUTURE_QUERY'].map((marker, index) => {
    const origin = report.chain[index].submissionFrames.find(frame =>
      frame.type === fixture.mainClass && frame.line === fixture.line(marker));
    assert.ok(origin, JSON.stringify(report.chain[index].submissionFrames));
    return origin;
  });
  return { handoffs: report.chain.map(task => task.handoff), originFrames,
    completionStageLink: true, crossThreadRegistration: true, workerIdentityVerified: true };
}

async function verifyFutureCompletion(trace, output, engine) {
  const { tasks } = await openAsyncTrace(trace);
  assert.deepEqual(Object.fromEntries([...tasks.values()].map(task => [task.label, task.state])), {
    'read-base': 'completed', 'add-adjustment': 'completed', 'query-orders': 'completed',
    canceled: 'submitted', failed: 'failed', unreachable: 'submitted', rejected: 'rejected'
  });
  const jdbc = /FUTURE_JDBC:([^|\r\n]+)\|(\d+)\|(\d+)/u.exec(output);
  assert.ok(jdbc, 'The resumed CompletableFuture stage did not finish its actual Spring JDBC query.');
  assert.match(jdbc[1], engine === 'mysql' ? /^8\.4\.13$/u : /^11\.4\.8.*MariaDB/u);
  assert.deepEqual([jdbc[2], jdbc[3]], ['2', '42']);
  return { engine, server: jdbc[1], people: 2, answer: 42,
    failedStageBypassedCallback: true, rejectedExecutorRecorded: true, canceledBeforeSupplier: true };
}

module.exports = { futureTraceFixture, checkFutureChain, verifyFutureCompletion };
