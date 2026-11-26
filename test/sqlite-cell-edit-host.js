'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const pin = require('../src/db/sqlite-edit-pin');
const { sqliteFileIdentity } = require('../src/db/sqlite-local-file');
const { openSqliteSnapshot } = require('../src/db/sqlite-file');
const { createSqliteCellEditor } = require('../src/db/sqlite-cell-editor');
const { jdbcReadback } = require('./java-source-analysis-host');
const { fixtureRoute, primaryKey } = require('./helpers/sqlite-edit-fixture');

const run = promisify(execFile);
const helper = path.join(__dirname, 'helpers', 'sqlite-edit-fixture.js');
const env = () => ({ descriptor: process.env.ROCKETBRAIN_SQLITE_EDIT_CONFIG, node: process.env.ROCKETBRAIN_SQLITE_EDIT_NODE });
const code = value => ({ code: 'ROCKETBRAIN_SQLITE_EDIT_' + value });
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));

async function probe(node, descriptor, action) {
  const result = await run(node, ['--no-warnings', helper, action, descriptor], { windowsHide: true, timeout: 8000, maxBuffer: 1024 * 1024 });
  return JSON.parse(result.stdout);
}

async function lock(node, descriptor) {
  const held = spawn(node, ['--no-warnings', helper, 'hold', descriptor], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'ignore'] });
  const closed = new Promise(resolve => held.once('close', resolve));
  held.stdin.on('error', () => {});
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { held.kill(); reject(Error('Owned SQLite lock probe did not start.')); }, 8000);
    held.once('error', error => { clearTimeout(timer); reject(error); });
    held.once('exit', () => { clearTimeout(timer); reject(Error('Owned SQLite lock probe exited before the transaction.')); });
    held.stdout.once('data', data => { clearTimeout(timer); assert.equal(data.toString().trim(), 'locked'); resolve(); });
  });
  return async () => { held.stdin.end(); assert.equal(await closed, 0); };
}

