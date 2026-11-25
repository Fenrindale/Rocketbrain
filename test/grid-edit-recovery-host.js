'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { randomBytes } = require('node:crypto');
const { owned } = require('./schema-stored-diff-host');
const { jdbcReadback } = require('./java-source-analysis-host');
const { MysqlService } = require('../src/db/mysql');
const { createGridReviewStore } = require('../src/db/table-edit-recovery');

const baseline = { people: 2, departments: 1, rolledBackNames: 0 };
const title = 'Saved exact row proposals';
const ids = ['9007199254740993', '9007199254740995', '9007199254740997'];
const original = [[ids[0], '1.01000000', '한글'], [ids[1], '2.02000000', 'before']];
const edits = model => ({
  updates: [{ rowId: model.rowIds[0], values: { cost: '15.12000000', label: '다시' } }],
  deletes: [model.rowIds[1]],
  inserts: [{ values: { id: ids[2], cost: null, label: 'new' } }]
});
const summary = { updates: 1, deletes: 1, inserts: 1 };
const quote = value => {
  assert.match(value, /^rb_review_[\da-f]{12}$/);
  return '`' + value + '`';
};

async function runtime() {
  const fixture = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  assert.deepEqual(await jdbcReadback(), baseline);
  return { ...fixture, ...await owned(fixture.dbConfigPath) };
}
async function createTable(actor, table) {
  const target = quote(table);
  await actor.query('CREATE TABLE ' + target + ' (id BIGINT UNSIGNED PRIMARY KEY, cost DECIMAL(32,8), label VARCHAR(40)) ENGINE=InnoDB');
  await actor.execute('INSERT INTO ' + target + ' VALUES (?,?,?),(?,?,?)', original.flat());
}
async function currentRows(actor, table) {
  const [values] = await actor.query('SELECT CAST(id AS CHAR) AS id,CAST(cost AS CHAR) AS cost,label FROM ' + quote(table) + ' ORDER BY id');
  return values.map(row => [row.id, row.cost, row.label]);
}
async function openGrid(api, vscode, name) {
  await vscode.commands.executeCommand('rocketbrain.openTable', name);
  const opened = api.results().at(-1);
  assert.equal(opened?.table, name);
  await api.tableAction(opened.id, { type: 'enableEdit' });
  const record = api.results().find(row => row.id === opened.id);
  assert.equal(record.readOnly, false, record.editError);
  return record;
}
const within = async (lookup, timeout = 9000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = lookup();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw Error('The packaged result grid did not acknowledge its draft.');
};

async function seedGridEditRecovery(api, vscode, receipt) {
  const live = await runtime(), table = 'rb_review_' + randomBytes(6).toString('hex');
  let succeeded = false;
  try {
    await createTable(live.actor, table);
    await api.connectMysql(live.config);
    const record = await openGrid(api, vscode, table);
    try {
      await api.tableAction(record.id, { type: 'reviewChanges', changes: edits(record.result.edit), draftRevision: 0 });
      const review = api.results().find(item => item.id === record.id).review;
      assert.deepEqual(review?.summary, summary);
      const saved = await api.gridReviewRecovery.save(record.id, review.reviewId, title);
      assert.equal(saved.operations, 3);
      await fs.writeFile(receipt, JSON.stringify({ table, id: saved.id, previousReview: review.reviewId, hostPid: process.pid,
        engine: live.dbEngine, statements: review.statements }), { flag: 'wx' });
      assert.deepEqual(await currentRows(live.actor, table), original);
      succeeded = true;
    } finally {
      await api.tableAction(record.id, { type: 'invalidateReview' });
      await api.closeConsoleSession(record.sessionId);
      await api.disconnectMysql();
    }
  } finally {
    if (!succeeded) await live.actor.query('DROP TABLE IF EXISTS ' + quote(table));
    await live.actor.end();
  }
}

