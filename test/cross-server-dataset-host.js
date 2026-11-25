'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { randomBytes, randomUUID } = require('node:crypto');
const { owned } = require('./schema-stored-diff-host');
const { until } = require('./helpers/stdio-lsp');

const jdbc = { people: 2, departments: 1, rolledBackNames: 0 };
const rowCount = 625;
const key = index => [index < 300 ? -2 : 7, String(18446744073709550000n + BigInt(index))];
const precise = '9007199254740993.12345678';
const baseline = { amount: '1.00000000', label: 'original', bytes: 'CAFE' };
const adjusted = { amount: precise, label: null, bytes: '00FF' };

async function withDatasetPeer(runtime, fn) {
  const fixture = runtime.dbEngine === 'mysql' ? await require('../scripts/integration-db-fixture').startFixture() :
    await require('../scripts/integration-mysql').startMysqlFixture();
  try { return await fn(fixture); }
  finally { await fixture.stop(); }
}

async function verifyCrossServerDataset(runtime, peer, adapter) {
  const target = await owned(runtime.dbConfigPath);
  const suffix = randomBytes(5).toString('hex'), table = 'rb_cross_dataset_' + suffix;
  const user = 'rb_cmp_' + suffix, password = randomBytes(24).toString('base64url');
  const activeEngine = runtime.dbEngine, sourceEngine = activeEngine === 'mysql' ? 'mariadb' : 'mysql';
  const endpoint = new URL('/probe/testing-state', runtime.baseUrl);
  assert.equal(endpoint.hostname, '127.0.0.1');
  const bindings = [], saved = [];
  const read = async (actor, idColumn, tenantColumn) => (await actor.execute(
    `SELECT CAST(amount AS CHAR) amount, ${idColumn === 'id' ? 'label' : 'incoming'} label, HEX(payload) bytes FROM ${table}
     WHERE ${tenantColumn}=? AND ${idColumn}=CAST(? AS DECIMAL(20,0))`, key(0)))[0][0];
  async function profile(config, name, remembered = config.password) {
    const record = await adapter.profiles.save({ profile: { id: randomUUID(), name: name + ' ' + suffix,
      host: config.host, port: config.port, user: config.user, database: config.database },
    password: remembered, rememberPassword: true });
    bindings.push(record);
    return { id: record.id, revision: record.revision };
  }
  async function spring() {
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), jdbc);
  }
  let source, sourceAccountCreated = false;
  try {
    source = await owned(peer.configPath);
    assert.notEqual(target.config.port, source.config.port);
    assert.equal(/mariadb/i.test(target.version), activeEngine === 'mariadb');
    assert.equal(/mariadb/i.test(source.version), sourceEngine === 'mariadb');
    const flags = 'VARCHAR(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin';
    await target.actor.query(`CREATE TABLE ${table} (tenant INT NOT NULL,id BIGINT UNSIGNED NOT NULL,amount DECIMAL(32,8),
      label ${flags},payload VARBINARY(4), incompatible ${flags},required ${flags} NOT NULL DEFAULT '',
      PRIMARY KEY(tenant,id)) ENGINE=InnoDB`);
    await source.actor.query(`CREATE TABLE ${table} (account INT NOT NULL,source_id BIGINT UNSIGNED NOT NULL,amount DECIMAL(32,8),
      incoming ${flags},payload VARBINARY(4), incompatible VARCHAR(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
      PRIMARY KEY(account,source_id)) ENGINE=InnoDB`);
    await peer.withAdmin(async admin => {
      await admin.query('CREATE USER ?@? IDENTIFIED BY ?', [user, source.config.host, password]);
      sourceAccountCreated = true;
      await admin.query(`GRANT SELECT ON \`${source.config.database}\`.\`${table}\` TO ?@?`, [user, source.config.host]);
    });
    for (const [fixture, destination] of [[target, true], [source, false]]) {
      const rows = Array.from({ length: rowCount }, (_, i) => {
        if (i === (destination ? 10 : 11)) return null;
        const changed = !destination && i === 0;
        return [...key(i), changed ? precise : '1.00000000', changed ? null : 'original', Buffer.from(changed ? '00ff' : 'cafe', 'hex')];
      }).filter(Boolean);
      const columns = destination ? '(tenant,id,amount,label,payload)' : '(account,source_id,amount,incoming,payload)';
      for (let offset = 0; offset < rows.length; offset += 75) {
        const batch = rows.slice(offset, offset + 75);
        await fixture.actor.execute(`INSERT INTO ${table} ${columns} VALUES ` + batch.map(() => '(?,?,?,?,?)').join(','), batch.flat());
      }
    }
    await spring();
    await adapter.connect(target.config);
    const sourceProfile = await profile({ ...source.config, user }, 'Dataset SELECT source', password);
    const sameServer = await profile(target.config, 'Same physical server');
    assert.ok(adapter.sourceProfiles().some(row => row.id === sourceProfile.id));
    assert.deepEqual(await adapter.sourceTableNames(sourceProfile), [table]);
    const selection = { target: table, source: table, sourceProfile, name: 'Cross-server exact values' };
    await assert.rejects(() => adapter.inspect({ ...selection, sourceProfile: sameServer }), /different physical server/);
    const offered = await adapter.inspect(selection);
    assert.deepEqual(offered.keys, [{ target: 'tenant', source: 'account' }, { target: 'id', source: 'source_id' }]);
    assert.deepEqual(offered.matches.find(row => row.target === 'label'), { target: 'label', sources: ['incoming'] });
    assert.equal(offered.matches.some(row => row.target === 'required'), false);
    await assert.rejects(() => adapter.save({ ...selection, mapping: [{ target: 'incompatible', source: 'incompatible' }] }), /compatible integer/);
    const mapping = [{ target: 'amount', source: 'amount' }, { target: 'label', source: 'incoming' }, { target: 'payload', source: 'payload' }];
    const workflow = await adapter.save({ ...selection, mapping });
    saved.push(workflow);
    await adapter.restart?.();
    assert.deepEqual(adapter.list().find(row => row.id === workflow), { id: workflow, ...selection, mapping });
    const cancellation = { isCancellationRequested: false };
    await assert.rejects(() => adapter.replay(workflow, { cancellation, onProgress() { cancellation.isCancellationRequested = true; } }), /cancelled/);
    let changedBoth = false, pinnedDefinitions = false;
    const report = await adapter.replay(workflow, { async onProgress(checked) {
      if (checked !== 256) return;
      const [targetUpdate] = await target.actor.execute(`UPDATE ${table} SET amount=3 WHERE tenant=? AND id=CAST(? AS DECIMAL(20,0))`, key(601));
      const [sourceUpdate] = await source.actor.execute(`UPDATE ${table} SET amount=4 WHERE account=? AND source_id=CAST(? AS DECIMAL(20,0))`, key(602));
      assert.equal(targetUpdate.affectedRows, 1);
      assert.equal(sourceUpdate.affectedRows, 1);
      changedBoth = true;
      await Promise.all([target, source].map(async ({ actor }) => {
        await actor.query('SET SESSION lock_wait_timeout=1');
        await assert.rejects(actor.query(`ALTER TABLE ${table} ADD COLUMN concurrent_definition INT`), { code: 'ER_LOCK_WAIT_TIMEOUT' });
        await actor.query('SET SESSION lock_wait_timeout=3');
      }));
      pinnedDefinitions = true;
    } });
    assert.ok(changedBoth && pinnedDefinitions);
    assert.equal(report.snapshotScope, 'independent-servers');
    assert.equal(report.snapshots.destination.engine, activeEngine);
    assert.equal(report.snapshots.source.engine, sourceEngine);
    assert.equal(report.snapshots.source.profile, bindings[0].profile.name);
    assert.equal(report.snapshots.source.schema, source.config.database);
    const times = [report.snapshots.destination.startedAt, report.snapshots.source.startedAt, report.created].map(Date.parse);
    assert.ok(times.every(Number.isFinite) && times[0] <= times[1] && times[1] <= times[2]);
    assert.deepEqual(report.summary, { equal: 622, changed: 1, targetOnly: 1, sourceOnly: 1 });
    assert.deepEqual(report.sample[0].key, key(0).map(String));
    assert.deepEqual(report.sample[0].changes.map(({ value }) => value), [precise, null, '0x00ff']);
    await adapter.assertReport?.(report);
    const replay = await (adapter.replayVisible ?? adapter.replay)(workflow);
    assert.deepEqual(replay.summary, { equal: 620, changed: 3, targetOnly: 1, sourceOnly: 1 });
    await adapter.openTarget(table);
    const review = await adapter.stage(replay.id, [0]);
    assert.deepEqual(review.summary, { updates: 1, deletes: 0, inserts: 0 });
    await adapter.apply(review.reviewId);
    assert.deepEqual(await read(target.actor, 'id', 'tenant'), baseline);
    await adapter.commit();
    assert.deepEqual(await read(target.actor, 'id', 'tenant'), adjusted);
    assert.deepEqual(await read(source.actor, 'source_id', 'account'), adjusted);
    await assert.rejects(() => adapter.stage(replay.id, [0]), /changed or is outside/);
    const beforeProfileEdit = await adapter.replay(workflow);
    await source.actor.query(`ALTER TABLE ${table} ADD COLUMN definition_drift INT`);
    await assert.rejects(() => adapter.replay(workflow), /different server, account or table definition/);
    await source.actor.query(`ALTER TABLE ${table} DROP COLUMN definition_drift`);
    const before = await adapter.replay(workflow);
    assert.notEqual(before.id, beforeProfileEdit.id);
    const index = bindings.findIndex(row => row.id === sourceProfile.id);
    const previous = bindings[index];
    bindings[index] = await adapter.profiles.save({ profile: { ...previous.profile, name: previous.profile.name + ' updated' },
      expectedRevision: previous.revision, rememberPassword: true });
    await assert.rejects(() => adapter.stage(before.id, [0]), /source profile changed/);
    await assert.rejects(() => adapter.replay(workflow), /source profile changed/);
    await spring();
    return { activeEngine, sourceEngine, activeVersion: target.version, sourceVersion: source.version, physicalServers: 2,
      scannedKeys: rowCount, distinctSnapshotTimes: true, immutableCapturedRows: true, typedPrecisionAndBinary: true,
      exactPermissionsAndPhysicalScope: true, samePhysicalServerRefused: true, pinnedDefinitions: true, schemaDriftRefused: true,
      sourceProfileDriftRefused: true, cancelledAndReopened: true, targetOnlyReviewedCommit: true, jdbc };
  } finally {
    try {
      for (const id of saved) await adapter.remove(id);
      await adapter.disconnect();
      for (const record of bindings) await adapter.profiles.remove({ id: record.id, expectedRevision: record.revision });
    } finally {
      const release = async actor => {
        try { await actor.query(`DROP TABLE IF EXISTS ${table}`); }
        finally { await actor.end(); }
      };
      await Promise.all([release(target.actor), source && release(source.actor),
        sourceAccountCreated && peer.withAdmin(admin => admin.query('DROP USER IF EXISTS ?@?', [user, source.config.host]))]);
    }
  }
}

