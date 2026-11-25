'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { MysqlService } = require('../src/db/mysql');
const { StreamImporter } = require('../src/db/import-stream');
const { zip } = require('./helpers/xlsx-fixture');
const { strictEntries, strictWorkbook, strictRows, spreadsheet, transitionalSpreadsheet } = require('./helpers/strict-xlsx-fixture');
const { writeOwnedImportSource } = require('./helpers/owned-import-source');
const { owned } = require('./schema-stored-diff-host');
const { jdbcReadback } = require('./java-source-analysis-host');

const jdbc = { people: 2, departments: 1, rolledBackNames: 0 };
const committedRows = 1201;
const quote = value => '`' + value.replaceAll('`', '``') + '`';
const mapping = ['label', 'amount', 'big_value', 'note', 'day', 'flag'].map((target, source) => ({ source, target }));

async function verifyStrictImport(adapter) {
  const runtime = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'rocketbrain-stream-db-'));
  const file = path.join(folder, 'strict-workbook.xlsx');
  const save = bytes => writeOwnedImportSource(file, bytes, { ownedDirectory: folder });
  const table = 'rb_strict_xlsx_' + randomBytes(5).toString('hex');
  const target = quote(table);
  let actor;
  try {
    const connection = await owned(runtime.dbConfigPath);
    actor = connection.actor;
    await actor.query('CREATE TABLE ' + target + ' (id BIGINT AUTO_INCREMENT PRIMARY KEY, label VARCHAR(120) NOT NULL UNIQUE, ' +
      'amount DECIMAL(24,8) NOT NULL, big_value BIGINT UNSIGNED NOT NULL, note VARCHAR(120) NULL, day DATETIME(6) NOT NULL, ' +
      'flag TINYINT NOT NULL) ENGINE=InnoDB');
    await actor.query("INSERT INTO " + target + " (label,amount,big_value,note,day,flag) VALUES ('Existing',1,1,NULL,'2026-01-01',0)");
    assert.deepEqual(await jdbcReadback(), jdbc);
    const count = async () => Number((await actor.query('SELECT COUNT(*) AS n FROM ' + target))[0][0].n);
    await adapter.connect(connection.config);
    await save(strictWorkbook(strictRows(committedRows)));
    const selected = { file, table, sheetId: '1', hasHeader: true, blankPolicy: 'null', mapping };
    const prepare = () => adapter.prepare({ ...selected, formulaPolicy: 'cached' });
    const choice = await adapter.inspect({ file, table });
    assert.equal(choice.xlsxVariant, 'strict');
    assert.deepEqual(choice.sheets.map(sheet => sheet.name), ['Import data', 'Other sheet']);
    await assert.rejects(adapter.prepare(selected), /Formula cells/);
    const approved = await prepare();
    assert.equal(approved.xlsxVariant, 'strict');
    assert.equal(approved.rowCount, committedRows);
    assert.match(approved.sql, /VALUES\s*\(\?,\?,\?,\?,\?,\?\)/u);
    assert.doesNotMatch(approved.sql, /shared|literal/);
    await adapter.preview?.(approved);
    const before = await adapter.run(approved.reviewId);
    assert.equal(before.state, 'awaiting-commit', JSON.stringify(before));
    assert.equal(before.xlsxVariant, 'strict');
    assert.equal(before.rows, committedRows);
    assert.ok(before.maxBatchRows <= 100 && before.maxBatchBytes <= 1024 * 1024);
    assert.equal(await count(), 1);
    assert.equal((await adapter.commit(before.transactionId)).state, 'committed');
    assert.equal(await count(), committedRows + 1);

    const [typed] = await actor.query("SELECT label, CAST(amount AS CHAR) AS amount, CAST(big_value AS CHAR) AS big, note, " +
      "DATE_FORMAT(day,'%Y-%m-%d %H:%i:%s.%f') AS day, flag FROM " + target + ' ORDER BY id LIMIT 2 OFFSET 1');
    assert.deepEqual(typed, [
      { label: '검증 shared & literal', amount: '1234567890123456.12345678', big: '18446744073709551615',
        note: null, day: '2026-01-03 12:34:56.123456', flag: 1 },
      { label: 'Strict 1', amount: '0.00000001', big: '9007199254740993', note: '', day: '1904-01-01 12:00:00.000000', flag: 0 }
    ]);

    await save(strictWorkbook(strictRows(220, 'Explicit rollback')));
    const plan = await prepare(), pending = await adapter.run(plan.reviewId);
    assert.equal(pending.state, 'awaiting-commit', JSON.stringify(pending));
    assert.equal(pending.rows, 220);
    assert.equal(await count(), committedRows + 1);
    assert.equal((await adapter.rollback(pending.transactionId)).state, 'rolled-back');

    await save(strictWorkbook(strictRows(401, 'Cancelled')));
    const cancelPlan = await prepare(), abort = new AbortController();
    const cancelled = await adapter.run(cancelPlan.reviewId, { cancellation: abort.signal,
      onProgress: progress => { if (progress.rows >= 200) abort.abort(); } });
    assert.equal(cancelled.state, 'cancelled', JSON.stringify(cancelled));
    assert.equal(cancelled.rows, 200);
    assert.equal(cancelled.rolledBack, true);

    const stalePlan = await prepare();
    await save(strictWorkbook(strictRows(402, 'Changed after review')));
    const stale = await adapter.run(stalePlan.reviewId);
    assert.equal(stale.rows, 0);
    assert.equal(stale.rolledBack, true);
    assert.match(stale.error.message, /source file changed since review/iu);

    const mixed = strictEntries(strictRows(10, 'Mixed'));
    mixed['xl/worksheets/sheet1.xml'] = mixed['xl/worksheets/sheet1.xml'].replace(spreadsheet, transitionalSpreadsheet);
    await save(zip(mixed));
    await assert.rejects(prepare(), /Invalid worksheet namespace/);
    assert.equal(await count(), committedRows + 1);
    assert.deepEqual(await jdbcReadback(), jdbc);
    return { engine: runtime.dbEngine, version: connection.version, jdbc, strictXlsx: true, selectedSheet: true,
      explicitFormulaCache: true, typedValuesExact: true, committedRows, boundedBatches: before.batches,
      invisibleBeforeCommit: true, explicitRollback: true, cancellationAfterRows: cancelled.rows,
      cancelledWholeTransaction: true, staleSourceRejected: true, mixedNamespaceRejected: true };
  } finally {
    try { await adapter.disconnect(); }
    finally {
      try {
        if (actor) {
          try { await actor.query('DROP TABLE IF EXISTS ' + target); }
          finally { await actor.end(); }
        }
      } finally {
        await fs.unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
        await fs.rmdir(folder);
      }
    }
  }
}

