'use strict';

const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const { MysqlService } = require('../src/db/mysql');
const { prepareSqlProposalBatch, createSqlProposalReview } = require('../src/db/sql-proposal-review');
const { startLocalModel } = require('./helpers/local-sql-model-fixture');
const { fixtureConfig } = require('./local-sql-assistant-host');
const { jdbcReadback } = require('./java-source-analysis-host');

const selections = [{ table: 'rb_spring_person', columns: ['id', 'display_name'] }];
const requests = ['List only display_name values from rb_spring_person in ascending alphabetical order.',
  'List only display_name values from rb_spring_person in descending alphabetical order.'];

async function verifySqlProposalReview(model, config) {
  const db = new MysqlService(config);
  try {
    const catalog = await db.metadata();
    const prepared = prepareSqlProposalBatch({ ...model, catalog, selections, requests });
    assert.ok(prepared.drafts.every(draft => !JSON.stringify(draft.payload).includes(config.password)));
    let activeTogether = false;
    const review = createSqlProposalReview(prepared, { onChange(state) {
      if (state.jobs.every(job => job.status === 'running')) activeTogether = true;
    } });
    const { id, jobs } = await review.start();
    assert.ok(activeTogether);
    assert.deepEqual(jobs.map(job => job.status), ['ready', 'ready']);
    assert.notEqual(jobs[0].result.fingerprint, jobs[1].result.fingerprint);
    const first = jobs[0], second = jobs[1];
    assert.throws(() => review.read(id, first.id, first.result.fingerprint, { reviewedOnly: true }), /no longer available/);
    assert.throws(() => review.accept(id, first.id, second.result.fingerprint), /current SQL proposal/);
    review.accept(id, first.id, first.result.fingerprint);
    review.reject(id, second.id, second.result.fingerprint);
    assert.deepEqual(review.snapshot().jobs.map(job => job.status), ['reviewed', 'rejected']);
    const accepted = review.read(id, first.id, first.result.fingerprint, { reviewedOnly: true });
    assert.equal(accepted.sql, first.result.sql);
    assert.throws(() => review.read(id, second.id, second.result.fingerprint), /no longer available/);
    await db.openSession('default', { readOnly: true });
    const expected = await db.query('SELECT display_name FROM rb_spring_person ORDER BY display_name ASC');
    const manual = await db.query(accepted.sql);
    assert.equal(manual.rows.length, 2);
    assert.deepEqual(manual.rows, expected.rows);
    review.invalidate();
    assert.ok(review.snapshot().jobs.every(job => job.status === 'stale' && !job.result));
    assert.throws(() => review.read(id, first.id, first.result.fingerprint), /no longer available/);
    return { engine: catalog.dialect, authenticLocalModel: true, independentRunningProposals: 2, differentSql: true,
      fingerprintApproval: true, siblingRejected: true, staleApprovalRevoked: true, noAutomaticSqlExecution: true,
      manualReadOnlyExecutionRows: manual.rows.length, jdbc: await jdbcReadback() };
  } finally { await db.dispose(); }
}

async function runSqlProposalReviewChecks(api, vscode, checks) {
  const config = await fixtureConfig();
  const model = await startLocalModel({ parallel: 2 });
  const settings = vscode.workspace.getConfiguration('rocketbrain.localSqlAssistant');
  const previous = Object.fromEntries(['endpoint', 'model'].map(key => [key, settings.inspect(key)?.workspaceValue]));
  const tabs = () => vscode.window.tabGroups.all.flatMap(group => group.tabs)
    .filter(tab => tab.input instanceof vscode.TabInputWebview && tab.label === 'SQL Proposal Review' &&
      tab.input.viewType.endsWith('rocketbrain.sqlProposalReview'));
  try {
    for (const key of ['endpoint', 'model']) await settings.update(key, model[key], vscode.ConfigurationTarget.Workspace);
    await api.connectMysql(config);
    const command = 'rocketbrain.localSqlAssistant.compareProposals';
    assert.ok((await vscode.commands.getCommands(true)).includes(command));
    const preview = api.sqlProposalReview.preview({ selections, requests });
    assert.deepEqual(preview.requests, requests);
    assert.equal(preview.endpoint, model.endpoint);
    assert.deepEqual(preview.schema.tables[0].columns.map(column => column.name), selections[0].columns);
    await vscode.commands.executeCommand(command);
    for (let attempt = 0; attempt < 25 && !tabs().length; attempt++) await delay(100);
    assert.equal(tabs().length, 1);
    const receipt = await verifySqlProposalReview(model, config);
    checks.push('The packaged proposal review opened its native VS Code tab. Real local inference produced two isolated SQL proposals, and the accepted fingerprint matched the Spring fixture readback.');
    return { ...receipt, nativePanel: true, installedScopePreview: true };
  } finally {
    try {
      if (tabs().length) await vscode.window.tabGroups.close(tabs());
      await api.disconnectMysql();
      for (const key of ['endpoint', 'model']) await settings.update(key, previous[key], vscode.ConfigurationTarget.Workspace);
    } finally { await model.close(); }
  }
}

if (require.main === module) fixtureConfig().then(async config => {
  const model = await startLocalModel({ parallel: 2 });
  try { console.log(JSON.stringify(await verifySqlProposalReview(model, config))); }
  finally { await model.close(); }
}).catch(error => { console.error(error.message); process.exitCode = 1; });

module.exports = { runSqlProposalReviewChecks, verifySqlProposalReview };
