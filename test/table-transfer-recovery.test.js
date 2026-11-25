'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const test = require('node:test');
const { createTransferRecovery } = require('../src/db/table-transfer-recovery');
const { createRowSpool } = require('../src/db/table-transfer-spool');
const { createTableTransfer, transferable, assertMappedValues } = require('../src/db/table-transfer');
const { StreamImporter } = require('../src/db/import-stream');

const column = { name: 'memo', type: 'longtext', kind: 'text', charset: 'utf8mb4', nullable: true };

async function fixture(t) {
  const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), 'rb-saved-test-'));
  const root = path.join(storagePath, 'table-copy-snapshots'), id = randomUUID(), contents = new Map();
  const secrets = { get: async key => contents.get(key), store: async (key, value) => contents.set(key, value), delete: async key => contents.delete(key) };
  let trusted = true;
  const newStore = () => createTransferRecovery({ storagePath, secrets, isTrusted: () => trusted });
  const store = newStore(), directory = await store.reserve(id);
  const spool = await createRowSpool({ columns: [column], directory, maxRows: 128, maxBytes: 4096, maxRowBytes: 512 });
  t.after(async () => {
    await spool.dispose();
    await store.discard(id, { skipTrust: true });
    await fs.rmdir(root);
    await fs.rmdir(storagePath);
  });
  await spool.append(['private UTF8 가나다\r\n']);
  const sealed = await spool.seal();
  await store.save({ id, expiresAt: Date.now() + 60000, columns: [column], spool, database: 'source', table: 'work', engine: 'mysql', maxBufferedRows: 1 });
  return { store, newStore, id, directory, sealed, spool, contents, setTrust: value => { trusted = value; } };
}

test('a new table copy service authenticates a persisted encrypted snapshot and exposes no key or path', async t => {
  const { newStore, id, directory, sealed, spool, contents, setTrust } = await fixture(t);
  await spool.dispose();
  const [secret] = contents.values();
  assert.ok(JSON.parse(secret).recovery.key.length === 64);
  assert.ok(!(await fs.readFile(path.join(directory, 'rows.bin'))).includes(Buffer.from('private')));
  const core = createTableTransfer({}, { recovery: newStore() });
  assert.deepEqual(core.listSources(), []);
  assert.equal((await core.listRecoverableSources())[0].id, id);
  setTrust(false);
  await assert.rejects(core.resumeSource({ captureId: id }), /trusted workspace/);
  setTrust(true);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(core.resumeSource({ captureId: id, cancellation: cancelled.signal }), /cancelled/);
  const reopened = await core.resumeSource({ captureId: id });
  assert.equal(reopened.sourceHash, sealed.sourceHash);
  assert.equal(reopened.recoveryState, 'ready');
  assert.ok(!Object.hasOwn(reopened, 'spool') && !Object.hasOwn(reopened, 'key') && !Object.hasOwn(reopened, 'directory'));
  await core.dispose();
  const fresh = createTableTransfer({}, { recovery: newStore() });
  assert.equal((await fresh.resumeSource({ captureId: id })).sourceHash, sealed.sourceHash);
  await fresh.dispose();
});

test('strict commit fence permits only one host and blocks future restores after the outcome is unknown', async t => {
  const { newStore, id, directory, contents, spool } = await fixture(t);
  await spool.dispose();
  const results = await Promise.allSettled([newStore().beginCommit(id), newStore().beginCommit(id)]);
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(results.filter(item => item.status === 'rejected').length, 1);
  assert.ok(JSON.parse([...contents.values()][0]).state === 'settlement-unconfirmed');
  const first = createTableTransfer({}, { recovery: newStore() });
  assert.equal((await first.listRecoverableSources())[0].recoveryState, 'settlement-unconfirmed');
  await assert.rejects(first.resumeSource({ captureId: id }), /previous Commit/);
  await fs.unlink(path.join(directory, 'commit.intent'));
  await assert.rejects(first.resumeSource({ captureId: id }), /previous Commit/, 'the SecretStorage fence has its own effect');
  await first.dispose();
});

test('an unconfirmed COMMIT leaves the restart fence in place, and a fenced transaction can only roll back', async t => {
  const { store, newStore, id } = await fixture(t);
  const control = [];
  const db = { _assertOpen() {}, _lose() {}, async _refreshState() {}, async _control(session, sql) {
    control.push(sql);
    if (sql === 'COMMIT') {
      assert.equal((await newStore().list())[0].recoveryState, 'settlement-unconfirmed');
      throw new Error('connection interrupted after dispatch');
    }
    session.inTransaction = false;
  }, _editor: { models: new Map(), reviews: new Map() } };
  const importer = new StreamImporter(db);
  importer.transport._identity = async () => ({ db: 'target' });
  const stage = name => importer.pending.set(name, { session: { inTransaction: true }, review: { identity: { db: 'target' } },
    report: { expiresAt: Date.now() + 10000 }, timer: null });
  stage('in-flight');
  const result = await importer.commit({ transactionId: 'in-flight', beforeCommit: () => store.beginCommit(id) });
  assert.equal(result.state, 'uncertain');
  assert.equal(result.outcomeUnknown, true);
  await assert.rejects(newStore().resume(id), /previous Commit/);
  stage('other-host');
  await assert.rejects(importer.commit({ transactionId: 'other-host', beforeCommit: () => newStore().beginCommit(id) }), /previous Commit/);
  assert.equal((await importer.rollback({ transactionId: 'other-host' })).state, 'rolled-back');
  assert.deepEqual(control, ['COMMIT', 'ROLLBACK']);
  await importer.dispose();
});

