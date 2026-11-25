'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const test = require('node:test');
const { MysqlService } = require('../src/db/mysql');
const { TableEditor } = require('../src/table-editor');
const { registerDatasetWorkflows } = require('../src/db/dataset-workflow-vscode');
const { verifySavedDatasetWorkflow } = require('./dataset-workflow-host');

const fixture = process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG;

test('saved dataset workflows compare real ordered snapshots and stage reviewed destination rows',
  { skip: !fixture && 'Run an owned Spring/MySQL or MariaDB fixture.', timeout: 90000 }, async () => {
    const runtime = JSON.parse(await fs.readFile(fixture, 'utf8'));
    let db, editor, id, workflows, persisted = '{}', provider, document;
    const commands = new Map(), results = {
      history: [],
      begin(sql, label, data) { this.history.push({ id: 1, sql, label, ...data }); return 1; },
      finish(id, result, error) { this.editState(id, { result, error, state: error ? 'error' : 'done' }); },
      editState(id, patch) { Object.assign(this.history.find(item => item.id === id), patch); }
    };
    const latest = () => results.history.find(item => item.id === id);
    const init = () => {
      const workspaceState = {
        get(key, fallback) { return JSON.parse(persisted)[key] ?? fallback; },
        async update(key, value) { persisted = JSON.stringify({ ...JSON.parse(persisted), [key]: value }); }
      };
      const vscode = {
        ProgressLocation: { Notification: 15 },
        Uri: { from: ({ scheme, path }) => ({ scheme, path, toString: () => scheme + ':' + path }) },
        workspace: { isTrusted: true, registerTextDocumentContentProvider(scheme, value) { provider = value; return { dispose() {} }; },
          async openTextDocument(uri) { return { uri, getText: () => provider.provideTextDocumentContent(uri) }; } },
        window: { async showTextDocument(value) { document = value; },
          withProgress: (_options, execute) => execute({ report() {} }, { isCancellationRequested: false }) }
      };
      workflows = registerDatasetWorkflows({ workspaceState, subscriptions: [] }, vscode, (name, action) => commands.set(name, action), {
        withConnection: async action => action({ db, guard: () => Boolean(db) }),
        async stage(recordId, reconcile) {
          const current = latest(), snapshot = current.result;
          const { changes, assertFresh } = await reconcile(snapshot, observed => {
            assert.equal(db, observed); assert.equal(latest().result, snapshot);
          });
          await editor.stageDatasetChanges(recordId, { changes, assertFresh, modelId: snapshot.edit.modelId, draftRevision: current.draftRevision || 0 });
        }
      });
    };
    async function action(type, payload = {}) {
      const current = latest();
      await editor.handle(id, { type, modelId: current.result.edit.modelId, draftRevision: current.draftRevision || 0, ...payload });
      if (latest().editError) throw Error(latest().editError);
      return latest();
    }
    const details = await verifySavedDatasetWorkflow(runtime, {
      async connect(config) { db = new MysqlService(config); init(); },
      restart: init, list: () => workflows.list(), inspect: input => workflows.inspect(input), save: input => workflows.save(input),
      replay: (id, options) => workflows.replay(id, options), remove: id => workflows.remove(id),
      replayVisible: id => commands.get('rocketbrain.replayDatasetWorkflow')(id),
      async assertReport(report) {
        assert.equal(document.uri.scheme, 'rocketbrain-dataset-workflow');
        assert.deepEqual(JSON.parse(document.getText()).summary, report.summary);
      },
      async openTarget(table) {
        await db.openSession('replay-grid', { readOnly: true });
        editor = new TableEditor({ results, connection: () => ({ db, mysql: true, epoch: 1 }), trusted: () => true,
          withSession: (_sessionId, execute) => execute() });
        id = await editor.open({ table, sql: 'Table preview', sessionId: 'replay-grid' });
        await action('enableEdit');
      },
      async stage(reportId, indices) {
        await workflows.stage(reportId, id, indices);
        const { updates, deletes, inserts } = latest().bulkDraft;
        await action('draftChanged', { count: updates.length, draftRevision: (latest().draftRevision || 0) + 1 });
        return (await action('reviewChanges', { changes: { updates, deletes, inserts } })).review;
      },
      apply: reviewId => action('applyChanges', { reviewId }), commit: () => action('commitChanges'), rollback: () => action('rollbackChanges'),
      async closeTarget() { editor.forget(id); await db.closeSession('replay-grid'); },
      async disconnect() { editor?.dispose(); await db?.dispose(); }
    });
    assert.equal(commands.size, 4);
    console.log(JSON.stringify({ ...details, serializedWorkspaceReload: true, actualReviewPipeline: true }));
  });
