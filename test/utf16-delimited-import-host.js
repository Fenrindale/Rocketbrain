'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomBytes, createHash } = require('node:crypto');
const { MysqlService } = require('../src/db/mysql');
const { StreamImporter, SOURCE_LIMITS } = require('../src/db/import-stream');
const { owned } = require('./schema-stored-diff-host');
const { writeOwnedImportSource } = require('./helpers/owned-import-source');
const { delimitedFixture, encodeUtf16 } = require('./helpers/utf16-delimited-fixture');

const rows = 1201;
const mapping = ['id', 'payload', 'marker'].map((target, source) => ({ source, target }));
const placements = [
  { encoding: 'utf-16le', suffix: 'le', format: 'tsv', delimiter: '\t' },
  { encoding: 'utf-16be', suffix: 'be', format: 'csv', delimiter: ',' }
];
const initialSpring = { people: 2, departments: 1, rolledBackNames: 0 };
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function verifyUtf16DelimitedImport(adapter) {
  const runtime = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'rocketbrain-stream-db-'));
  const prefix = 'rb_utf16_' + randomBytes(5).toString('hex');
  const outputTables = [prefix + '_le', prefix + '_be', prefix + '_cancel'];
  const checked = [];
  const paths = new Set();
  let actor, connected = false;
  const spring = async () => {
    const url = new URL('/probe/testing-state', runtime.baseUrl);
    assert.equal(url.hostname, '127.0.0.1');
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), initialSpring);
  };
  const count = async table => Number((await actor.query('SELECT COUNT(*) n FROM ' + table))[0][0].n);
  async function save(file, bytes) {
    paths.add(file);
    return writeOwnedImportSource(file, bytes, { ownedDirectory: folder });
  }
  try {
    const fixture = await owned(runtime.dbConfigPath);
    actor = fixture.actor;
    await spring();
    for (const table of outputTables) {
      await actor.query('CREATE TABLE ' + table + ' (id INT PRIMARY KEY, payload TEXT NOT NULL, marker VARCHAR(32) NULL)' +
        ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
    }
    await adapter.connect(fixture.config);
    connected = true;
    for (const mode of placements) {
      const table = prefix + '_' + mode.suffix;
      const file = path.join(folder, 'encoded-' + mode.suffix + '.' + mode.format);
      const fixture = delimitedFixture(mode.delimiter, rows, SOURCE_LIMITS.chunkBytes);
      assert.equal(fixture.text.charCodeAt(fixture.splitAt), 0xd83d);
      assert.equal(fixture.text.charCodeAt(fixture.splitAt + 1), 0xde00);
      const bytes = encodeUtf16(fixture.text, mode.encoding);
      await save(file, bytes);
      const input = { file, table, mapping, nullToken: 'NULL', hasHeader: true };
      const displayed = await adapter.inspect(input);
      assert.equal(displayed.textEncoding, mode.encoding);
      assert.equal(displayed.byteOrderMark, true);
      assert.deepEqual(displayed.headers, ['id', 'payload', 'marker']);
      assert.equal(displayed.fileHash, sha256(bytes));
      const approved = await adapter.prepare(input);
      assert.equal(approved.rowCount, rows);
      assert.equal(approved.format, mode.format);
      assert.equal(approved.textEncoding, mode.encoding);
      assert.equal(approved.byteOrderMark, true);
      assert.equal(approved.sourceSha256, displayed.fileHash);
      await adapter.preview?.(approved);
      const result = await adapter.run(approved.reviewId);
      assert.equal(result.state, 'awaiting-commit', JSON.stringify(result));
      assert.equal(result.rows, rows);
      assert.equal(result.batches, 13);
      assert.equal(result.textEncoding, mode.encoding);
      assert.equal(result.byteOrderMark, true);
      assert.equal(await count(table), 0);
      assert.equal((await adapter.commit(result.transactionId)).state, 'committed');
      assert.equal(await count(table), rows);
      const [stored] = await actor.query('SELECT id,payload,marker FROM ' + table + ' ORDER BY id LIMIT 3');
      assert.deepEqual(stored.map(row => [row.id, row.payload, row.marker]), fixture.sample);
      checked.push({ format: mode.format, encoding: mode.encoding, rows: result.rows, batches: result.batches,
        sourceSha256: approved.sourceSha256, exactUnicodeAndQuotedNull: true, invisibleUntilCommit: true });
    }

    const file = path.join(folder, 'encoded-cancelled.csv');
    const cancelInput = { file, table: outputTables[2], mapping, nullToken: 'NULL' };
    const content = delimitedFixture(',', 401, SOURCE_LIMITS.chunkBytes).text;
    const original = encodeUtf16(content, 'utf-16be');
    await save(file, original);
    const plan = await adapter.prepare(cancelInput), cancellation = new AbortController();
    const aborted = await adapter.run(plan.reviewId, { cancellation: cancellation.signal,
      onProgress: value => { if (value.rows >= 200) cancellation.abort(); } });
    assert.equal(aborted.state, 'cancelled', JSON.stringify(aborted));
    assert.equal(aborted.rows, 200);
    assert.equal(aborted.rolledBack, true);
    assert.equal(await count(cancelInput.table), 0);
    const stalePlan = await adapter.prepare(cancelInput);
    await save(file, encodeUtf16(content, 'utf-16le'));
    const stale = await adapter.run(stalePlan.reviewId);
    assert.equal(stale.state, 'failed');
    assert.equal(stale.rolledBack, true);
    assert.equal(stale.rows, 0);
    assert.match(stale.error.message, /source file changed since review/iu);
    await save(file, Buffer.concat([original, Buffer.from([0xd8, 0x00])]));
    await assert.rejects(() => adapter.prepare(cancelInput), /valid UTF-16BE/u);
    assert.equal(await count(cancelInput.table), 0);
    await spring();
    return { engine: runtime.dbEngine, serverVersion: fixture.version, checked, sourceByteOrderDriftRejected: true,
      invalidSurrogateRejected: true, cancelledAfterRows: aborted.rows, entireCancellationRolledBack: true,
      springJdbcUnchanged: true, nativeReadonlyReview: Boolean(adapter.preview) };
  } finally {
    try { if (connected) await adapter.disconnect(); }
    finally {
      try {
        if (actor) {
          try { for (const table of outputTables) await actor.query('DROP TABLE IF EXISTS ' + table); }
          finally { await actor.end(); }
        }
      } finally {
        for (const file of paths) await fs.unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
        await fs.rmdir(folder);
      }
    }
  }
}