test('resume rejects changed ciphertext and leaves the snapshot available for explicit discard', async t => {
  const { newStore, id, directory, spool } = await fixture(t);
  await spool.dispose();
  const source = path.join(directory, 'rows.bin');
  await fs.appendFile(source, Buffer.from([1]));
  const core = createTableTransfer({}, { recovery: newStore() });
  await assert.rejects(core.resumeSource({ captureId: id }), /snapshot changed/);
  assert.deepEqual(core.listSources(), []);
  assert.equal(await core.discardRecoverableSource({ captureId: id }), true);
  assert.deepEqual(await core.listRecoverableSources(), []);
  await core.dispose();
});

test('an interrupted encrypted scan remains readable and distinguishes identity drift from unauthenticated ciphertext', async t => {
  const { store, id, directory, sealed, spool, contents } = await fixture(t);
  await spool.dispose();
  await store.beginCommit(id, { version: 3, keys: [0], sourceHash: sealed.sourceHash, rowCount: sealed.rowCount });
  const cancellation = new AbortController();
  const interrupted = await store.inspectUncertainSource(id);
  await assert.rejects(interrupted.scan({ cancellation: cancellation.signal, onRow() { cancellation.abort(); } }), /cancelled/);
  const reopened = await store.inspectUncertainSource(id);
  assert.equal((await reopened.scan({})).sourceHash, sealed.sourceHash);
  await reopened.assertCurrent();
  const file = path.join(directory, 'rows.bin');
  const bytes = await fs.readFile(file);
  bytes[bytes.length - 1] ^= 1;
  await fs.writeFile(file, bytes);
  await assert.rejects(reopened.scan({}), error => error.verificationReason === 'retained-snapshot-metadata-changed' &&
    error.snapshotCheck.phase === 'before-read');
  // Simulate a forged storage record whose file attributes agree with the modified bytes.
  const [name, text] = [...contents][0], saved = JSON.parse(text), stat = await fs.stat(file);
  Object.assign(saved.recovery.sealed.identity, { size: stat.size, changed: stat.ctimeMs, modified: stat.mtimeMs });
  contents.set(name, JSON.stringify(saved));
  await reopened.assertCurrent();
  const corrupted = await store.inspectUncertainSource(id);
  await assert.rejects(corrupted.scan({}), error => error.verificationReason === 'retained-snapshot-authentication-failed' &&
    error.snapshotCheck.phase === 'frame');
  await assert.rejects(store.resume(id), /previous Commit/);
});

test('an authenticated commit marker binds full evidence through stale SecretStorage and detects tampering and discard', async t => {
  const { store, id, directory, sealed, spool, contents } = await fixture(t);
  const [name, ready] = [...contents][0];
  const marker = path.join(directory, 'commit.intent');
  const evidence = { version: 3, keys: [0], sourceHash: sealed.sourceHash, rowCount: sealed.rowCount,
    samples: [{ key: ['private-mapped-value'], hash: 'a'.repeat(64) }] };
  await spool.dispose();
  await store.beginCommit(id, evidence);
  const tombstone = contents.get(name);
  const bytes = await fs.readFile(marker);
  assert.ok(!bytes.includes(Buffer.from('private-mapped-value')) && !bytes.includes(Buffer.from(sealed.sourceHash)));
  contents.set(name, ready);
  assert.equal((await store.list())[0].fullVerificationAvailable, true);
  assert.deepEqual(await store.uncertainCommit(id), evidence);
  await assert.rejects(store.resume(id), /previous Commit/);
  const retained = await store.inspectUncertainSource(id);
  assert.equal((await retained.scan({})).sourceHash, sealed.sourceHash);
  contents.delete(name);
  await retained.assertCurrent();
  contents.set(name, tombstone);
  const corrupted = Buffer.from(bytes);
  corrupted[corrupted.length - 1] ^= 1;
  await fs.writeFile(marker, corrupted);
  await assert.rejects(retained.assertCurrent(), error => error.verificationReason === 'retained-evidence-changed');
  assert.equal(await store.uncertainCommit(id), undefined, 'invalid marker does not fall back to the tombstone');
  assert.equal((await store.list())[0].fullVerificationAvailable, false);
  await assert.rejects(store.resume(id), /previous Commit/);
  await fs.writeFile(marker, bytes);
  const restored = await store.inspectUncertainSource(id);
  await restored.assertCurrent();
  await store.discard(id);
  await assert.rejects(restored.assertCurrent(), error => error.verificationReason === 'retained-evidence-changed');
});

test('new exact types validate unsigned bits, year zero, declarations and fixed width without coercion', () => {
  const bit = { ...column, type: 'bit(64)' };
  const year = { ...column, type: 'year(4)' };
  const choice = { ...column, type: "enum('open','닫힘')" };
  const set = { ...column, type: "set('a','b')" };
  const fixed = { ...column, type: 'binary(4)' };
  const columns = [bit, year, choice, set, fixed];
  const source = { columns, rows: [['0xffffffffffffffff', '0', '닫힘', 'a,b', '0x00ff0100'], [null, '2155', 'open', '', null]] };
  assert.deepEqual(columns.map(item => transferable(item).kind), ['bit', 'year', 'enum', 'set', 'binary']);
  const selected = columns.map((column, source) => ({ column, source }));
  assertMappedValues(source, selected);
  assert.throws(() => assertMappedValues(source, [{ column: { ...bit, type: 'bit(63)' }, source: 0 }]), /without conversion/);
  assert.throws(() => assertMappedValues(source, [{ column: { ...set, type: "set('b','a')" }, source: 3 }]), /compatible exact types/);
  assert.throws(() => assertMappedValues(source, [{ column: { ...fixed, type: 'binary(5)' }, source: 4 }]), /compatible exact types/);
  assert.equal(transferable({ ...choice, type: "enum('','open')" }), null);
});
