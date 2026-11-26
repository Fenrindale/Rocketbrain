'use strict';

const assert = require('node:assert/strict');
const { BSON } = require('mongodb');
const { openMongoDb } = require('../src/db/mongodb');
const { startMongoFixture } = require('./mongodb-fixture');

function json(value) { return JSON.stringify(value); }

async function verifyMongoEdit(platform, bin, vscode) {
  const fixture = await startMongoFixture(bin, { edits: true });
  const { sample, editFixture } = fixture, handles = [];
  const open = async config => {
    const handle = await platform.open(config);
    handles.push(handle);
    return handle;
  };
  const target = { database: sample.database, collection: sample.collection, objectId: sample.id };
  const query = json({ database: sample.database, collection: sample.collection, filter: { _id: { $oid: sample.id } }, limit: 1 });
  try {
    const readonly = await open(editFixture.config);
    await assert.rejects(readonly.inspectDocumentEdit(target), { code: 'ROCKETBRAIN_MONGO_EDIT' });
    const reader = await open({ ...fixture.config, reviewedEdits: true });
    let snapshot = await reader.inspectDocumentEdit(target);
    let edit = reader.prepareEdit(snapshot.id, 'text', json('read account cannot write'));
    await assert.rejects(reader.applyEdit(edit.id, true), { code: 'ROCKETBRAIN_MONGO_FORBIDDEN' });
    assert.equal((await reader.find(query)).documents[0].text, '한국어 데이터');
    const writer = await open({ ...editFixture.config, reviewedEdits: true });
    snapshot = await writer.inspectDocumentEdit(target);
    assert.ok(!snapshot.fields.some(item => item.name === '_id' || item.name === 'nested' || item.name === 'price'));
    assert.throws(() => writer.prepareEdit(snapshot.id, 'nested.tags', json('unsupported')), { code: 'ROCKETBRAIN_MONGO_EDIT' });
    assert.throws(() => writer.prepareEdit(snapshot.id, 'serial', sample.serial), { code: 'ROCKETBRAIN_MONGO_INPUT' });
    const next = '9223372036854775806';
    edit = writer.prepareEdit(snapshot.id, 'serial', json({ $numberLong: next }));
    assert.deepEqual([edit.before, edit.after], [{ $numberLong: sample.serial }, { $numberLong: next }]);
    assert.deepEqual([edit.beforeType, edit.afterType], ['long', 'long']);
    await assert.rejects(writer.applyEdit(edit.id, false), { code: 'ROCKETBRAIN_MONGO_EDIT' });
    assert.equal((await writer.find(query)).documents[0].serial.$numberLong, sample.serial);
    assert.deepEqual(await writer.applyEdit(edit.id, true), { acknowledged: true, objectId: sample.id,
      field: 'serial', value: { $numberLong: next }, type: 'long' });
    await assert.rejects(writer.applyEdit(edit.id, true), { code: 'ROCKETBRAIN_MONGO_EDIT' });
    let current = (await writer.find(query)).documents[0];
    assert.equal(current.serial.$numberLong, next);
    assert.equal(current.text, '한국어 데이터');

    snapshot = await writer.inspectDocumentEdit(target);
    edit = writer.prepareEdit(snapshot.id, 'rank', json({ $numberInt: '8' }));
    await editFixture.updateObservedField('rank', BSON.Long.fromNumber(2));
    await assert.rejects(writer.applyEdit(edit.id, true), { code: 'ROCKETBRAIN_MONGO_STALE' });
    assert.deepEqual((await writer.find(query)).documents[0].rank, { $numberLong: '2' });
    await editFixture.updateObservedField('rank', new BSON.Int32(2));

    snapshot = await writer.inspectDocumentEdit(target);
    edit = writer.prepareEdit(snapshot.id, 'text', json('refused'));
    await editFixture.updateObservedField('text', 'changed elsewhere');
    await assert.rejects(writer.applyEdit(edit.id, true), { code: 'ROCKETBRAIN_MONGO_STALE' });
    assert.equal((await writer.find(query)).documents[0].text, 'changed elsewhere');

    snapshot = await writer.inspectDocumentEdit(target);
    edit = writer.prepareEdit(snapshot.id, 'text', 'null');
    assert.deepEqual(await writer.applyEdit(edit.id, true), { acknowledged: true, objectId: sample.id, field: 'text', value: null, type: 'null' });
    snapshot = await writer.inspectDocumentEdit(target);
    edit = writer.prepareEdit(snapshot.id, 'text', json('after validator drift'));
    await editFixture.changeValidator();
    await assert.rejects(writer.applyEdit(edit.id, true), { code: 'ROCKETBRAIN_MONGO_STALE' });
    assert.equal((await writer.find(query)).documents[0].text, null);
    snapshot = await writer.inspectDocumentEdit(target);
    edit = writer.prepareEdit(snapshot.id, 'rank', json('violates validator'));
    await assert.rejects(writer.applyEdit(edit.id, true), { code: 'ROCKETBRAIN_MONGO_EDIT_REFUSED' });
    assert.deepEqual((await writer.find(query)).documents[0].rank, { $numberInt: '2' });

    const identityTarget = { ...target, collection: editFixture.collection };
    snapshot = await writer.inspectDocumentEdit(identityTarget);
    edit = writer.prepareEdit(snapshot.id, 'name', json('must-not-write'));
    await editFixture.replaceSameDocumentCollection();
    await assert.rejects(writer.applyEdit(edit.id, true), { code: 'ROCKETBRAIN_MONGO_STALE' });
    assert.equal(await editFixture.rejectOldCollectionUuid(snapshot.collectionId), true);
    const replaced = await writer.inspectDocumentEdit(identityTarget);
    assert.notEqual(replaced.collectionId, snapshot.collectionId);
    assert.equal(replaced.fields.find(item => item.name === 'name').value, 'original');
    const peers = await writer.find(json({ database: target.database, collection: target.collection,
      filter: { _id: { $ne: { $oid: sample.id } } }, sort: { rank: 1 } }));
    assert.deepEqual(peers.documents.map(item => item.rank), [{ $numberInt: '1' }, { $numberInt: '3' }]);

    let nativeEditor = false;
    if (vscode) {
      const uri = await vscode.commands.executeCommand('rocketbrain.mongodb.newFind', target);
      assert.equal(vscode.window.activeTextEditor.document.uri.toString(), uri);
      const shown = await vscode.commands.executeCommand('rocketbrain.mongodb.run');
      assert.equal(shown.documents.find(item => item._id.$oid === sample.id).serial.$numberLong, next);
      nativeEditor = true;
    }
    return { version: fixture.version, driver: '7.9.1', nativeEditor, separateOptIn: true, vendorReadRoleDenied: true, exactBsonInt64: true,
      exactTypedPreimage: true, nullPreserved: true, oneShot: true, staleValueRejected: true, schemaSettingsDriftRejected: true,
      serverValidatorEnforced: true, recreatedCollectionRejected: true, serverUuidGuard: true, peersPreserved: true, cleaned: true };
  } finally {
    try { for (const handle of handles.reverse()) await handle.close(); }
    finally { await fixture.stop(); }
  }
}

async function runMongoEditChecks(api, vscode, checks) {
  const bin = process.env.ROCKETBRAIN_MONGODB_TEST_BIN;
  assert.ok(bin, 'Configure the owned MongoDB fixture executable.');
  const result = await verifyMongoEdit({ open: async configuration => {
    await api.mongoDb.open(configuration);
    return api.mongoDb;
  } }, bin, vscode);
  checks.push('Actual MongoDB reviewed single-field edit with exact BSON preimage, collection identity and authoritative validation');
  return result;
}

if (require.main === module) {
  verifyMongoEdit({ open: openMongoDb }, process.argv[2]).then(result => console.log(JSON.stringify(result)), error => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { runMongoEditChecks, verifyMongoEdit };