async function verifyUtf16DelimitedImportBackend() {
  let db, importer;
  return verifyUtf16DelimitedImport({
    connect(config) { db = new MysqlService(config); importer = new StreamImporter(db); },
    async disconnect() { try { await importer.dispose(); } finally { await db.dispose(); } },
    inspect: input => importer.inspect(input), prepare: input => importer.prepare(input),
    run: (reviewId, options) => importer.run({ reviewId, ...options }),
    commit: transactionId => importer.commit({ transactionId })
  });
}

async function runUtf16DelimitedImportChecks(api, vscode, checks) {
  const tool = api.streamImports;
  const report = await verifyUtf16DelimitedImport({
    connect: config => api.connectMysql(config),
    async disconnect() {
      for (const pending of await tool.pending()) await tool.rollback(pending.transactionId);
      await api.disconnectMysql();
    },
    inspect: tool.inspect, prepare: tool.prepare, run: tool.run, commit: tool.commit,
    async preview(plan) {
      const uri = vscode.Uri.parse('rocketbrain-stream-import:/' + plan.reviewId + '/review.sql');
      const document = await vscode.workspace.openTextDocument(uri);
      assert.ok(document.getText().includes('-- Text encoding: ' + plan.textEncoding.toUpperCase() + ' (BOM)'));
      assert.equal(document.isDirty, false);
    }
  });
  checks.push('The installed stream review identified BOM-marked UTF-16LE TSV and UTF-16BE CSV and committed 1,201 rows from each.');
  checks.push('The server readback preserved chunk-split Unicode, quoted fields and SQL NULL. The importer rejected malformed bodies and a byte-order change and rolled back cancellation.');
  return report;
}

module.exports = { runUtf16DelimitedImportChecks, verifyUtf16DelimitedImportBackend };
if (require.main === module) {
  verifyUtf16DelimitedImportBackend().then(report => console.log(JSON.stringify(report)))
    .catch(error => { console.error(error.stack); process.exitCode = 1; });
}
