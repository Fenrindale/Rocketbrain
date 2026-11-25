'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { randomBytes } = require('node:crypto');
const { owned } = require('./schema-stored-diff-host');
const { until } = require('./helpers/stdio-lsp');

const baseline = { people: 2, departments: 1, rolledBackNames: 0 };
const size = 1555, late = 1300, firstChanged = 10;
const key = index => [index < 800 ? -3 : 2, String(9007199254740993n + BigInt(index))];
const exact = '9007199254740993.00000001';

async function verifySavedDatasetWorkflow(runtime, adapter) {
  assert.equal(new URL(runtime.baseUrl).hostname, '127.0.0.1');
  const { actor, config, version } = await owned(runtime.dbConfigPath);
  const suffix = randomBytes(5).toString('hex'), target = 'rb_saved_target_' + suffix, source = 'rb_saved_source_' + suffix;
  const spring = async () => {
    const response = await fetch(new URL('/probe/testing-state', runtime.baseUrl), { signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200);
    const state = await response.json();
    assert.deepEqual(state, baseline);
    return state;
  };
  const readTarget = async () => (await actor.execute(`SELECT CAST(amount AS CHAR) amount, label FROM ${target} WHERE tenant=? AND id=CAST(? AS UNSIGNED)`, key(firstChanged)))[0][0];
  const mutateLate = () => actor.execute(`UPDATE ${source} SET amount=?,label=? WHERE account=? AND source_id=CAST(? AS UNSIGNED)`,
    ['0.00000001', 'new after snapshot', ...key(late)]);
  let workflow;
  try {
    await actor.query(`CREATE TABLE ${target} (id BIGINT UNSIGNED NOT NULL, tenant INT NOT NULL, amount DECIMAL(32,8), label VARCHAR(50), PRIMARY KEY(tenant,id)) ENGINE=InnoDB`);
    await actor.query(`CREATE TABLE ${source} (account INT NOT NULL, amount DECIMAL(32,8), source_id BIGINT UNSIGNED NOT NULL, label VARCHAR(50), PRIMARY KEY(account,source_id)) ENGINE=InnoDB`);
    for (const table of [target, source]) {
      const isTarget = table === target;
      const columns = isTarget ? '(tenant,id,amount,label)' : '(account,source_id,amount,label)';
      const records = Array.from({ length: size }, (_, index) => {
        if (isTarget ? index === 7 : index === 2) return null;
        const changed = !isTarget && index >= firstChanged && index <= 120;
        return [...key(index), changed ? exact : '1.00000000', changed && index % 2 === 0 ? null : 'original'];
      }).filter(Boolean);
      for (let index = 0; index < records.length; index += 75) {
        const batch = records.slice(index, index + 75);
        await actor.execute(`INSERT INTO ${table} ${columns} VALUES ` + batch.map(() => '(?,?,?,?)').join(','), batch.flat());
      }
    }
    await spring();
    await adapter.connect(config);
    const selection = { target, source, name: 'Accounts and precise amounts' };
    const offered = await adapter.inspect(selection);
    assert.deepEqual(offered.keys, [{ target: 'tenant', source: 'account' }, { target: 'id', source: 'source_id' }]);
    assert.deepEqual(offered.payload, [{ target: 'amount', source: 'amount' }, { target: 'label', source: 'label' }]);
    const mapping = offered.payload;
    await assert.rejects(() => adapter.save({ ...selection, mapping: [{ target: 'label', source: 'amount' }] }), /identical declared SQL types/);
    workflow = await adapter.save({ ...selection, mapping });
    await adapter.restart?.();
    const stored = adapter.list().find(item => item.id === workflow);
    assert.deepEqual(stored, { id: workflow, ...selection, mapping });

    let wrote = false;
    const initial = await adapter.replay(workflow, { async onProgress(examined) {
      if (examined === 256) { await mutateLate(); wrote = true; }
    } });
    assert.equal(wrote, true);
    assert.deepEqual(initial.summary, { equal: 1442, changed: 111, targetOnly: 1, sourceOnly: 1 });
    assert.equal(initial.sample.length, 100);
    assert.equal(initial.omitted, 13);
    assert.deepEqual(initial.sample.slice(0, 3).map(row => row.state), ['targetOnly', 'sourceOnly', 'changed']);
    assert.deepEqual(initial.sample[2].key, key(firstChanged).map(String));
    assert.deepEqual(initial.sample[2].changes, [{ target: 'amount', source: 'amount', previous: '1', value: exact },
      { target: 'label', source: 'label', previous: 'original', value: null }]);
    await adapter.assertReport?.(initial);

    const cancellation = { isCancellationRequested: false };
    await assert.rejects(() => adapter.replay(workflow, { cancellation, onProgress() { cancellation.isCancellationRequested = true; } }), /cancelled/);
    const replay = await (adapter.replayVisible ?? adapter.replay)(workflow);
    assert.deepEqual(replay.summary, { equal: 1441, changed: 112, targetOnly: 1, sourceOnly: 1 });
    assert.equal(replay.omitted, 14);
    await adapter.openTarget(target);
    await assert.rejects(() => adapter.stage(replay.id, [0]), /changed rows/);
    const baselineRow = { amount: '1.00000000', label: 'original' };
    const expectedRow = { amount: exact, label: null };
    const first = await adapter.stage(replay.id, [2]);
    assert.deepEqual(first.summary, { updates: 1, deletes: 0, inserts: 0 });
    assert.deepEqual(await readTarget(), baselineRow);
    await adapter.apply(first.reviewId);
    assert.deepEqual(await readTarget(), baselineRow);
    await adapter.rollback();
    assert.deepEqual(await readTarget(), baselineRow);
    const approved = await adapter.stage(replay.id, [2]);
    await adapter.apply(approved.reviewId);
    await adapter.commit();
    assert.deepEqual(await readTarget(), expectedRow);
    await assert.rejects(() => adapter.stage(replay.id, [2]), /changed or is outside/);
    await adapter.closeTarget();
    const aligned = await adapter.replay(workflow);
    assert.deepEqual(aligned.summary, { equal: 1442, changed: 111, targetOnly: 1, sourceOnly: 1 });
    await actor.query(`ALTER TABLE ${source} ADD COLUMN after_review INT`);
    await assert.rejects(() => adapter.replay(workflow), /different server, account or table definition/);
    await adapter.remove(workflow);
    assert.equal(adapter.list().some(item => item.id === workflow), false);
    workflow = undefined;
    return { engine: runtime.dbEngine, version, uniqueKeysScanned: size, sampleLimit: 100, exactTotals: true,
      sameTransactionSnapshot: true, savedMappingReplayed: true, typedCompositeKeys: true, exactDecimalAndNull: true,
      boundedReport: true, cancellationReleased: true, schemaDriftRejected: true, changedExistingRowsOnly: true,
      reviewedCommitAndRollback: true, staleDestinationRefused: true, jdbc: await spring() };
  } finally {
    try { if (workflow) await adapter.remove(workflow); }
    finally {
      try { await adapter.disconnect(); }
      finally {
        try { await actor.query(`DROP TABLE IF EXISTS ${source}, ${target}`); }
        finally { await actor.end(); }
      }
    }
  }
}

async function runDatasetWorkflowChecks(api, vscode, checks) {
  const runtime = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const commands = await vscode.commands.getCommands(true);
  for (const name of ['create', 'replay', 'stage', 'remove']) assert.ok(commands.includes(`rocketbrain.${name}DatasetWorkflow`));
  let id, sessionId;
  const record = () => api.results().find(item => item.id === id);
  async function action(type, payload = {}) {
    const item = record();
    await api.tableAction(id, { type, modelId: item.result.edit.modelId, draftRevision: item.draftRevision || 0, ...payload });
    assert.equal(record().editError, undefined, record().editError);
  }
  const closeTarget = async () => {
    if (sessionId) await api.closeConsoleSession(sessionId);
    sessionId = undefined;
  };
  const details = await verifySavedDatasetWorkflow(runtime, {
    ...api.datasetWorkflows,
    connect: config => api.connectMysql(config),
    replayVisible: workflow => vscode.commands.executeCommand('rocketbrain.replayDatasetWorkflow', workflow),
    async assertReport(report) {
      const document = vscode.workspace.textDocuments.find(item => item.uri.toString() === report.uri);
      assert.equal(document?.uri.scheme, 'rocketbrain-dataset-workflow');
      assert.deepEqual(JSON.parse(document.getText()).summary, report.summary);
    },
    async openTarget(name) {
      await vscode.commands.executeCommand('rocketbrain.openTable', name);
      const item = api.results().at(-1);
      assert.equal(item.result?.edit?.table, name, item.error);
      ({ id, sessionId } = item);
      await action('enableEdit');
    },
    async stage(reportId, rows) {
      await api.datasetWorkflows.stage(reportId, id, rows);
      const staged = await until(() => record().hasDraft && record().bulkDraft, 10000);
      await action('reviewChanges', { changes: { updates: staged.updates, deletes: staged.deletes, inserts: staged.inserts } });
      return record().review;
    },
    apply: reviewId => action('applyChanges', { reviewId }), commit: () => action('commitChanges'), rollback: () => action('rollbackChanges'),
    closeTarget,
    async disconnect() { await closeTarget(); await api.disconnectMysql(); }
  });
  checks.push('A saved comparison replayed 1,555 keys in one actual consistent snapshot with a bounded report and exact typed differences.');
  checks.push('A current native destination row staged from the report, with reviewed Commit and Roll Back, cancellation, schema drift and stale destination checks.');
  return { ...details, nativeSavedReport: true, nativeDraftAndReview: true };
}

module.exports = { verifySavedDatasetWorkflow, runDatasetWorkflowChecks };
