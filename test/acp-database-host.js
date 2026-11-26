'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createReadStream } = require('node:fs');
const { execFileSync } = require('node:child_process');
const mysql = require('mysql2/promise');
const { MysqlService } = require('../src/db/mysql');
const { prepareDatabaseAgents, prepareDatabaseTasks, createDatabaseTaskReview } = require('../src/db/acp-database-tasks');
const { startLocalModel } = require('./helpers/local-sql-model-fixture');
const { fixtures, selectRoute, expected } = require('./local-sql-grounding-host');
const { fixtureConfig } = require('./local-sql-assistant-host');
const { jdbcReadback } = require('./java-source-analysis-host');

const profiles = executable => [{ label: 'Local OpenCode', executable, adapter: 'opencode-local' }];
const tasks = [
  { profile: 'Local OpenCode', input: 'Select only the department name rb_spring_department.name, and add one SUM measure over rb_grounding_assignment.points. Group by department name. Sort by department name ASC. Set limit to 20.' },
  { profile: 'Local OpenCode', input: 'Select exactly two columns, rb_spring_department.name then rb_grounding_branch.label. Add one COUNT measure for rb_spring_person.id. Sort by rb_grounding_branch.label ASC. Set limit to 20.' }
];

async function observePeer() {
  const executable = process.env.ROCKETBRAIN_TEST_OPENCODE_BIN;
  assert.ok(executable && path.isAbsolute(executable) && /^opencode(?:\.exe)?$/i.test(path.basename(executable)), 'Provide the pinned OpenCode executable.');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(executable)) hash.update(chunk);
  if (process.platform === 'win32') assert.equal(hash.digest('hex'), '520970e4fb362a1be91b52b79960aa5fb24031ceb33f4c47e38a751a6b8a24b9');
  const version = execFileSync(executable, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 10000, env: {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(Path|SystemRoot|ComSpec|windir|PATHEXT)$/i.test(key))), OPENCODE_DISABLE_AUTOUPDATE: '1'
  } }).trim();
  assert.equal(version, '1.19.6');
  return { executable, version };
}

