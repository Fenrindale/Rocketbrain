'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { randomBytes } = require('node:crypto');
const { owned } = require('./schema-stored-diff-host');

const springState = { people: 2, departments: 1, rolledBackNames: 0 };
const quote = value => '`' + value + '`';
const keys = Array.from({ length: 9 }, (_, index) => String(9007199254740993n + BigInt(index)));
const query = {
  page: 1, pageSize: 2,
  sort: [{ column: 'position', direction: 'desc' }],
  filters: [{ column: 'bucket', operator: 'eq', value: { kind: 'value', text: 'selected' } }]
};

const draft = ({ updates, inserts, deletes }) => ({ updates, inserts, deletes });
const wait = () => new Promise(resolve => setTimeout(resolve, 40));

async function verifyGridMultipagePaste(runtime, adapter) {
  assert.equal(new URL(runtime.baseUrl).hostname, '127.0.0.1');
  const { actor, config, version } = await owned(runtime.dbConfigPath);
  const table = 'rb_paste_pages_' + randomBytes(5).toString('hex'), target = quote(table);
  const position = [5, 1, 4, 2, 1, 2, 1, 3, 2];
  const observedIds = [keys[0], keys[2], keys[7], keys[3], keys[5], keys[8], keys[1], keys[4]];
  const baseline = new Map(keys.map((key, index) => [key, [`old${index}`, '0.00000000', null]]));
  const read = async () => new Map((await actor.query('SELECT CAST(id AS CHAR) id,label,CAST(amount AS CHAR) amount,note FROM ' + target))[0]
    .map(({ id, label, amount, note }) => [String(id), [label, amount, note]]));
  const spring = async () => {
    const response = await fetch(new URL('/probe/testing-state', runtime.baseUrl), { signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), springState);
  };
  try {
    await actor.query('CREATE TABLE ' + target + ' (id BIGINT UNSIGNED PRIMARY KEY,position INT NOT NULL,bucket VARCHAR(8) NOT NULL,' +
      'label VARCHAR(60) NOT NULL,amount DECIMAL(24,8) NOT NULL,note VARCHAR(60),CHECK (amount >= -1)) ENGINE=InnoDB');
    for (const [index, key] of keys.entries()) {
      await actor.execute('INSERT INTO ' + target + ' VALUES (?,?,?,?,0,NULL)',
        [key, position[index], index === 6 ? 'excluded' : 'selected', 'old' + index]);
    }
    await spring();
    await adapter.connect(config, table);
    const checkPage = () => {
      const current = adapter.record();
      assert.deepEqual(current.result.rows.map(row => String(row[0])), observedIds.slice(2, 4));
      assert.equal(current.result.browse.hasNext, true);
      assert.equal(current.result.browse.page, query.page);
      assert.equal(current.result.browse.pageSize, query.pageSize);
    };
    await adapter.action('browseTable', { query });
    await adapter.action('enableEdit');
    checkPage();
    const paste = (values, options) => adapter.action('prepareBulk', { operation: 'paste', text: values, delimiter: '\t',
      anchorRowId: adapter.record().result.edit.rowIds[1], anchorColumn: 'label', ...options });
    const base = draft(await paste('keep this note', { anchorColumn: 'note' }));
    assert.equal(base.updates.length, 1);
    const clipboard = '"literal ""quote"""\t9007199254740993.00000001\nsecond\t-0.00000001\nthird\t3.00000003\nfourth\t4.00000004';
    await assert.rejects(() => paste(clipboard, { localDraft: base }), /fit the currently loaded rows/);
    await assert.rejects(() => paste(clipboard + '\nextra\t1\nextra\t2', { localDraft: base, acrossPages: true }), /too few matching rows/);
    const staged = await paste(clipboard, { localDraft: base, acrossPages: true });
    assert.deepEqual(staged.range, { firstRow: 4, lastRow: 7, firstPage: 2, lastPage: 4, outsidePage: 3 });
    assert.equal(staged.updates.length, 4);
    assert.deepEqual(staged.updates[0].values.note, { kind: 'value', text: 'keep this note' });
    assert.equal(new Set(staged.updates.map(row => row.rowId)).size, 4);
    assert.equal(adapter.record().result.rows.length, 2);
    await assert.rejects(() => paste(clipboard, { localDraft: draft(staged), acrossPages: true }), /overlaps a staged cell/);
    assert.equal(adapter.record().hasDraft, true);
    assert.deepEqual(await read(), baseline);
    const review = await adapter.action('reviewChanges', { changes: draft(staged) });
    assert.equal(review.summary.updates, 4);
    assert.deepEqual(review.statements.map(statement => statement.parameters.at(-1)), observedIds.slice(3, 7));
    await adapter.action('applyChanges', { reviewId: review.reviewId });
    assert.deepEqual(await read(), baseline);
    await adapter.action('commitChanges');
    const expected = new Map(baseline);
    expected.set(observedIds[3], ['literal "quote"', '9007199254740993.00000001', 'keep this note']);
    expected.set(observedIds[4], ['second', '-0.00000001', null]);
    expected.set(observedIds[5], ['third', '3.00000003', null]);
    expected.set(observedIds[6], ['fourth', '4.00000004', null]);
    assert.deepEqual(await read(), expected);

    checkPage();
    const next = await paste('rolled back\nrolled back\nrolled back', { acrossPages: true });
    const rollbackReview = await adapter.action('reviewChanges', { changes: draft(next) });
    await adapter.action('applyChanges', { reviewId: rollbackReview.reviewId });
    await adapter.action('rollbackChanges');
    assert.deepEqual(await read(), expected);

    // The driver's shared MySQL errno table labels MariaDB's 4025 differently.
    // Verify the actual vendor diagnostic before comparing the sanitized UI error.
    const serverError = await actor.execute('UPDATE ' + target + ' SET amount=-2 WHERE id=CAST(? AS UNSIGNED)', [observedIds[5]])
      .then(() => undefined, error => error);
    assert.equal(serverError?.errno, runtime.dbEngine === 'mariadb' ? 4025 : 3819);
    assert.match(serverError.sqlMessage, /\bconstraint\b/i);
    const invalid = await paste('temporary\t1\ntemporary\t2\ninvalid\t-2', { acrossPages: true });
    const invalidReview = await adapter.action('reviewChanges', { changes: draft(invalid) });
    await assert.rejects(() => adapter.action('applyChanges', { reviewId: invalidReview.reviewId }),
      error => error.message.includes('(' + serverError.code + ')'));
    await adapter.action('rollbackChanges');
    assert.deepEqual(await read(), expected);

    const conflict = await paste('conflict\nconflict\nconflict', { acrossPages: true });
    const conflictReview = await adapter.action('reviewChanges', { changes: draft(conflict) });
    await actor.execute('UPDATE ' + target + ' SET note=? WHERE id=CAST(? AS UNSIGNED)', ['external write', observedIds[5]]);
    await assert.rejects(() => adapter.action('applyChanges', { reviewId: conflictReview.reviewId }), /row changed or was deleted/);
    expected.set(observedIds[5], ['third', '3.00000003', 'external write']);
    await adapter.action('rollbackChanges');
    assert.deepEqual(await read(), expected);
    await spring();
    return { engine: runtime.dbEngine, version, exactFilterAndSort: true, observedPages: 3, stagedRows: 4,
      exactBigintKeysAndDecimal: true, explicitRangeOptIn: true, existingDraftPreserved: true,
      overlappingDraftRefused: true, insufficientRowsRefused: true, singleReviewedTransaction: true,
      commitVerified: true, rollbackVerified: true, serverConstraintRollbackAtomic: true,
      externalRowConflictAtomic: true, jdbc: springState };
  } finally {
    try { await adapter.disconnect(); }
    finally {
      try { await actor.query('DROP TABLE IF EXISTS ' + target); }
      finally { await actor.end(); }
    }
  }
}

