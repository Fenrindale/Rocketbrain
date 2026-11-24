'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

async function runJvmDiagnosticsChecks(api,_vscode,checks) {
  const config = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG,'utf8'));
  const pid = config.jvmPid ?? config.javaProcessId;
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  assert.equal(config.dbEngine,process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE);
  assert.match(config.baseUrl,/^http:\/\/127\.0\.0\.1:\d+$/);
  const service = api.jvmDiagnostics;
  assert.ok(service);
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'rb-spring-jvm-'));
  const threadPath = path.join(directory,'threads.json'), profilePath = path.join(directory,'spring.jfr');
  const expected = {people:2,departments:1,rolledBackNames:0};
  try {
    const visible = await service.list();
    assert.ok(visible.some(item => item.pid === pid));
    const target = await service.select(pid);
    const threadResult = await service.captureThreads(target,{output:threadPath});
    assert.ok(threadResult.snapshot.platformThreads > 0);
    assert.ok(threadResult.snapshot.threads.some(item => item.stack.length));
    assert.equal(threadResult.locks.jvmDeadlocks,0);
    assert.deepEqual((await service.inspectThreads(threadPath)).snapshot,threadResult.snapshot);
    let done = false, requests = 0;
    const deadline = Date.now() + 26000;
    const traffic = (async () => {
      while (!done && Date.now() < deadline) {
        const response = await fetch(config.baseUrl + '/probe/testing-state',{signal:AbortSignal.timeout(4000)});
        assert.equal(response.ok,true);
        assert.deepEqual(await response.json(),expected);
        requests++;
        await new Promise(resolve => setTimeout(resolve,100));
      }
    })();
    void traffic.catch(() => {});
    let record;
    try { record = await service.profile(target,{seconds:5,output:profilePath}); }
    finally { done = true; await traffic; }
    assert.ok(requests >= 5);
    assert.ok(record.summary.cpuSamples > 0 && record.summary.allocationSamples > 0);
    assert.ok(record.summary.cpuMethods.length > 0 && record.summary.allocationMethods.length > 0);
    assert.equal(record.summary.omittedEvents,0);
    assert.deepEqual(await service.inspectJfr(profilePath),record.summary);
    const heap = await service.histogram(target);
    assert.ok(heap.rows.length && heap.total.bytes > 0);
    checks.push('Native JVM diagnostics selected the owned Spring process, captured and reopened threads and its CPU/allocation flight recording, and read the live heap histogram. Spring JDBC readback stayed consistent during the capture.');
    return {
      platformThreads:threadResult.snapshot.platformThreads, virtualThreads:threadResult.snapshot.virtualThreads,
      deadlocks:threadResult.locks.jvmDeadlocks, cpuSamples:record.summary.cpuSamples,
      allocationSamples:record.summary.allocationSamples, omittedEvents:record.summary.omittedEvents,
      outputBytes:(await fs.stat(profilePath)).size, heapTypes:heap.rows.length,
      offlineReopened:true, requests, jdbc:expected
    };
  } finally {
    for (const file of [threadPath,profilePath]) {
      await fs.unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    await fs.rmdir(directory);
  }
}

module.exports = { runJvmDiagnosticsChecks };
