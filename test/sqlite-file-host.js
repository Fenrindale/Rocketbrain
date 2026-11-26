'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { openSqliteSnapshot } = require('../src/db/sqlite-file');
const { createResultExport } = require('../src/db/result-export');
const { jdbcReadback } = require('./java-source-analysis-host');
const { markers, tableName } = require('./helpers/sqlite-file-fixture');

const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sql = 'WITH capture AS (SELECT seq,reading,display,data,ratio FROM public_measurement) SELECT * FROM capture ORDER BY seq;';
const expected = [
  ['1', '9223372036854775807', '한\0글 🧪', '0x00ff00', 1],
  ['2', '-9223372036854775808', '東京', '0x', 0.125],
  ['3', null, null, null, null]
];
const classes = [ ['INTEGER', 'INTEGER', 'TEXT', 'BLOB', 'REAL'], ['INTEGER', 'INTEGER', 'TEXT', 'BLOB', 'REAL'],
  ['INTEGER', 'NULL', 'NULL', 'NULL', 'NULL'] ];

async function fixture() {
  const spring = await read(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG);
  const configPath = await fs.realpath(spring.dbConfigPath);
  const folder = path.dirname(configPath), marker = await read(path.join(folder, 'owner.json'));
  const descriptor = await fs.realpath(process.env.ROCKETBRAIN_SQLITE_FILE_CONFIG);
  assert.equal(path.dirname(descriptor), folder);
  assert.equal(marker.kind, markers[spring.dbEngine]);
  const selected = await read(descriptor);
  assert.equal(selected.kind, 'RocketbrainOwnedSqliteSnapshot-v1');
  assert.equal(selected.owner, marker.id);
  assert.equal(selected.engine, spring.dbEngine);
  assert.equal(await fs.realpath(selected.configPath), configPath);
  const names = [selected.file, selected.updated, selected.wal];
  for (const item of names) assert.match(item, /^rocketbrain-sqlite-[a-f0-9-]{36}(?:-updated|-wal-mode)?\.db$/u);
  const files = [];
  for (const name of names) {
    const file = await fs.realpath(path.join(folder, name));
    assert.equal(path.dirname(file), folder);
    files.push(file);
  }
  return { engine: selected.engine, runtime: selected.runtime, files, folder };
}

function nativeRoundTrip(result, file) {
  const { DatabaseSync } = require('node:sqlite');
  const reference = new DatabaseSync(file, { readOnly: true });
  const imported = new DatabaseSync(':memory:');
  try {
    const original = reference.prepare('SELECT seq,reading,hex(CAST(display AS BLOB)) textBytes,hex(data) blobBytes,ratio,' +
      'typeof(reading) readingType,typeof(display) textType,typeof(data) blobType,typeof(ratio) realType ' +
      'FROM public_measurement ORDER BY seq');
    original.setReadBigInts(true);
    imported.exec('CREATE TABLE received(seq INTEGER, reading INTEGER, display TEXT, data BLOB, ratio REAL) STRICT');
    const insert = imported.prepare('INSERT INTO received VALUES(?,?,?, ?, ?)');
    const decoded = JSON.parse(createResultExport(result, 'json').data.toString('utf8'));
    assert.deepEqual(decoded.sqliteStorageClasses, classes);
    for (const row of decoded.rows) insert.run(BigInt(row[0]), row[1] === null ? null : BigInt(row[1]), row[2],
      row[3] === null ? null : Buffer.from(row[3].slice(2), 'hex'), row[4]);
    const checked = imported.prepare(original.sourceSQL.replace('public_measurement', 'received'));
    checked.setReadBigInts(true);
    assert.deepEqual(checked.all(), original.all());
  } finally { imported.close(); reference.close(); }
  return true;
}