async function runGridMultipagePasteChecks(api, vscode, checks) {
  const runtime = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  let id, sessionId;
  const record = () => api.results().find(item => item.id === id);
  const result = await verifyGridMultipagePaste(runtime, {
    record,
    async connect(config, table) {
      await api.connectMysql(config);
      await vscode.commands.executeCommand('rocketbrain.openTable', table);
      const opened = api.results().at(-1);
      assert.equal(opened?.result?.edit?.table, table, opened?.error);
      ({ id, sessionId } = opened);
    },
    async action(type, options) {
      const before = record();
      const revision = before.draftRevision || 0;
      await api.tableAction(id, { type, modelId: before.result.edit.modelId, draftRevision: revision, ...options });
      const after = record();
      if (after.editError) throw Error(after.editError);
      if (type === 'reviewChanges') return after.review;
      if (type !== 'prepareBulk') return;
      const staged = after.bulkDraft;
      assert.ok(staged);
      const deadline = Date.now() + 10000;
      while ((record().draftRevision || 0) === revision && Date.now() < deadline) await wait();
      assert.equal(record().draftRevision, revision + 1, 'Native Webview must adopt the exact draft.');
      return staged;
    },
    async disconnect() {
      if (sessionId) await api.closeConsoleSession(sessionId);
      await vscode.commands.executeCommand('rocketbrain.useDemo');
    }
  });
  checks.push('The installed table editor captured a paste across three server pages with exact typed keys and preserved a disjoint local draft.');
  checks.push('Reviewed Apply remained isolated until Commit, Roll Back cleared the staged writes, and a competing update aborted the entire paste.');
  return { ...result, nativeDraftAdopted: true };
}

module.exports = { verifyGridMultipagePaste, runGridMultipagePasteChecks };