async function runCrossServerDatasetChecks(api, vscode, checks) {
  const runtime = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  let id, sessionId;
  const record = () => api.results().find(row => row.id === id);
  async function action(type, payload = {}) {
    const current = record();
    await api.tableAction(id, { type, modelId: current.result.edit.modelId, draftRevision: current.draftRevision || 0, ...payload });
    assert.equal(record().editError, undefined, record().editError);
  }
  const details = await withDatasetPeer(runtime, peer => verifyCrossServerDataset(runtime, peer, {
    ...api.datasetWorkflows, profiles: api.dbConnections,
    connect: config => api.connectMysql(config),
    replayVisible: id => vscode.commands.executeCommand('rocketbrain.replayDatasetWorkflow', id),
    async assertReport(report) {
      const document = vscode.workspace.textDocuments.find(item => item.uri.toString() === report.uri);
      assert.equal(document?.uri.scheme, 'rocketbrain-dataset-workflow');
      assert.deepEqual(JSON.parse(document.getText()).snapshots, report.snapshots);
    },
    async openTarget(table) {
      await vscode.commands.executeCommand('rocketbrain.openTable', table);
      const current = api.results().at(-1);
      assert.equal(current.result?.edit?.table, table, current.error);
      ({ id, sessionId } = current);
      await action('enableEdit');
    },
    async stage(reportId, rows) {
      await api.datasetWorkflows.stage(reportId, id, rows);
      const staged = await until(() => record().hasDraft && record().bulkDraft, 10000);
      await action('reviewChanges', { changes: { updates: staged.updates, deletes: staged.deletes, inserts: staged.inserts } });
      return record().review;
    },
    apply: reviewId => action('applyChanges', { reviewId }), commit: () => action('commitChanges'),
    async disconnect() { if (sessionId) await api.closeConsoleSession(sessionId); await api.disconnectMysql(); }
  }));
  checks.push('A saved SELECT-only profile compared independently pinned MySQL and MariaDB snapshots and reopened exact typed differences.');
  checks.push('Only reviewed updates to exact current destination rows were staged, with stale source profile and schema binding refusal.');
  return { ...details, nativeReportAndReviewedDraft: true };
}

module.exports = { withDatasetPeer, verifyCrossServerDataset, runCrossServerDatasetChecks };
