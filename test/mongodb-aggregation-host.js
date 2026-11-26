'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: pause } = require('node:timers/promises');
const { openMongoDb } = require('../src/db/mongodb');
const { startMongoFixture } = require('./mongodb-fixture');

async function verifyMongoAggregation(platform, bin, vscode) {
  const fixture = await startMongoFixture(bin), { config, sample } = fixture;
  let active;
  try {
    active = await platform.open(config);
    const catalog = await active.collections(sample.database);
    assert.ok(catalog.collections.some(item => item.name === sample.collection && item.kind === 'collection'));
    const target = await active.inspectAggregation({ database: sample.database, collection: sample.collection });
    assert.match(target.collectionId, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
    const source = (pipeline, extras) => JSON.stringify({ ...target, pipeline, ...extras });
    const stages = [{ $match: { rank: { $gte: { $numberInt: '1' } } } },
      { $group: { _id: '$active', itemCount: { $sum: 1 }, total: { $sum: '$price' }, latestSerial: { $max: '$serial' } } },
      { $sort: { itemCount: -1 } }, { $project: { current: '$_id', itemCount: 1, total: 1, latestSerial: 1, _id: 0 } }];
    const typed = await active.aggregate(source(stages));
    assert.equal(typed.kind, 'aggregation');
    assert.equal(typed.collectionId, target.collectionId);
    assert.deepEqual(typed.stages, ['$match', '$group', '$sort', '$project']);
    assert.equal(typed.truncated, null);
    assert.deepEqual(typed.documents[0], { current: true, itemCount: { $numberInt: '2' },
      total: { $numberDecimal: '20.50' }, latestSerial: { $numberLong: sample.serial } });
    assert.equal(typed.documents[1].current, false);
    assert.deepEqual((await active.aggregate(source([{ $match: { _id: { $oid: sample.id } } },
      { $project: { start: '$created', binary: '$nested.raw', _id: 0 } }]))).documents, [{
      start: { $date: { $numberLong: String(Date.parse(sample.stamp)) } },
      binary: { $binary: { base64: 'AH//', subType: '00' } }
    }]);
    assert.deepEqual((await active.aggregate(source([{ $limit: 2 }, { $count: 'total' }]))).documents, [{ total: { $numberInt: '2' } }]);
    assert.equal((await active.aggregate(source([{ $match: {} }], { limit: 1 }))).truncated, 'row-limit');
    for (const [collection, truncated] of [['wide', 'document-size'], ['budget', 'preview-size']]) {
      const selected = await active.inspectAggregation({ database: sample.database, collection });
      const result = await active.aggregate(JSON.stringify({ ...selected, pipeline: [{ $match: {} }] }));
      assert.equal(result.truncated, truncated);
    }

    const abort = new AbortController();
    const pending = active.aggregate(source([{ $match: {} }]), { signal: abort.signal });
    abort.abort();
    await assert.rejects(pending, { code: 'ROCKETBRAIN_MONGO_CANCELLED' });
    await assert.rejects(active.inspectAggregation({ database: sample.hidden, collection: 'secret' }), { code: 'ROCKETBRAIN_MONGO_FORBIDDEN' });
    await assert.rejects(active.inspectAggregation({ database: sample.database, collection: sample.view }), { code: 'ROCKETBRAIN_MONGO_AGGREGATE_SCOPE' });
    for (const forbidden of [{ $out: { db: sample.database, coll: 'escaped' } }, { $merge: { into: 'escaped' } },
      { $lookup: { from: 'wide', as: 'escaped', pipeline: [] } }, { $match: { $where: 'return true' } },
      { $project: { unsafe: { $function: { body: 'return 1', args: [], lang: 'js' } } } }]) {
      await assert.rejects(active.aggregate(source([forbidden])), { code: 'ROCKETBRAIN_MONGO_INPUT' });
    }
    const stale = await active.inspectAggregation({ database: sample.database, collection: 'stale_target' });
    await fixture.replaceAggregationTarget();
    await assert.rejects(active.aggregate(JSON.stringify({ ...stale, pipeline: [{ $match: {} }] })), { code: 'ROCKETBRAIN_MONGO_STALE' });
    assert.equal(await fixture.readerRejectsStaleAggregationIdentity(stale.collectionId), true);
    const fresh = await active.inspectAggregation({ database: sample.database, collection: 'stale_target' });
    assert.notEqual(fresh.collectionId, stale.collectionId);
    assert.equal(await fixture.readerWriteDenied(), true);
    assert.equal((await active.find(JSON.stringify({ database: sample.database, collection: sample.collection }))).documents.length, 3);

    let nativeEditor = false, savedPipeline = false;
    if (vscode) {
      const uri = await vscode.commands.executeCommand('rocketbrain.mongodb.newAggregation', target);
      const editor = vscode.window.activeTextEditor;
      assert.equal(editor.document.uri.toString(), uri);
      const content = source(stages);
      const range = new vscode.Range(editor.document.positionAt(0), editor.document.positionAt(editor.document.getText().length));
      assert.equal(await editor.edit(builder => builder.replace(range, content)), true);
      const deadline = Date.now() + 5000;
      while (editor.document.getText() !== content && Date.now() < deadline) await pause(50);
      assert.equal(editor.document.getText(), content);
      const preview = await vscode.commands.executeCommand('rocketbrain.mongodb.runAggregation');
      assert.ok(preview.preview.startsWith('rocketbrain-mongodb-result:'));
      const output = await vscode.workspace.openTextDocument(vscode.Uri.parse(preview.preview));
      assert.deepEqual(JSON.parse(output.getText()).documents, typed.documents);
      assert.equal(output.isDirty, false);
      nativeEditor = true;
      const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'rb-mongo-pipeline-'));
      const file = path.join(folder, 'totals.mongo-aggregate.json');
      const fileUri = vscode.Uri.file(file);
      try {
        await fs.writeFile(file, content, { flag: 'wx' });
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(fileUri));
        const saved = await vscode.commands.executeCommand('rocketbrain.mongodb.runAggregation');
        assert.deepEqual(saved.documents, typed.documents);
        savedPipeline = true;
      } finally {
        const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab =>
          tab.input?.uri?.toString() === fileUri.toString() && !tab.isDirty);
        if (tabs.length) await vscode.window.tabGroups.close(tabs, true);
        await fs.rm(folder, { recursive: true, maxRetries: 20, retryDelay: 100 });
      }
    }
    return { version: fixture.version, driver: '7.9.1', authorizedCollection: true, nativeEditor, savedPipeline,
      stages: ['$match', '$group', '$sort', '$project', '$limit', '$count'], exactExtendedJson: true,
      rowAndByteBounds: true, explicitCancellation: true, writesAndCrossCollectionStagesRejected: true,
      viewAndUnauthorizedDatabaseRejected: true, replacedCollectionRejected: true, serverUuidGuard: true, originalFindPreserved: true,
      vendorReadRoleDeniedWrites: true, cleaned: true };
  } finally {
    try { await active?.close(); }
    finally { await fixture.stop(); }
  }
}

async function runMongoAggregationChecks(api, vscode, checks) {
  const bin = process.env.ROCKETBRAIN_MONGODB_TEST_BIN;
  assert.ok(bin, 'Configure the owned MongoDB fixture executable.');
  const result = await verifyMongoAggregation({ open: async configuration => {
    await api.mongoDb.open(configuration);
    return api.mongoDb;
  } }, bin, vscode);
  checks.push('actual MongoDB read-only aggregation, exact Extended JSON, native editor and server-checked collection identity');
  return result;
}

if (require.main === module) {
  verifyMongoAggregation({ open: openMongoDb }, process.argv[2]).then(value => console.log(JSON.stringify(value)), error => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { runMongoAggregationChecks, verifyMongoAggregation };