async function verifyStrictImportBackend() {
  let db, importer;
  return verifyStrictImport({
    async connect(config) { db = new MysqlService(config); importer = new StreamImporter(db); },
    async disconnect() { try { await importer?.dispose(); } finally { await db?.dispose(); } },
    inspect: input => importer.inspect(input), prepare: input => importer.prepare(input),
    run: (reviewId, options) => importer.run({ reviewId, ...options }),
    commit: transactionId => importer.commit({ transactionId }), rollback: transactionId => importer.rollback({ transactionId })
  });
}

async function runStrictXlsxImportChecks(api, vscode, checks) {
  const tools = api.streamImports;
  const report = await verifyStrictImport({
    connect: config => api.connectMysql(config),
    async disconnect() {
      for (const pending of await tools.pending()) await tools.rollback(pending.transactionId);
      await api.disconnectMysql();
    },
    inspect: tools.inspect, prepare: tools.prepare, run: tools.run, commit: tools.commit, rollback: tools.rollback,
    async preview(plan) {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.parse('rocketbrain-stream-import:/' + plan.reviewId + '/review.sql'));
      assert.match(document.getText(), /OOXML variant: Strict/u);
      assert.equal(document.isDirty, false);
    }
  });
  checks.push('The installed streaming importer reviewed a Strict OOXML worksheet and committed 1,201 rows after explicit approval.');
  checks.push('An independent database connection saw exact decimal, unsigned BIGINT, shared text, dates, NULL and empty text. Rollback, cancellation and source drift preserved existing rows.');
  return { ...report, nativeReadonlyStrictReview: true };
}

module.exports = { runStrictXlsxImportChecks, verifyStrictImportBackend };
if (require.main === module) verifyStrictImportBackend().then(result => console.log(JSON.stringify(result)))
  .catch(error => { console.error(error.stack); process.exitCode = 1; });
