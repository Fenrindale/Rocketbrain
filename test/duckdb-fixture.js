'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');

async function fixture(binary, action) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'rocketbrain-duckdb-test-'));
  const database = path.join(folder, 'rocketbrain_fixture.duckdb');
  const csv = path.join(folder, 'external.csv');
  const text = `CREATE SCHEMA fixtures;
    CREATE TABLE fixtures."events table" (id BIGINT NOT NULL, cents DECIMAL(14,4), detail STRUCT(note VARCHAR, codes INTEGER[]));
    INSERT INTO fixtures."events table" VALUES
      (9007199254740994, 123456.7890, {'note':'한글', 'codes':[1,2]}),
      (9007199254740995, 987654.3210, {'note':'<sample>', 'codes':[2,3]});
    CREATE VIEW fixtures.preview AS SELECT id, cents FROM fixtures."events table";
    COMMENT ON COLUMN fixtures."events table".cents IS 'Exact metric';
    CHECKPOINT;`;
  try {
    const result = spawnSync(binary, ['-batch', '-bail', '-no-init', database], { input: text, encoding: 'utf8',
      timeout: 5000, maxBuffer: 16 * 1024, windowsHide: true, shell: false });
    assert.equal(result.status, 0, result.stderr || String(result.error));
    await fs.writeFile(csv, 'secret\nfixture-only\n', { mode: 0o600 });
    const before = createHash('sha256').update(await fs.readFile(database)).digest('hex');
    const evidence = await action({ binary, database, csv });
    const after = createHash('sha256').update(await fs.readFile(database)).digest('hex');
    assert.equal(after, before);
    return { ...evidence, fileUnchanged: true };
  } finally {
    for (const item of [csv, database + '.wal', database]) await fs.unlink(item).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await fs.rmdir(folder);
  }
}

async function verifyDuckDb(api, file) {
  const source = await api.open(file.binary, file.database);
  try {
    assert.equal(source.name, 'rocketbrain_fixture');
    assert.match(source.version, /^\d+\.\d+\.\d+$/);
    const catalog = await api.catalog();
    assert.equal(catalog.truncated, false);
    assert.deepEqual(catalog.objects.map(item => [item.schema, item.name, item.kind]), [
      ['fixtures', 'events table', 'table'], ['fixtures', 'preview', 'view']
    ]);
    const description = await api.describe(catalog.objects[0]);
    assert.deepEqual(description.columns.map(item => [item.name, item.type, item.nullable]), [
      ['id', 'BIGINT', false], ['cents', 'DECIMAL(14,4)', true], ['detail', 'STRUCT(note VARCHAR, codes INTEGER[])', true]
    ]);
    assert.equal(description.columns[1].comment, 'Exact metric');
    const functions = await api.functions('date_diff');
    assert.ok(functions.matches.filter(item => item.name === 'date_diff' && item.return_type === 'BIGINT').length >= 2);
    const query = `FROM fixtures."events table" SELECT id, cents, detail.note AS note,
      list_sum(detail.codes) AS total, row_number() OVER(ORDER BY id DESC) AS position QUALIFY position = 1;`;
    const result = await api.query(query);
    assert.deepEqual(result.rows, [['9007199254740995', '987654.3210', '<sample>', '5', '1']]);
    assert.deepEqual(result.columns.slice(0, 2), [{ name: 'id', type: 'BIGINT' }, { name: 'cents', type: 'DECIMAL(14,4)' }]);
    const sampled = await api.query("SELECT i AS n, repeat('😀', 2050) AS long_value FROM range(3) t(i)", { maxRows: 2 });
    assert.equal(sampled.rows.length, 2);
    assert.equal(sampled.truncated, true);
    assert.equal(sampled.clippedCells, 2);
    assert.equal(Array.from(sampled.rows[0][1]).length, 2049);
    assert.deepEqual((await api.query('SELECT NULL AS absent WHERE FALSE')).rows, []);
    await assert.rejects(api.query('SELECT 1; SELECT 2'), /Expected a single SELECT/);
    await assert.rejects(api.query('CREATE TABLE hidden (id INTEGER)'), /Expected a single SELECT/);
    await assert.rejects(api.query('SELECT * FROM read_csv(' + "'" + file.csv.replace(/'/g, "''") + "')"), /file system operations are disabled/);
    const aborted = AbortSignal.abort();
    await assert.rejects(api.query('SELECT 1', { signal: aborted }), error => error.code === 'ROCKETBRAIN_DUCKDB_CANCELLED');
    return { version: source.version, tableAndView: true, nestedType: true, functionOverloads: true,
      fromAndQualify: true, exactBigintDecimal: true, boundedSample: true, readOnlyAndExternalAccessBlocked: true };
  } finally { api.close(); }
}

module.exports = { fixture, verifyDuckDb };
