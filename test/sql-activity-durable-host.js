'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const mysql = require('mysql2/promise');
const { owned } = require('./schema-stored-diff-host');

const read = async location => JSON.parse(await fs.readFile(location, 'utf8'));
const expectedSpring = { people: 2, departments: 1, rolledBackNames: 0 };
const approval = { allowImplicitCommit: true };

async function verifyDurableSqlActivity(runtime, descriptor, adapter) {
  const { actor, config, version } = await owned(runtime.dbConfigPath);
  const label = 'rb_audit_' + randomBytes(5).toString('hex'), newAccount = 'rb_trace_' + randomBytes(5).toString('hex');
  const password = 'dialog_' + randomBytes(25).toString('base64url') + "'\\;끝";
  const activity = adapter.activity, before = activity.snapshot();
  const spring = async () => {
    const endpoint = new URL('/probe/testing-state', runtime.baseUrl);
    assert.equal(endpoint.hostname, '127.0.0.1');
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), expectedSpring);
  };
  let writer;
  try {
    const folder = path.dirname(await fs.realpath(runtime.dbConfigPath));
    assert.equal(path.dirname(await fs.realpath(descriptor)), folder);
    const harness = await read(descriptor);
    assert.equal(harness.format, 'RocketbrainOwnedDatabaseAdminFixture');
    assert.equal(harness.sourceConfigPath, runtime.dbConfigPath);
    assert.equal(harness.owner, path.basename(folder));
    assert.equal(harness.engine, runtime.dbEngine);
    assert.ok(harness.admin.user.startsWith('rb_acl_writer_'));
    for (const key of ['host', 'port', 'database']) assert.equal(harness.admin[key], config[key]);
    writer = await mysql.createConnection(harness.admin);
    await spring();
    await activity.setEnabled(false);
    await adapter.connect(config);
    await adapter.catalog();
    assert.deepEqual(activity.snapshot().entries, []);
    await activity.setEnabled(true);
    await activity.setRetention('temporary');
    await adapter.catalog();
    const memory = activity.snapshot();
    assert.equal(memory.retention, 'temporary');
    assert.ok(memory.entries.some(row => row.category === 'metadata'));
    await activity.setRetention('workspace');
    if (adapter.openLog) assert.equal((await adapter.openLog()).retention, 'workspace');
    await adapter.createTable(label);
    assert.equal((await actor.query('SELECT COUNT(*) AS n FROM `' + label + '`'))[0][0].n, 0);
    await adapter.readSnapshot('rb_spring_person');
    await adapter.connect(harness.admin);
    const target = { kind: 'account', user: newAccount, host: '127.0.0.1' };
    await adapter.createAccount(target, password);
    const [accounts] = await writer.query('SELECT User,Host FROM mysql.user WHERE BINARY User=BINARY ? AND Host=?', [newAccount, target.host]);
    assert.deepEqual(accounts, [{ User: newAccount, Host: target.host }]);
    await activity.flush();
    const durable = activity.snapshot();
    assert.equal(durable.persistenceFailure, false);
    assert.ok(durable.dropped >= 400, 'Verify significant catalog churn did not evict reviewed DDL.');
    const required = [['schema', 'CREATE'], ['authorization', 'CREATE'], ['session', 'START'], ['driver', 'SELECT'], ['metadata', 'SELECT']];
    for (const [category, operation] of required) assert.ok(durable.entries.some(row => row.category === category && row.operation === operation &&
      row.status === 'succeeded' && Number.isFinite(row.durationMs)), 'Missing successful ' + category + ' ' + operation);
    assert.ok(new Set(durable.entries.map(row => row.connection)).size >= 2);
    assert.equal(new Set(durable.entries.map(row => row.id)).size, durable.entries.length);
    const encoded = JSON.stringify(durable.entries);
    for (const secret of [label, newAccount, password, 'rb_spring_person', config.user, config.password, config.database, config.host, harness.admin.user]) {
      assert.ok(!encoded.includes(secret), 'Audit excludes private SQL, identifiers and credentials.');
    }
    if (adapter.verifyRestart) await adapter.verifyRestart(durable.entries);
    await activity.clear();
    assert.deepEqual(activity.snapshot().entries, []);
    await activity.setEnabled(false);
    await adapter.catalog();
    assert.deepEqual(activity.snapshot().entries, []);
    await spring();
    return { engine: runtime.dbEngine, version, recorded: durable.entries.length, schemaDdl: true, authorizationDdl: true,
      internalDriverReads: true, writeHistorySurvivedCatalogChurn: true, sessionCommands: true, metadata: true, optInPersistent: true, credentialAndSqlRedaction: true,
      clearAndDisabledVerified: true, separateProcessReactivation: Boolean(adapter.verifyRestart), nativeHistoryView: Boolean(adapter.openLog),
      springIsolation: expectedSpring };
  } finally {
    try { await adapter.disconnect(); }
    finally {
      try {
        await activity.setEnabled(true);
        await activity.clear();
        await activity.setRetention(before.retention);
        await activity.setEnabled(before.enabled);
        activity.close?.();
      } finally {
        try {
          if (writer) {
            try { await writer.query('DROP USER IF EXISTS ?@?', [newAccount, '127.0.0.1']); }
            finally { await writer.end(); }
          }
        } finally {
          try { await actor.query('DROP TABLE IF EXISTS `' + label + '`'); }
          finally { await actor.end(); }
        }
      }
    }
  }
}

async function runDurableSqlActivityChecks(api, vscode, checks) {
  const runtime = await read(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG);
  const author = api.dbAuthoring, admin = api.dbAdmin;
  const result = await verifyDurableSqlActivity(runtime, process.env.ROCKETBRAIN_DBADMIN_TEST_CONFIG, {
    activity: api.activityLog, connect: config => api.connectMysql(config), disconnect: () => api.disconnectMysql(),
    catalog: () => api.databaseCatalog(), openLog: () => vscode.commands.executeCommand('rocketbrain.sql.activityLog'),
    async createTable(name) {
      const model = await vscode.commands.executeCommand('rocketbrain.schema.createTable');
      model.draft.name = name;
      const review = await author.reviewDesigner(model.modelId, model.draft);
      assert.equal(review.kind, 'create');
      const result = await author.applyDesigner(model.modelId, approval);
      assert.equal(result.state, 'applied');
    },
    readSnapshot: table => api.openTableSnapshot(table, { pageSize: 1 }),
    async createAccount(target, password) {
      const review = await admin.preparePrincipal(target);
      const result = await admin.applyPrincipal({ reviewId: review.reviewId, approved: true, password });
      assert.equal(result.state, 'verified');
    }
  });
  checks.push('Installed SQL Activity observed actual managed DDL, credential-bearing authorization, session and metadata/driver commands with fixed redacted entries.');
  checks.push('Enabled the workspace history separately, flushed, cleared, and checked disabled isolation and actual Spring readback.');
  return result;
}

module.exports = { verifyDurableSqlActivity, runDurableSqlActivityChecks };
