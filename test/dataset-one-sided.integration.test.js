'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const test = require('node:test');
const { MysqlService } = require('../src/db/mysql');
const { createDatasetWorkflows } = require('../src/db/dataset-workflow');
const { createConnectionProfiles } = require('../src/db/connection-profiles');
const { withDatasetPeer } = require('./cross-server-dataset-host');
const { verifyDatasetOneSided } = require('./dataset-one-sided-host');

const fixture = process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG;

test('saved cross-server dataset membership stages exact rows and defends atomic review', {
  skip: !fixture && 'Run an owned Spring and MySQL/MariaDB fixture.',
  timeout: 150000
}, async () => {
  const runtime = JSON.parse(await fs.readFile(fixture, 'utf8'));
  const storage = new Map(), credentials = new Map(), sessionId = 'one-sided-dataset-target';
  const state = { get: (key, fallback) => storage.get(key) ?? fallback, update: async (key, value) => storage.set(key, structuredClone(value)) };
  const secrets = { get: key => credentials.get(key), store: (key, value) => credentials.set(key, value), delete: key => credentials.delete(key) };
  const profiles = createConnectionProfiles({ state, secrets, isTrusted: () => true, getActiveProfile: () => null,
    createService: config => new MysqlService(config) });
  let db, result, table;
  const workflows = createDatasetWorkflows(state, action => action({ db, guard: () => Boolean(db) }), () => profiles.datasetProfileSource);
  const load = async () => { result = await db.previewTable(table, { sessionId }); };
  const prepare = ({ exactDeletes, ...changes }) => {
    const modelId = result.edit.modelId;
    if (exactDeletes?.length) db.markDatasetDeletes({ sessionId, modelId, rowIds: exactDeletes });
    return db.reviewChangeSet({ modelId, sessionId, ...changes });
  };
  try {
    const details = await withDatasetPeer(runtime, peer => verifyDatasetOneSided(runtime, peer, {
      ...workflows, profiles,
      async connect(config) { db = new MysqlService(config); },
      async openTarget(name) {
        table = name;
        await db.openSession(sessionId, { readOnly: false });
        await db.setAutocommit(false, { sessionId });
        await load();
      },
      async stage(reportId, rows, options) {
        const staged = await workflows.reconcile(reportId, result, rows, target => assert.equal(db, target), options);
        staged.assertFresh();
        return prepare({ ...staged.changes, exactDeletes: staged.exactDeletes });
      },
      async recoverReview(reviewId) {
        const saved = await db.captureChangeSetReview({ sessionId, reviewId });
        assert.equal(saved.operations.find(item => item.type === 'delete').exactDatasetDelete, true);
        await db.rollback({ sessionId });
        await load();
        const changes = await db.rebindChangeSetReview({ sessionId, modelId: result.edit.modelId, saved });
        assert.deepEqual(changes.exactDeletes, changes.deletes);
        return prepare(changes);
      },
      async releaseReadSnapshot() {
        const session = db._session(sessionId);
        // Keep the private approval to simulate DDL just before Apply acquires its metadata lock.
        await db._control(session, 'ROLLBACK');
        await db._refreshState(session);
        assert.equal(session.inTransaction, false);
      },
      afterApplyGuard(action) {
        const editor = db._editor, verify = editor.verifyDatasetDeleteTarget;
        editor.verifyDatasetDeleteTarget = async function (table, session) {
          await verify.call(this, table, session);
          if (session?.inTransaction && !session.readOnly) {
            editor.verifyDatasetDeleteTarget = verify;
            await action();
          }
        };
      },
      async apply(reviewId) { result = (await db.applyChangeSet({ sessionId, reviewId })).result; },
      async rollback() { await db.rollback({ sessionId }); await load(); },
      async refresh() { await db.rollback({ sessionId }); await load(); },
      async commit() { await db.commit({ sessionId }); await load(); },
      async disconnect() { await db?.dispose(); db = undefined; }
    }));
    console.log(JSON.stringify(details));
  } finally { await profiles.dispose(); }
});