async function observeDatabase(config, model, peer, adapter, connect) {
  const db = new MysqlService(config), direct = await mysql.createConnection(config);
  try {
    await fixtures(direct);
    await connect?.();
    const catalog = await db.metadata();
    const choices = selectRoute(catalog);
    const agents = await prepareDatabaseAgents(profiles(peer.executable), model);
    const inputs = { catalog, choices, tasks, agents };
    const batch = prepareDatabaseTasks(inputs);
    const preview = adapter ? await adapter.stage({ choices, tasks }) : batch.preview;
    assert.equal(preview.tasks.length, 2);
    for (const task of preview.tasks) {
      assert.equal(task.endpoint, model.endpoint);
      assert.match(task.sha256, /^[a-f0-9]{64}$/);
      assert.match(task.text, /rb_grounding_branch.*region_id.*branch_id/);
      for (const withheld of [config.password, 'fixture-private-sentinel', 'secret_label', 'North', 'South']) assert.ok(!task.text.includes(withheld));
    }
    const local = adapter ? null : createDatabaseTaskReview(batch);
    if (adapter) await assert.rejects(adapter.start(preview.id, { confirmed: false }), /Review the exact agent/);
    const review = await (adapter ? adapter.start(preview.id, { confirmed: true }) : local.start());
    assert.deepEqual(review.jobs.map(job => job.status), ['ready', 'ready'], JSON.stringify(review.jobs.map(job => ({ status: job.status, failure: job.failure }))));
    if (adapter) await assert.rejects(adapter.start(preview.id, { confirmed: true }), /Review the exact agent/);
    await db.openSession('default', { readOnly: true });
    const observed = [];
    for (const [index, job] of review.jobs.entries()) {
      const { fingerprint } = job.result;
      const approved = { reviewId: review.id, jobId: job.id, fingerprint, confirmed: true };
      assert.equal(job.result.stopReason, 'end_turn');
      assert.equal(job.result.denied, 0);
      assert.match(job.result.sql, /ON t1\.`region_id` = t2\.`region_id` AND t1\.`branch_id` = t2\.`branch_id`/);
      let plan;
      if (adapter) {
        await assert.rejects(adapter.inspect(approved), /no longer available/);
        assert.throws(() => adapter.accept({ ...approved, fingerprint: undefined }), /exact SQL fingerprint/);
        adapter.accept(approved);
        await assert.rejects(adapter.inspect({ ...approved, confirmed: false }), /Separately approve/);
        const editor = await adapter.openDraft(approved);
        assert.equal(editor.document.getText().trim(), job.result.sql);
        const rendered = await adapter.openEstimatedPlan(approved);
        plan = rendered.report;
        assert.equal(rendered.view.viewType, 'rocketbrain.databaseAcpPlan');
        rendered.view.dispose();
      } else {
        assert.throws(() => local.result(job.id, fingerprint, true), /no longer available/);
        local.accept(job.id, fingerprint);
        plan = await db.explainGroundedQuery(choices, local.result(job.id, fingerprint, true).plan, batch.scope.fingerprint);
      }
      assert.equal(Boolean(plan.measured), false);
      const manual = await db.query(job.result.sql), fixed = await db.query(expected[index]);
      assert.deepEqual(manual.rows, fixed.rows, job.result.sql);
      observed.push({ manualRows: manual.rows.length, planOperators: plan.nodes.length });
    }
    const first = review.jobs[0];
    const firstChoice = { reviewId: review.id, jobId: first.id, fingerprint: first.result.fingerprint, confirmed: true };
    await direct.query('ALTER TABLE rb_grounding_assignment DROP FOREIGN KEY rb_grounding_branch_fk');
    if (adapter) {
      await assert.rejects(adapter.inspect(firstChoice), /reviewed key|metadata changed/);
      adapter.reject(review.id, first.id, first.result.fingerprint);
      await assert.rejects(adapter.openDraft(firstChoice), /no longer available/);
    } else await assert.rejects(db.explainGroundedQuery(choices, local.result(first.id, first.result.fingerprint, true).plan,
      batch.scope.fingerprint), /reviewed key|metadata changed/);
    return { engine: catalog.dialect, serverVersion: catalog.serverVersion, openCodeVersion: peer.version, protocol: 'ACP v1 stdio',
      genuineLocalModel: true, approvedDatabaseTasks: 2, separatePlanApproval: true, privateScopeOnly: true, approvedForeignKeyEdges: 3,
      staleKeyRefused: true, automaticSelectExecution: false, plans: observed, nativeReview: Boolean(adapter), jdbc: await jdbcReadback() };
  } finally {
    try {
      await db.dispose();
      await direct.query('DROP TABLE IF EXISTS rb_grounding_assignment');
      await direct.query('DROP TABLE IF EXISTS rb_grounding_branch');
    } finally { await direct.end(); }
  }
}

async function runDatabaseAcpChecks(api, vscode, checks) {
  const config = await fixtureConfig(), peer = await observePeer(), model = await startLocalModel();
  const settings = vscode.workspace.getConfiguration('rocketbrain.localSqlAssistant');
  const acp = vscode.workspace.getConfiguration('rocketbrain.acp');
  const old = Object.fromEntries(['endpoint','model'].map(key => [key, settings.inspect(key)?.workspaceValue]));
  const previousProfiles = acp.inspect('databaseAgents')?.workspaceValue;
  let panel;
  try {
    for (const key of ['endpoint','model']) await settings.update(key, model[key], vscode.ConfigurationTarget.Workspace);
    await acp.update('databaseAgents', profiles(peer.executable), vscode.ConfigurationTarget.Workspace);
    const result = await observeDatabase(config, model, peer, api.acpReview.database, async () => {
      await api.connectMysql(config);
      panel = await vscode.commands.executeCommand('rocketbrain.acp.reviewDatabase');
      assert.equal(panel.viewType, 'rocketbrain.databaseAcpTasks');
    });
    checks.push('Two real OpenCode ACP v1 tasks used an owned loopback Qwen endpoint, then opened distinct reviewed SQL drafts and separately approved estimated server plans. Both readbacks matched fixed Spring SQL and the removed composite key prevented further inspection.');
    return result;
  } finally {
    try {
      panel?.dispose();
      await api.disconnectMysql();
      await acp.update('databaseAgents', previousProfiles, vscode.ConfigurationTarget.Workspace);
      for (const key of ['endpoint','model']) await settings.update(key, old[key], vscode.ConfigurationTarget.Workspace);
    } finally { await model.close(); }
  }
}

if (require.main === module) fixtureConfig().then(async config => {
  const peer = await observePeer(), model = await startLocalModel();
  try { console.log(JSON.stringify(await observeDatabase(config, model, peer))); }
  finally { await model.close(); }
}).catch(error => { console.error(error.stack); process.exitCode = 1; });

module.exports = { runDatabaseAcpChecks, observePeer };