async function verify(adapter, { nativeCheck, readback = jdbcReadback } = {}) {
  const { engine, runtime, folder, files: [file, updated, wal] } = await fixture();
  const copy = path.join(folder, 'rocketbrain-sqlite-run-' + randomUUID() + '.db');
  await fs.copyFile(file, copy, constants.COPYFILE_EXCL);
  try {
    const initial = hash(await fs.readFile(copy));
    const source = await adapter.open(copy);
    assert.equal(source.snapshotSha256, initial);
    assert.equal(source.readOnly, true);
    assert.match(source.sourceId, /873d4e274b4988d260ba8354a9718324a1c26187a4ab4c1cc0227c03d0f10e70$/u);
    const { objects, truncated } = await adapter.catalog();
    assert.equal(truncated, false);
    assert.deepEqual(objects.map(object => [object.name, object.kind]),
      [['batch', 'table'], ['public_measurement', 'view'], [tableName, 'table']]);
    const model = await adapter.describe(tableName);
    assert.equal(model.strict && model.withoutRowid, true);
    assert.deepEqual(model.columns.filter(column => column.primaryKeyOrder).map(column => [column.name, column.primaryKeyOrder]),
      [['group_id', 1], ['seq', 2]]);
    assert.equal(model.columns.find(column => column.name === 'next_seq').generated, 'stored');
    assert.deepEqual(model.foreignKeys.map(key => [key.table, key.from, key.to, key.onUpdate]), [['batch', 'group_id', 'code', 'CASCADE']]);
    const index = model.indexes.find(item => item.name === 'measured_display');
    assert.equal(index.partial, true);
    assert.match(index.source, /lower\(display\), seq DESC/u);
    assert.deepEqual(index.columns.filter(part => part.key).map(part => [part.term, part.column, part.descending]),
      [['expression', null, false], ['column', 'seq', true]]);
    assert.equal(model.indexes.find(item => item.origin === 'pk').source, null);
    assert.match((await adapter.describe('public_measurement')).source, /^CREATE VIEW public_measurement/u);
    await assert.rejects(adapter.describe('PUBLIC_MEASUREMENT'), /exact SQLite object/iu);
    await adapter.schemaDocument?.(model);

    for (const rejected of ['UPDATE batch SET code=code', 'WITH c(x) AS (SELECT 1) DELETE FROM batch RETURNING code', 'SELECT 1; SELECT 2',
      "SELECT 1; ATTACH DATABASE 'other.db' AS other", 'PRAGMA query_only=OFF', "SELECT load_extension('x')"]) {
      await assert.rejects(adapter.prepare(rejected), /read-only|one SQLite statement|no such function/iu);
    }
    const review = await adapter.prepare(sql);
    assert.ok(review.plan.some(node => node.detail.includes(tableName)));
    assert.equal(review.sql, sql);
    assert.equal(review.snapshotSha256, source.snapshotSha256);
    await adapter.reviewDocument?.(review);
    const result = await adapter.run(review.reviewId);
    assert.deepEqual(result.rows, expected);
    assert.deepEqual(result.sqliteStorageClasses, classes);
    assert.equal(result.truncated, false);
    await assert.rejects(adapter.run(review.reviewId), /review the exact query/iu);
    const limited = await adapter.prepare(sql, { maxRows: 2 });
    const truncatedResult = await adapter.run(limited.reviewId);
    assert.equal(truncatedResult.truncated, true);
    assert.deepEqual(truncatedResult.rows, expected.slice(0, 2));
    const mixed = await adapter.prepare("SELECT x'' AS value, '' AS value, 1 AS value, 1.0 AS value, CAST(x'ff' AS TEXT) AS invalid_text");
    const mixedValues = await adapter.run(mixed.reviewId);
    assert.deepEqual(mixedValues.rows, [['0x', '', '1', 1, '0xff']]);
    assert.deepEqual(mixedValues.sqliteStorageClasses, [['BLOB', 'TEXT', 'INTEGER', 'REAL', 'TEXT_BYTES']]);
    const roundTrip = nativeCheck ? nativeRoundTrip(result, file) : null;
    assert.equal(hash(await fs.readFile(copy)), initial);

    const stale = await adapter.prepare(sql);
    await fs.copyFile(updated, copy);
    assert.deepEqual((await adapter.run(stale.reviewId)).rows, expected);
    const oldReview = await adapter.prepare(sql);
    await assert.rejects(adapter.open(wal), /WAL-mode file headers/u);
    assert.equal(adapter.source().snapshotSha256, initial);
    const refreshed = await adapter.refresh();
    assert.notEqual(refreshed.snapshotSha256, source.snapshotSha256);
    await assert.rejects(adapter.run(oldReview.reviewId), /review the exact query/iu);
    const renewed = await adapter.prepare(sql);
    const latest = await adapter.run(renewed.reviewId);
    assert.deepEqual(latest.rows, [...expected, ['4', '17', '갱신', '0xfe', 2]]);

    const costly = await adapter.prepare('WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<1000000000) SELECT sum(x) FROM n');
    await assert.rejects(adapter.run(costly.reviewId, { timeoutMs: 50 }), /timed out/iu);
    assert.equal(adapter.source(), null);
    await adapter.open(copy);
    await assert.rejects(adapter.run(costly.reviewId), /review the exact query/iu);
    return { engine, runtime, sqliteVersion: source.version, actualFile: true, schemaIndexesPkFk: true, exactTypedGrid: true,
      bytesAndNumericStorageTypes: true, sqliteExportNativeRoundTrip: roundTrip, sourceFileUnchangedByQuery: true,
      rejectedWritesAndWal: true, refreshRebindsSnapshot: true, isolatedQueryTimeout: true, spring: await readback() };
  } finally {
    await adapter.close();
    await fs.unlink(copy);
  }
}

