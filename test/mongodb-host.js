'use strict';

const assert = require('node:assert/strict');
const { startMongoFixture } = require('./mongodb-fixture');

async function verifyMongoDb(platform, bin, vscode) {
  const fixture = await startMongoFixture(bin);
  const { config, sample } = fixture;
  const query = extra => JSON.stringify({ database: sample.database, collection: sample.collection, ...extra });
  let active;
  try {
    await assert.rejects(() => platform.open({ ...config, password: config.password + 'x' }), error =>
      error.code === 'ROCKETBRAIN_MONGO_AUTH' && !error.message.includes(config.password));
    active = await platform.open(config);
    const { databases, truncated } = await active.databases();
    assert.deepEqual(databases.sort(), [sample.database, sample.extra].sort());
    assert.equal(truncated, false);
    assert.equal(active.source.host, '127.0.0.1');
    assert.equal(active.source.port, config.port);
    assert.equal(active.source.authSource, 'admin');
    assert.equal(Object.hasOwn(active.source, 'username'), false);
    assert.equal(Object.hasOwn(active.source, 'password'), false);
    const catalog = await active.collections(sample.database);
    assert.ok(catalog.collections.some(item => item.name === sample.collection && item.kind === 'collection'));
    assert.ok(catalog.collections.some(item => item.name === sample.view && item.kind === 'view'));
    await assert.rejects(() => active.collections(sample.hidden), error => error.code === 'ROCKETBRAIN_MONGO_FORBIDDEN');

    await assert.rejects(() => active.find(query({ database: sample.hidden, collection: 'secret' })),
      error => error.code === 'ROCKETBRAIN_MONGO_FORBIDDEN');
    const typed = await active.find(query({ filter: { _id: { $oid: sample.id }, serial: { $numberLong: sample.serial } }, limit: 1 }));
    assert.equal(typed.documents.length, 1);
    assert.equal(typed.truncated, null);
    assert.equal(typed.encoding, 'canonical-extended-json');
    const [document] = typed.documents;
    assert.deepEqual(document._id, { $oid: sample.id });
    assert.deepEqual(document.serial, { $numberLong: sample.serial });
    assert.deepEqual(document.price, { $numberDecimal: '20.50' });
    assert.deepEqual(document.rank, { $numberInt: '2' });
    assert.deepEqual(document.created, { $date: { $numberLong: String(Date.parse(sample.stamp)) } });
    assert.deepEqual(document.nested, { tags: ['blue', null], raw: { $binary: { base64: 'AH//', subType: '00' } } });
    assert.equal(document.text, '한국어 데이터');
    const limited = await active.find(query({ sort: { rank: 1 }, projection: { _id: 0, text: 1, rank: 1 }, limit: 2 }));
    assert.equal(limited.truncated, 'row-limit');
    assert.equal(limited.documents.length, 2);
    assert.deepEqual(limited.documents[0], { rank: { $numberInt: '1' }, text: null });
    assert.equal((await active.find(query({ collection: sample.view }))).documents.length, 2);
    assert.equal((await active.find(query({ collection: 'wide' }))).truncated, 'document-size');
    const budget = await active.find(query({ collection: 'budget' }));
    assert.equal(budget.truncated, 'preview-size');
    assert.equal(budget.documents.length, 5);
    const stopped = new AbortController();
    stopped.abort();
    await assert.rejects(() => active.find(query(), { signal: stopped.signal }), error => error.code === 'ROCKETBRAIN_MONGO_CANCELLED');
    const interrupted = new AbortController();
    const inFlight = active.find(query({ collection: 'budget' }), { signal: interrupted.signal });
    interrupted.abort();
    await assert.rejects(inFlight, error => error.code === 'ROCKETBRAIN_MONGO_CANCELLED');
    assert.equal((await active.find(query({ limit: 1 }))).documents.length, 1);
    assert.equal(await fixture.readerWriteDenied(), true);

    let nativeEditors = false;
    if (vscode) {
      const newFind = await vscode.commands.executeCommand('rocketbrain.mongodb.newFind',
        { database: sample.database, collection: sample.collection });
      assert.equal(vscode.window.activeTextEditor.document.uri.toString(), newFind);
      const result = await vscode.commands.executeCommand('rocketbrain.mongodb.run');
      assert.ok(result.preview.startsWith('rocketbrain-mongodb-result:'));
      const output = await vscode.workspace.openTextDocument(vscode.Uri.parse(result.preview));
      assert.equal(JSON.parse(output.getText()).documentCount, 3);
      assert.equal(JSON.parse(output.getText()).documents[0].serial.$numberLong, sample.serial);
      await vscode.commands.executeCommand('rocketbrain.mongodb.close');
      assert.equal(platform.source(), null);
      nativeEditors = true;
    }
    return { version: fixture.version, driver: '7.9.1', authenticatedLoopback: true, authorizedDatabases: databases.length,
      catalogViews: true, typedExtendedJson: true, rowAndByteBounds: true, explicitCancellation: true,
      vendorReadRoleDeniedWrites: true, nativeEditors };
  } finally {
    try { await active?.close(); }
    finally { await fixture.stop(); }
  }
}

async function runMongoDbChecks(api, vscode, checks) {
  const bin = process.env.ROCKETBRAIN_MONGODB_TEST_BIN;
  if (!bin) throw Error('Provide ROCKETBRAIN_MONGODB_TEST_BIN for the actual MongoDB extension test.');
  checks.mongoDb = await verifyMongoDb({ source: api.mongoDb.source, open: async config => {
    await api.mongoDb.open(config);
    return { ...api.mongoDb, source: api.mongoDb.source() };
  } }, bin, vscode);
}

if (require.main === module) {
  const { openMongoDb } = require('../src/db/mongodb');
  verifyMongoDb({ open: openMongoDb }, process.argv[2]).then(value => console.log(JSON.stringify(value)), error => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { runMongoDbChecks };
