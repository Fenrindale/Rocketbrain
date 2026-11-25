'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { randomBytes } = require('node:crypto');
const { owned } = require('./schema-stored-diff-host');

const expectedJdbc = { people: 2, departments: 1, rolledBackNames: 0 };
const firstTotals = { equal: 1, changed: 1, sourceOnly: 1, targetOnly: 1 };
const bothTotals = { equal: 2, changed: 3, sourceOnly: 1, targetOnly: 1 };

async function verifyDatasetBatch(runtime, adapter) {
  assert.equal(new URL(runtime.baseUrl).hostname, '127.0.0.1');
  const { actor, config, version } = await owned(runtime.dbConfigPath);
  const fixture = randomBytes(5).toString('hex');
  const names = ['target_a', 'source_a', 'target_b', 'source_b'].map(name => `rb_batch_${fixture}_${name}`);
  const records = [
    [[1, 'same'], [2, 'previous'], [3, 'target']], [[1, 'same'], [2, 'modified'], [4, 'source']],
    [[8, 'same'], [9, 'old'], [10, null]], [[8, 'same'], [9, null], [10, 'new']]
  ];
  const saved = [];
  let batch;
  try {
    for (const [index, name] of names.entries()) {
      await actor.query(`CREATE TABLE ${name} (id BIGINT PRIMARY KEY, payload VARCHAR(40)) ENGINE=InnoDB`);
      const values = records[index];
      await actor.execute(`INSERT INTO ${name}(id,payload) VALUES ` + values.map(() => '(?,?)').join(','), values.flat());
    }
    await adapter.connect(config);
    for (const index of [0, 2]) {
      const options = { target: names[index], source: names[index + 1], name: `Pair ${index + 1}` };
      const { payload } = await adapter.inspect(options);
      saved.push(await adapter.save({ ...options, mapping: payload }));
    }
    batch = await adapter.batches.save('Fixture dataset batch', saved);
    assert.deepEqual(adapter.batches.list().find(item => item.id === batch.id), batch);
    const complete = await adapter.replay(batch.id);
    assert.equal(complete.state, 'completed');
    assert.equal(complete.remaining, 0);
    assert.equal(complete.completed, 2);
    assert.deepEqual(complete.totals, bothTotals);
    assert.deepEqual(complete.results.map(item => item.workflowId), saved);
    for (const entry of complete.results) {
      assert.ok(Number.isFinite(Date.parse(entry.snapshotStartedAt)));
      assert.equal(entry.state, 'completed');
      assert.equal(entry.omittedDifferences, 0);
      assert.equal(Object.hasOwn(entry, 'sample'), false);
    }

    const cancellation = { isCancellationRequested: false };
    const cancelled = await adapter.replay(batch.id, { cancellation, onProgress(event) {
      if (event.index === 2 && event.comparedKeys === 0) cancellation.isCancellationRequested = true;
    } });
    assert.equal(cancelled.state, 'cancelled');
    assert.equal(cancelled.completed, 1);
    assert.equal(cancelled.remaining, 1);
    assert.deepEqual(cancelled.totals, firstTotals);

    await actor.query(`ALTER TABLE ${names[3]} ADD COLUMN changed INT`);
    const partial = await adapter.replay(batch.id);
    assert.equal(partial.state, 'partial');
    assert.equal(partial.completed, 1);
    assert.equal(partial.remaining, 0);
    assert.equal(partial.results[1].state, 'failed');
    assert.match(partial.results[1].message, /different server, account or table definition/);
    assert.deepEqual(partial.totals, firstTotals);

    for (const [index, name] of names.entries()) {
      const [current] = await actor.query(`SELECT CAST(row_data.id AS CHAR) id,payload FROM ${name} AS row_data ORDER BY row_data.id`);
      assert.deepEqual(current.map(({ id, payload }) => [id, payload]), records[index].map(([id, value]) => [String(id), value]));
    }
    const response = await fetch(new URL('/probe/testing-state', runtime.baseUrl), { signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200);
    const jdbc = await response.json();
    assert.deepEqual(jdbc, expectedJdbc);
    return { engine: runtime.dbEngine, version, orderedWorkflows: 2, totals: complete.totals,
      completedBeforeCancellation: cancelled.completed, partialOnSchemaDrift: true, unchangedRows: true, jdbc };
  } finally {
    try {
      if (batch) await adapter.batches.remove(batch.id);
      for (const id of saved) await adapter.remove(id);
    } finally {
      try { await adapter.disconnect(); }
      finally {
        try { await actor.query(`DROP TABLE IF EXISTS ${names.join(', ')}`); }
        finally { await actor.end(); }
      }
    }
  }
}

async function runDatasetBatchChecks(api, vscode, checks) {
  const runtime = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const commands = await vscode.commands.getCommands(true);
  for (const command of ['create', 'replay', 'remove']) assert.ok(commands.includes(`rocketbrain.${command}DatasetBatch`));
  const details = await verifyDatasetBatch(runtime, {
    ...api.datasetWorkflows,
    connect: config => api.connectMysql(config),
    disconnect: () => api.disconnectMysql(),
    async replay(id, options) {
      const result = options ? await api.datasetWorkflows.batches.replay(id, options)
        : await vscode.commands.executeCommand('rocketbrain.replayDatasetBatch', id);
      const uri = vscode.Uri.parse(result.uri);
      assert.equal(uri.scheme, 'rocketbrain-dataset-workflow');
      const document = await vscode.workspace.openTextDocument(uri);
      assert.equal(document.isDirty, false);
      const displayed = JSON.parse(document.getText());
      assert.deepEqual(displayed.totals, result.totals);
      assert.equal(displayed.state, result.state);
      assert.ok(displayed.results.every(entry => !Object.hasOwn(entry, 'sample')));
      return result;
    }
  });
  checks.push('Saved database comparisons replayed in order with per-pair snapshots, totals, cancellation and a partial result from an actual schema change.');
  return { ...details, readOnlyNativeReport: true };
}

module.exports = { verifyDatasetBatch, runDatasetBatchChecks };