async function verify(adapter, addon) {
  const { descriptor, node } = env(), fixture = fixtureRoute(descriptor);
  const runtime = await read(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG);
  assert.equal(runtime.dbEngine, fixture.engine);
  assert.equal(await fs.realpath(runtime.dbConfigPath), await fs.realpath(fixture.configPath));
  const { file } = fixture;
  const state = action => probe(node, descriptor, action);
  const target = { table: 'edited', key: primaryKey };
  const draft = async (column, replacement) => adapter.editing.review((await adapter.editing.inspect(target)).id, column, replacement);
  const commit = async review => {
    const result = await adapter.editing.apply(review.id, true);
    assert.equal(result.state, 'applied');
    assert.equal(result.changedRows, 1);
    assert.equal(result.key, primaryKey);
    return result;
  };
  const identity = async () => sqliteFileIdentity(await fs.realpath(file), await fs.stat(file, { bigint: true }));
  const numeric = value => ({ kind: 'INTEGER', value });
  const text = value => ({ kind: 'TEXT', value });
  const blob = value => ({ kind: 'BLOB', value });
  const sqlNull = { kind: 'NULL', value: null };

  try {
    const source = await adapter.open(file);
    assert.equal(source.fileIdentity, await identity());
    await assert.rejects(adapter.editing.inspect(target), code('RUNTIME'));
    const selectedRuntime = await adapter.editing.selectRuntime(node);
    assert.deepEqual(selectedRuntime, { node: pin.node, sqlite: pin.sqlite, sha256: pin.sha256 });
    const original = await state('values');
    const amount = await draft('amount', numeric('-9223372036854775808'));
    assert.deepEqual(amount.previous, numeric('9223372036854775807'));
    assert.equal(amount.fileIdentity, source.fileIdentity);
    assert.match(amount.sql, /^UPDATE OR ABORT main\."edited" SET "amount"=\? WHERE "id"=\?$/u);
    await addon?.reviewDocument(amount);
    await assert.rejects(adapter.editing.apply(amount.id, false), code('REVIEW'));
    assert.deepEqual(await state('values'), original);
    await commit(amount);
    await assert.rejects(adapter.editing.apply(amount.id, true), code('REVIEW'));
    assert.equal((await state('values')).rows[1].amount, '-9223372036854775808');
    assert.equal(await identity(), source.fileIdentity);

    const data = await draft('binary_data', blob('00ff80'));
    await state('peer');
    await commit(data);
    const afterPeer = await state('values');
    assert.deepEqual(afterPeer.rows[0], { ...original.rows[0], required: 'peer-committed' });
    assert.equal(afterPeer.rows[1].bytesHex, '00FF80');
    assert.equal(afterPeer.rows[1].bytesType, 'blob');
    await commit(await draft('binary_data', blob('')));
    assert.deepEqual((await state('values')).rows[1], { ...afterPeer.rows[1], bytesHex: '' });
    await commit(await draft('binary_data', sqlNull));
    await commit(await draft('ratio', { kind: 'REAL', value: '2.5' }));
    const unicode = '한\0글 🧪';
    await commit(await draft('label', text(unicode)));
    const afterText = await state('values');
    assert.equal(afterText.rows[1].labelHex, Buffer.from(unicode).toString('hex').toUpperCase());
    assert.equal(afterText.rows[1].bytesType, 'null');
    assert.equal(afterText.rows[1].ratio, 2.5);
    assert.equal(afterText.rows[0].bytesType, 'blob');
    assert.equal(afterText.rows[0].bytesHex, '');

    const conflicting = await draft('label', text('peer'));
    await assert.rejects(adapter.editing.apply(conflicting.id, true), code('CONSTRAINT'));
    assert.deepEqual(await state('values'), afterText);
    const observed = await adapter.editing.inspect(target);
    await assert.rejects(async () => adapter.editing.review(observed.id, 'linked', text('would-cascade')), code('VALUE'));
    await assert.rejects(async () => adapter.editing.review(observed.id, 'id', numeric('12')), code('VALUE'));
    await assert.rejects(async () => adapter.editing.review(observed.id, 'required', sqlNull), code('VALUE'));
    adapter.editing.discard(observed.id);
    for (const table of ['guarded', 'generated', 'edited_view']) await assert.rejects(adapter.editing.inspect({ table, key: '1' }), code('SCOPE'));

    const stale = await draft('amount', numeric('9'));
    await state('stale-row');
    await assert.rejects(adapter.editing.apply(stale.id, true), code('STALE'));
    const schemaChanged = await draft('amount', numeric('9'));
    await state('stale-schema');
    await assert.rejects(adapter.editing.apply(schemaChanged.id, true), code('STALE'));

    const busy = await draft('amount', numeric('9'));
    const unlock = await lock(node, descriptor);
    try { await assert.rejects(adapter.editing.apply(busy.id, true), { ...code('BUSY'), sqliteCode: 5 }); }
    finally { await unlock(); }
    await assert.rejects(adapter.editing.apply(busy.id, true), code('REVIEW'));
    assert.deepEqual((await state('values')).rows[1], { ...afterText.rows[1], required: 'other-client' });

    const table = await adapter.prepare('SELECT amount FROM edited WHERE id=9007199254740994');
    assert.deepEqual((await adapter.run(table.reviewId)).rows, [['9223372036854775807']]);
    const refreshInvalidates = await draft('amount', numeric('9'));
    await adapter.refresh();
    await assert.rejects(adapter.editing.apply(refreshInvalidates.id, true), code('REVIEW'));
    const refreshed = await adapter.prepare('SELECT amount FROM edited WHERE id=9007199254740994');
    assert.deepEqual((await adapter.run(refreshed.reviewId)).rows, [['-9223372036854775808']]);

    const replaced = await draft('amount', numeric('77'));
    const beforeReplacement = await state('values');
    await state('replace');
    assert.notEqual(await identity(), source.fileIdentity);
    await assert.rejects(adapter.editing.apply(replaced.id, true), code('FILE'));
    assert.deepEqual(await state('values'), beforeReplacement);
    assert.equal(beforeReplacement.dependent, 'parent');
    assert.equal(beforeReplacement.guarded, 'held');
    return { engine: fixture.engine, runtime: selectedRuntime, exactIntegerRealNullBlobUnicode: true, committedSamePhysicalFile: true,
      peerPreservedAndReplaceConstraintDenied: true, blockedCascadingTriggerAndGeneratedCells: true, replayAndUnapprovedRefused: true,
      staleFileSchemaAndRowsRefused: true, busySqliteCode: 5, readOnlySnapshotPreservedUntilRefresh: true, spring: await jdbcReadback() };
  } finally { await adapter.close(); }
}

async function verifySqliteCellEditBackend() {
  let session;
  const adapter = {
    async open(file) { const selected = await openSqliteSnapshot(file); await session?.stop(); session = selected; return selected.source; },
    async close() { await session?.stop(); session = undefined; },
    refresh: () => adapter.open(session.file), prepare: (sql, options) => session.prepare(sql, options), run: (id, options) => session.execute(id, options)
  };
  adapter.editing = createSqliteCellEditor({ isTrusted: () => true, currentSnapshot: () =>
    ({ session, file: session.file, name: session.source.name, fileIdentity: session.source.fileIdentity }) });
  try { return await verify(adapter); }
  finally { adapter.editing.dispose(); }
}

async function runSqliteCellEditChecks(api, vscode, checks) {
  const result = await verify(api.sqlite, { async reviewDocument(review) {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(review.reviewUri));
    assert.equal(document.isDirty, false);
    for (const phrase of [review.sql, review.fileIdentity, review.rowFingerprint, '9223372036854775807', '-9223372036854775808']) {
      assert.ok(document.getText().includes(phrase));
    }
    assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.sqlite.applyCellEdit'));
  } });
  checks.push('The installed SQLite cell edit showed the exact readonly review and committed a single typed change to the original file, with SQLite BUSY, stale-state, replay, and peer controls.');
  return { ...result, nativeSqliteCellReview: true };
}

module.exports = { verifySqliteCellEditBackend, runSqliteCellEditChecks };
if (require.main === module) verifySqliteCellEditBackend().then(value => console.log(JSON.stringify(value)))
  .catch(error => { console.error(error.stack); process.exitCode = 1; });
