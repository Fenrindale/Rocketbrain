'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const test = require('node:test');
const { MysqlService } = require('../src/db/mysql');
const { createDatasetWorkflows } = require('../src/db/dataset-workflow');
const { createDatasetBatches } = require('../src/db/dataset-workflow-batches');
const { verifyDatasetBatch } = require('./dataset-workflow-batches-host');

function memento() {
  let saved = {};
  return {
    get(key, fallback) { return JSON.parse(JSON.stringify(saved[key] ?? fallback)); },
    async update(key, value) { saved = { ...saved, [key]: value }; }
  };
}

test('saved dataset batches serialize updates, preserve order on reload and validate membership', async () => {
  const storage = memento();
  const ids = [randomUUID(), randomUUID()];
  const workflows = { list: () => ids.map(id => ({ id })) };
  const batches = createDatasetBatches(storage, workflows);
  await assert.rejects(batches.save('Duplicate', [ids[0], ids[0]]), /distinct/);
  await assert.rejects(batches.save('Unknown', [ids[0], randomUUID()]), /current saved comparisons/);
  const [first, second] = await Promise.all([batches.save(' First ', ids), batches.save('Second', [...ids].reverse())]);
  assert.equal(first.name, 'First');
  const restored = createDatasetBatches(storage, workflows);
  assert.deepEqual(restored.list(), [first, second]);
  await restored.remove(first.id);
  assert.deepEqual(batches.list(), [second]);
});

test('a deleted comparison is unavailable and unexpected errors stay out of batch reports', async () => {
  const ids = [randomUUID(), randomUUID()];
  const workflows = { list: () => ids.map(id => ({ id, name: id })),
    async replay() { throw new Error('private-path-and-driver-payload'); } };
  const batches = createDatasetBatches(memento(), workflows);
  const batch = await batches.save('Mixed errors', ids);
  const removed = ids.pop();
  const report = await batches.replay(batch.id);
  assert.equal(report.state, 'failed');
  assert.equal(report.remaining, 0);
  assert.equal(report.results[0].state, 'failed');
  assert.deepEqual(report.results[1], { workflowId: removed, state: 'unavailable' });
  assert.doesNotMatch(JSON.stringify(report), /private-path-and-driver-payload/);
  const aborted = await batches.replay(batch.id, { cancellation: { isCancellationRequested: true } });
  assert.equal(aborted.state, 'cancelled');
  assert.equal(aborted.remaining, 2);
  assert.deepEqual(aborted.results, []);
});

const fixture = process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG;
test('dataset batch replays reads in order against the live Spring fixture',
  { skip: !fixture && 'Run an owned Spring server with a MySQL or MariaDB fixture.', timeout: 90000 }, async () => {
    const runtime = JSON.parse(await fs.readFile(fixture, 'utf8'));
    let db;
    const storage = memento();
    const workflows = createDatasetWorkflows(storage, action => action({ db, guard: () => Boolean(db) }));
    const batches = createDatasetBatches(storage, workflows);
    const details = await verifyDatasetBatch(runtime, {
      ...workflows, batches, replay: batches.replay,
      async connect(config) { db = new MysqlService(config); },
      async disconnect() { await db?.dispose(); db = undefined; }
    });
    assert.deepEqual(batches.list(), []);
    assert.deepEqual(workflows.list(), []);
    console.log(JSON.stringify(details));
  });
