'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { randomBytes, randomUUID } = require('node:crypto');
const { owned } = require('./schema-stored-diff-host');
const { withDatasetPeer } = require('./cross-server-dataset-host');
const { until } = require('./helpers/stdio-lsp');

const selection = { includeOneSided: true };
const jdbc = { people: 2, departments: 1, rolledBackNames: 0 };
const precise = '9007199254740993.12345678';
const idFor = index => String(18446744073709551000n + BigInt(index));

async function verifyDatasetOneSided(runtime, peer, adapter) {
  const destination = await owned(runtime.dbConfigPath);
  const suffix = randomBytes(5).toString('hex'), table = 'rb_membership_' + suffix, child = 'rb_member_child_' + suffix;
  const isMysql = runtime.dbEngine === 'mysql', sourceEngine = isMysql ? 'mariadb' : 'mysql';
  const url = new URL('/probe/testing-state', runtime.baseUrl);
  assert.equal(url.hostname, '127.0.0.1');
  const saved = [];
  let origin, profile;

  async function spring() {
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), jdbc);
  }
  const read = async (actor, id, label) => (await actor.query(
    `SELECT CAST(${id} AS CHAR) id,CAST(amount AS CHAR) amount,${label} label,HEX(payload) bytes FROM ${table} ORDER BY ${id}`))[0];
  const put = (actor, row) => actor.execute(`INSERT INTO ${table} VALUES (?,?,?,?,?)`, [3, row.id, row.amount, row.label, Buffer.from(row.bytes, 'hex')]);
  const targetRows = () => read(destination.actor, 'id', 'label');
  const row = (index, amount, label, bytes) => ({ id: idFor(index), amount, label, bytes });
  const src = row(2, precise, null, '00FF');
  const targetOnly = row(1, '2.00000000', 'target only', 'ABCD');
  const common = row(4, '4.00000000', 'common', 'CAFE');
  const current = row(0, '1.00000000', 'current', 'CAFE');
  const fromSource = row(0, '5.00000000', 'from source', 'ABCD');
  const conflict = row(2, '9.00000000', 'concurrent key', 'AA');
  const baseline = [current, targetOnly, common], expected = [fromSource, ...(isMysql ? [] : [targetOnly]), src, common];
  try {
    await spring();
    origin = await owned(peer.configPath);
    assert.notEqual(destination.config.port, origin.config.port);
    assert.equal(/mariadb/i.test(origin.version), isMysql);
    const label = 'VARCHAR(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin';
    await destination.actor.query(`CREATE TABLE ${table} (tenant INT NOT NULL,id BIGINT UNSIGNED NOT NULL,amount DECIMAL(32,8),
      label ${label},payload VARBINARY(4),PRIMARY KEY(tenant,id)) ENGINE=InnoDB`);
    await origin.actor.query(`CREATE TABLE ${table} (account INT NOT NULL,source_id BIGINT UNSIGNED NOT NULL,amount DECIMAL(32,8),
      incoming ${label},payload VARBINARY(4),PRIMARY KEY(account,source_id)) ENGINE=InnoDB`);
    for (const item of baseline) await put(destination.actor, item);
    for (const item of [fromSource, src, common]) await put(origin.actor, item);
    assert.deepEqual(await targetRows(), baseline);
    const sourceBefore = await read(origin.actor, 'source_id', 'incoming');
    assert.deepEqual(sourceBefore, [fromSource, src, common]);
    await adapter.connect(destination.config);
    const { host, port, database, user, password } = origin.config;
    profile = await adapter.profiles.save({ profile: { id: randomUUID(), name: 'Membership peer ' + suffix, host, port, database, user },
      password, rememberPassword: true });
    const fields = { target: table, source: table, sourceProfile: { id: profile.id, revision: profile.revision } };
    const amount = { target: 'amount', source: 'amount' };
    const partial = await adapter.save({ ...fields, name: 'Unmapped columns', mapping: [amount] });
    saved.push(partial);
    const incomplete = await adapter.replay(partial);
    assert.deepEqual(incomplete.oneSided, { insert: false, delete: false });
    assert.ok(incomplete.sample.every(item => item.operation === undefined));
    await adapter.openTarget(table);
    const missing = incomplete.sample.find(item => item.state === 'sourceOnly');
    await assert.rejects(() => adapter.stage(incomplete.id, [missing.index], selection), /complete destination column mapping/);

    const workflow = await adapter.save({ ...fields, name: 'One-sided exact rows',
      mapping: [amount, { target: 'label', source: 'incoming' }, { target: 'payload', source: 'payload' }] });
    saved.push(workflow);
    let report = await adapter.replay(workflow);
    assert.deepEqual(report.summary, { equal: 1, changed: 1, sourceOnly: 1, targetOnly: 1 });
    assert.equal(report.oneSided.insert, true);
    assert.equal(report.oneSided.delete, isMysql);
    if (!isMysql) assert.match(report.oneSided.deleteReason, /MySQL destination/);
    const insert = report.sample.find(item => item.operation === 'insert');
    const remove = report.sample.find(item => item.state === 'targetOnly');
    const update = report.sample.find(item => item.state === 'changed');
    assert.deepEqual(insert.values, { tenant: '3', id: idFor(2), amount: precise, label: null, payload: '0x00ff' });
    await adapter.assertReport?.(report);
    await assert.rejects(() => adapter.stage(report.id, [insert.index]), /changed rows/);
    if (!isMysql) await assert.rejects(() => adapter.stage(report.id, [remove.index], selection), /eligible rows/);
    const indices = [update.index, insert.index, ...(isMysql ? [remove.index] : [])];
    const review = () => adapter.stage(report.id, indices, selection);
    const expectReview = { inserts: 1, updates: 1, deletes: isMysql ? 1 : 0 };

    if (isMysql) {
      await destination.actor.query(`UPDATE ${table} SET label='moved after compare' WHERE id=${idFor(1)}`);
      await adapter.refresh();
      await assert.rejects(() => adapter.stage(report.id, [remove.index], selection), /changed or is outside/);
      await destination.actor.query(`UPDATE ${table} SET label='target only' WHERE id=${idFor(1)}`);
      await adapter.refresh();
    }

    const withCollision = await review();
    assert.deepEqual(withCollision.summary, expectReview);
    assert.match(withCollision.statements.at(-1).sql, /^INSERT INTO /);
    await put(destination.actor, conflict);
    await assert.rejects(() => adapter.apply(withCollision.reviewId), /conflicts with an existing unique or primary key/i);
    assert.deepEqual(await targetRows(), [current, targetOnly, conflict, common]);
    await adapter.rollback();
    await destination.actor.query(`DELETE FROM ${table} WHERE id=${idFor(2)}`);
    await adapter.refresh();

    let foreignKeyRefused = false, lateForeignKeyRefused = false, guardedReviewRecovery = false, pinnedForeignKeyRace = false;
    if (isMysql) {
      await destination.actor.query(`CREATE TABLE ${child} (tenant INT NOT NULL,id BIGINT UNSIGNED NOT NULL,PRIMARY KEY(tenant,id)) ENGINE=InnoDB`);
      const constraint = `ALTER TABLE ${child} ADD CONSTRAINT fk_membership FOREIGN KEY(tenant,id) REFERENCES ${table}(tenant,id) ON DELETE CASCADE`;
      await destination.actor.query('SET SESSION lock_wait_timeout=3');
      if (adapter.releaseReadSnapshot) {
        const original = await review();
        const beforeForeignKey = await adapter.recoverReview(original.reviewId);
        guardedReviewRecovery = true;
        await adapter.releaseReadSnapshot();
        await destination.actor.query(constraint);
        await assert.rejects(() => adapter.apply(beforeForeignKey.reviewId), /foreign key references the destination/);
        await adapter.rollback();
        await adapter.releaseReadSnapshot();
        lateForeignKeyRefused = true;
        await destination.actor.query(`ALTER TABLE ${child} DROP FOREIGN KEY fk_membership`);
        await adapter.refresh();
      } else {
        await adapter.closeTarget();
        await destination.actor.query(constraint);
        const inbound = await adapter.replay(workflow);
        assert.equal(inbound.oneSided.delete, false);
        assert.match(inbound.oneSided.deleteReason, /foreign key references the destination/);
        await adapter.openTarget(table);
        await assert.rejects(() => adapter.stage(inbound.id, [remove.index], selection), /eligible rows/);
        await adapter.closeTarget();
        await destination.actor.query(`ALTER TABLE ${child} DROP FOREIGN KEY fk_membership`);
        report = await adapter.replay(workflow);
        await adapter.openTarget(table);
      }
      assert.deepEqual(await targetRows(), baseline);
      foreignKeyRefused = true;
      adapter.afterApplyGuard?.(async () => {
        try {
          await destination.actor.query('SET SESSION foreign_key_checks=0');
          await destination.actor.query('SET SESSION lock_wait_timeout=1');
          await assert.rejects(destination.actor.query(constraint), { code: 'ER_LOCK_WAIT_TIMEOUT' });
          pinnedForeignKeyRace = true;
        } finally { await destination.actor.query('SET SESSION foreign_key_checks=1'); }
      });
    }
    const first = await review();
    await adapter.apply(first.reviewId);
    assert.deepEqual(await targetRows(), baseline);
    await adapter.rollback();
    assert.deepEqual(await targetRows(), baseline);
    if (adapter.afterApplyGuard && isMysql) assert.ok(pinnedForeignKeyRace);
    const second = await review();
    await adapter.apply(second.reviewId);
    await adapter.commit();
    assert.deepEqual(await targetRows(), expected);
    assert.deepEqual(await read(origin.actor, 'source_id', 'incoming'), sourceBefore);
    const aligned = await adapter.replay(workflow);
    assert.deepEqual(aligned.summary, { equal: 3, changed: 0, sourceOnly: 0, targetOnly: isMysql ? 0 : 1 });
    await spring();
    return { activeEngine: runtime.dbEngine, sourceEngine, activeVersion: destination.version, sourceVersion: origin.version,
      explicitOptIn: true, completeMappingEnforced: true, exactInsert: true, exactDelete: isMysql,
      deleteWithheld: !isMysql, atomicDuplicateConflict: true, originalRowDriftRejected: isMysql,
      foreignKeyRefused, lateForeignKeyRefused, guardedReviewRecovery, pinnedForeignKeyRace,
      manualCommitAndRollback: true, sourceUnchanged: true, jdbc };
  } finally {
    try {
      for (const id of saved) await adapter.remove(id);
      await adapter.disconnect();
      if (profile) await adapter.profiles.remove({ id: profile.id, expectedRevision: profile.revision });
    } finally {
      await Promise.all([
        (async () => { try { await destination.actor.query(`DROP TABLE IF EXISTS ${child},${table}`); } finally { await destination.actor.end(); } })(),
        origin && (async () => { try { await origin.actor.query(`DROP TABLE IF EXISTS ${table}`); } finally { await origin.actor.end(); } })()
      ]);
    }
  }
}

