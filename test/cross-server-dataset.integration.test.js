'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const test = require('node:test');
const { MysqlService } = require('../src/db/mysql');
const { createDatasetWorkflows } = require('../src/db/dataset-workflow');
const { createConnectionProfiles } = require('../src/db/connection-profiles');
const { withDatasetPeer, verifyCrossServerDataset } = require('./cross-server-dataset-host');

const fixture = process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG;

test('saved cross-server dataset comparison keeps independent snapshots and reviews target updates only',
  { skip: !fixture && 'Run an owned Spring server and MySQL/MariaDB fixtures.', timeout: 150000 }, async () => {
    const runtime = JSON.parse(await fs.readFile(fixture, 'utf8'));
    let db, current, table, workflows, persisted = '{}';
    const data = new Map();
    const state = {
      get(key, fallback) { return JSON.parse(persisted)[key] ?? fallback; },
      async update(key, value) { persisted = JSON.stringify({ ...JSON.parse(persisted), [key]: value }); }
    };
    const secrets = { get: key => data.get(key), store: (key, value) => data.set(key, value), delete: key => data.delete(key) };
    const profiles = createConnectionProfiles({ state, secrets, isTrusted: () => true, getActiveProfile: () => null,
      createService: config => new MysqlService(config) });
    const init = () => {
      workflows = createDatasetWorkflows(state, action => action({ db, guard: () => Boolean(db) }), () => profiles.datasetProfileSource);
    };
    const refresh = async () => { current = await db.previewTable(table, { sessionId: 'dataset-target' }); };
    try {
      const details = await withDatasetPeer(runtime, peer => verifyCrossServerDataset(runtime, peer, {
        profiles,
        async connect(config) { db = new MysqlService(config); init(); },
        restart() {
          const [record] = state.get('rocketbrain.database.datasetWorkflows.v1', []);
          assert.ok(record?.sourceScope && record?.sourceProfile?.revision === 1);
          assert.deepEqual(Object.keys(record.sourceProfile).sort(), ['id', 'revision']);
          assert.equal(data.size, 2);
          for (const credential of data.values()) assert.ok(credential && !persisted.includes(credential));
          init();
        },
        sourceProfiles: () => workflows.sourceProfiles(), sourceTableNames: profile => workflows.sourceTableNames(profile),
        list: () => workflows.list(), inspect: x => workflows.inspect(x), save: x => workflows.save(x),
        replay: (id, options) => workflows.replay(id, options), remove: id => workflows.remove(id),
        async openTarget(name) {
          table = name;
          await db.openSession('dataset-target', { readOnly: false });
          await db.setAutocommit(false, { sessionId: 'dataset-target' });
          await refresh();
        },
        async stage(report, rows) {
          const { changes, assertFresh } = await workflows.reconcile(report, current, rows, observed => assert.equal(db, observed));
          assertFresh();
          return db.reviewChangeSet({ ...changes, modelId: current.edit.modelId, sessionId: 'dataset-target' });
        },
        async apply(reviewId) {
          const result = await db.applyChangeSet({ reviewId, sessionId: 'dataset-target' });
          current = result.result;
        },
        async commit() { await db.commit({ sessionId: 'dataset-target' }); await refresh(); },
        async disconnect() { await db?.dispose(); db = undefined; }
      }));
      assert.equal(data.size, 0);
      console.log(JSON.stringify({ ...details, persistedWithoutSecrets: true, actualReviewPipeline: true }));
    } finally { await profiles.dispose(); }
  });