function verifySqliteFileBackend() {
  let active;
  const adapter = {
    async open(file) { const candidate = await openSqliteSnapshot(file); await active?.stop(); active = candidate; return candidate.source; },
    async close() { await active?.stop(); active = undefined; },
    source: () => active?.source ?? null, refresh: () => adapter.open(active.file),
    catalog: () => active.catalog(), describe: name => active.describe(name), prepare: (query, options) => active.prepare(query, options),
    run: (id, options) => active.execute(id, options)
  };
  return verify(adapter, { nativeCheck: true });
}

async function runSqliteFileChecks(api, vscode, checks) {
  const sqlite = api.sqlite;
  assert.ok(sqlite);
  assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.sqlite.run'));
  const result = await verify({ ...sqlite,
    async schemaDocument(model) {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(model.schemaUri));
      assert.match(document.getText(), /WITHOUT ROWID|CREATE INDEX measured_display/iu);
      assert.equal(document.isDirty, false);
    },
    async reviewDocument(review) {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(review.reviewUri));
      assert.ok(document.getText().endsWith(sql));
      assert.ok(document.getText().includes(review.snapshotSha256));
      assert.equal(document.isDirty, false);
      const queryUri = await vscode.commands.executeCommand('rocketbrain.sqlite.newQuery');
      assert.equal((await vscode.workspace.openTextDocument(vscode.Uri.parse(queryUri))).languageId, 'rocketbrain-sqlite');
    },
    async run(id, options) {
      const result = await sqlite.run(id, options);
      assert.ok(api.scriptResultRetained(result.resultId));
      return result;
    }
  });
  checks.push('The installed local SQLite workflow opened an owned checkpointed file, showed exact index/schema and query reviews, published typed rows to the shared read-only results grid and enforced snapshot refresh and timeout boundaries.');
  return { ...result, nativeSQLiteFileEditorAndResults: true };
}

module.exports = { verifySqliteFileBackend, runSqliteFileChecks };
if (require.main === module) verifySqliteFileBackend().then(value => console.log(JSON.stringify(value)))
  .catch(error => { console.error(error.stack); process.exitCode = 1; });