async function runDatasetOneSidedChecks(api, vscode, checks) {
  const runtime = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  let id, sessionId;
  const record = () => api.results().find(row => row.id === id);
  async function action(type, payload = {}) {
    const item = record();
    await api.tableAction(id, { type, modelId: item.result.edit.modelId, draftRevision: item.draftRevision || 0, ...payload });
    if (record().editError) throw Error(record().editError);
  }
  const closeTarget = async () => {
    if (sessionId) await api.closeConsoleSession(sessionId);
    sessionId = undefined;
  };
  const details = await withDatasetPeer(runtime, peer => verifyDatasetOneSided(runtime, peer, {
    ...api.datasetWorkflows, profiles: api.dbConnections, connect: config => api.connectMysql(config),
    replay: id => vscode.commands.executeCommand('rocketbrain.replayDatasetWorkflow', id),
    async assertReport(report) {
      const document = vscode.workspace.textDocuments.find(item => item.uri.toString() === report.uri);
      assert.equal(document?.uri.scheme, 'rocketbrain-dataset-workflow');
      assert.deepEqual(JSON.parse(document.getText()).oneSided, report.oneSided);
    },
    async openTarget(table) {
      await vscode.commands.executeCommand('rocketbrain.openTable', table);
      const current = api.results().at(-1);
      assert.equal(current.result?.edit?.table, table, current.error);
      ({ id, sessionId } = current);
      await action('enableEdit');
    },
    async stage(report, rows, options) {
      await api.datasetWorkflows.stage(report, id, rows, options);
      const staged = await until(() => record().hasDraft && record().bulkDraft, 10000);
      await action('reviewChanges', { changes: { updates: staged.updates, deletes: staged.deletes, inserts: staged.inserts } });
      return record().review;
    },
    apply: reviewId => action('applyChanges', { reviewId }), commit: () => action('commitChanges'),
    rollback: () => action('rollbackChanges'), refresh: () => action('rollbackChanges'),
    closeTarget,
    async disconnect() { await closeTarget(); await api.disconnectMysql(); }
  }));
  checks.push('A saved comparison staged exact cross-server inserts, and a duplicate key rolled back the mixed draft.');
  if (details.exactDelete) checks.push('A changed destination row and an inbound foreign key blocked MySQL deletion.');
  return { ...details, nativeReportAndReview: true };
}

module.exports = { verifyDatasetOneSided, runDatasetOneSidedChecks };