async function runGridEditRecoveryChecks(api, vscode, checks, receipt) {
  const archived = JSON.parse(await fs.readFile(receipt, 'utf8'));
  const live = await runtime(), table = archived.table;
  assert.notEqual(archived.hostPid, process.pid);
  assert.equal(archived.engine, live.dbEngine);
  try {
    assert.deepEqual(api.sessions(), []);
    assert.equal(api.gridReviewRecovery.list().find(item => item.id === archived.id)?.title, title);
    const opened = await api.gridReviewRecovery.open(archived.id);
    assert.equal(opened.executedSql, false);
    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(opened.documentUri));
    const content = document.getText();
    for (const statement of archived.statements) {
      assert.ok(content.includes(statement.sql));
      assert.ok(content.includes(JSON.stringify(statement.parameters)));
    }
    assert.ok(!content.includes(archived.previousReview));
    await vscode.commands.executeCommand('type', { text: 'readonly probe' });
    assert.equal(document.getText(), content);
    assert.equal(document.isDirty, false);
    await api.connectMysql(live.config);
    const earlier = await openGrid(api, vscode, table);
    try {
      await live.actor.execute('UPDATE ' + quote(table) + ' SET label=? WHERE id=CAST(? AS UNSIGNED)', ['outside change', ids[0]]);
      await assert.rejects(api.gridReviewRecovery.stage(archived.id, earlier.id), /exact values changed/);
      assert.equal(api.results().find(item => item.id === earlier.id).bulkDraft, undefined);
    } finally { await api.closeConsoleSession(earlier.sessionId); }
    await live.actor.execute('UPDATE ' + quote(table) + ' SET label=? WHERE id=CAST(? AS UNSIGNED)', [original[0][2], ids[0]]);
    const record = await openGrid(api, vscode, table);
    try {
      const staged = await api.gridReviewRecovery.stage(archived.id, record.id);
      assert.equal(staged.appliedChanges, false);
      const stagedRecord = await within(() => {
        const item = api.results().find(row => row.id === record.id);
        return item?.hasDraft && item.bulkDraft && item;
      });
      assert.equal(stagedRecord.review, undefined);
      const { updates, inserts, deletes } = stagedRecord.bulkDraft, draftRevision = stagedRecord.draftRevision;
      await api.tableAction(record.id, { type: 'reviewChanges', changes: { updates, inserts, deletes }, draftRevision });
      const review = api.results().find(item => item.id === record.id).review;
      assert.notEqual(review.reviewId, archived.previousReview);
      assert.deepEqual(review.summary, summary);
      assert.deepEqual(review.statements, archived.statements);
      assert.deepEqual(await currentRows(live.actor, table), original);
      await api.tableAction(record.id, { type: 'applyChanges', reviewId: review.reviewId, draftRevision });
      assert.equal(api.results().find(item => item.id === record.id).editError, undefined);
      await api.tableAction(record.id, { type: 'rollbackChanges' });
      assert.deepEqual(await currentRows(live.actor, table), original);
    } finally { await api.closeConsoleSession(record.sessionId); }
    await api.gridReviewRecovery.remove(archived.id);
    await assert.rejects(api.gridReviewRecovery.open(archived.id), /unavailable/);
    checks.push('The installed grid restored an explicit edit review in a second process, revalidated the same server and exact original rows, and staged only local proposals.');
    checks.push('The old approval was absent. The fresh review reproduced each typed UPDATE, DELETE and INSERT and ran through the normal rollback path.');
    return { engine: live.dbEngine, version: live.version, separateHostPid: true, readonlyArchive: true, exactParameters: true,
      staleOriginalRefused: true, freshApprovalRequired: true, nativeDraftAcknowledged: true, reviewedCrudRollback: true,
      jdbc: await jdbcReadback() };
  } finally {
    try { await api.disconnectMysql(); }
    finally { try { await live.actor.query('DROP TABLE IF EXISTS ' + quote(table)); } finally { await live.actor.end(); } }
  }
}

async function verifyRecoveryBackend() {
  const live = await runtime(), table = 'rb_review_' + randomBytes(6).toString('hex'), state = new Map();
  const memento = { keys: () => [...state.keys()], get: key => state.get(key),
    update(key,value) { if (value === undefined) state.delete(key); else state.set(key,JSON.parse(JSON.stringify(value))); } };
  const first = new MysqlService(live.config), second = new MysqlService(live.config);
  try {
    await createTable(live.actor, table);
    await first.openSession('archive', { readOnly: false });
    const page = await first.previewTable(table, { sessionId: 'archive' });
    const review = first.reviewChangeSet({ sessionId: 'archive', modelId: page.edit.modelId, ...edits(page.edit) });
    const data = await first.captureChangeSetReview({ sessionId: 'archive', reviewId: review.reviewId });
    const saved = await createGridReviewStore(memento, () => true).save(title, data);
    await first.dispose();
    const archive = createGridReviewStore(memento, () => true).requireReview(saved.id).archive;
    assert.deepEqual(archive.operations.map(({ sql, parameters }) => ({ sql, parameters })), review.statements);
    await second.openSession('fresh', { readOnly: false });
    await second.setAutocommit(false, { sessionId: 'fresh' });
    const current = await second.previewTable(table, { sessionId: 'fresh' });
    await assert.rejects(second.rebindChangeSetReview({ sessionId: 'fresh', modelId: current.edit.modelId,
      saved: { ...archive, server: '0'.repeat(64) } }), /different physical server/);
    const altered = structuredClone(archive);
    altered.operations[0].values.label = 'does not match the saved preview';
    await assert.rejects(second.rebindChangeSetReview({ sessionId: 'fresh', modelId: current.edit.modelId, saved: altered }),
      /differ from the saved edit review/);
    const changes = await second.rebindChangeSetReview({ sessionId: 'fresh', modelId: current.edit.modelId, saved: archive });
    await assert.rejects(second.applyChangeSet({ sessionId: 'fresh', reviewId: review.reviewId }), /expired/);
    const prepared = second.reviewChangeSet({ sessionId: 'fresh', modelId: current.edit.modelId, ...changes });
    assert.deepEqual(prepared.statements, review.statements);
    assert.deepEqual(await currentRows(live.actor, table), original);
    await second.applyChangeSet({ sessionId: 'fresh', reviewId: prepared.reviewId });
    await second.rollback({ sessionId: 'fresh' });
    assert.deepEqual(await currentRows(live.actor, table), original);
    const later = await second.previewTable(table, { sessionId: 'fresh' });
    await live.actor.execute('UPDATE ' + quote(table) + ' SET label=? WHERE id=CAST(? AS UNSIGNED)', ['changed', ids[0]]);
    await assert.rejects(second.rebindChangeSetReview({ sessionId: 'fresh', modelId: later.edit.modelId, saved: archive }), /exact values changed/);
    return { engine: live.dbEngine, version: live.version, restoredWorkspaceReview: true, exactCrud: true,
      differentServerRefused: true, staleRowRefused: true, inconsistentSavedValuesRefused: true, originalTokenRefused: true,
      freshReviewRolledBack: true, jdbc: await jdbcReadback() };
  } finally {
    try { await Promise.all([first.dispose(), second.dispose()]); }
    finally { try { await live.actor.query('DROP TABLE IF EXISTS ' + quote(table)); } finally { await live.actor.end(); } }
  }
}

module.exports = { seedGridEditRecovery, runGridEditRecoveryChecks, verifyRecoveryBackend };
if (require.main === module) verifyRecoveryBackend().then(value => console.log(JSON.stringify(value)))
  .catch(error => { console.error(error.stack); process.exitCode = 1; });
