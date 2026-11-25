'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { openDuckDb } = require('../src/db/duckdb-cli');
const { render } = require('../src/db/duckdb-vscode');
const { fixture, verifyDuckDb, verifyFilePreviews, verifyExtensionCycle } = require('./duckdb-fixture');

test('DuckDB local files require an explicit absolute native client path', async () => {
  await assert.rejects(openDuckDb('duckdb', 'not-used.duckdb'), { code: 'ROCKETBRAIN_DUCKDB_PATH' });
});

test('DuckDB result HTML escapes catalog and data content in the script-free VS Code preview', () => {
  const html = render('DuckDB <script> test', 'Sample > 1', [{ name: '<data>', type: 'INT' }], [['<iframe>'], [null]]);
  assert.match(html, /default-src 'none'/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;data&gt;<small>INT/);
  assert.match(html, /&lt;iframe&gt;/);
  assert.match(html, /class="null">NULL/);
  assert.doesNotMatch(html, /<script>|<iframe>/);
});

test('real DuckDB local database exposes dialect, function overloads, scoped metadata and exact read-only results',
  { skip: !process.env.ROCKETBRAIN_DUCKDB_TEST_BIN && 'Provide the official installed DuckDB CLI to test a real database.' }, async () => {
    let selected;
    const api = { async open(bin, file) { selected = await openDuckDb(bin, file); return selected.source; },
      close() { selected = undefined; }, catalog: () => selected.catalog(), describe: value => selected.describe(value),
      functions: search => selected.functions(search), query: (sql, options) => selected.query(sql, options) };
    const result = await fixture(process.env.ROCKETBRAIN_DUCKDB_TEST_BIN, file => verifyDuckDb(api, file));
    assert.equal(result.fileUnchanged, true);
  });

test('native DuckDB previews a selected external CSV and typed Parquet without widening ordinary SQL access',
  { skip: !process.env.ROCKETBRAIN_DUCKDB_TEST_BIN }, async () => {
    const result = await fixture(process.env.ROCKETBRAIN_DUCKDB_TEST_BIN, async file => {
      const local = await openDuckDb(file.binary,file.database,{extensionDirectory:file.extensionDirectory});
      return verifyFilePreviews(local,file);
    });
    assert.equal(result.fileUnchanged,true);
  });

test('native DuckDB verifies a signed extension through installation, loading, update, disable and removal',
  { skip: !process.env.ROCKETBRAIN_DUCKDB_TEST_BIN || process.env.ROCKETBRAIN_DUCKDB_EXTENSION_TEST !== '1' }, async () => {
    const result = await fixture(process.env.ROCKETBRAIN_DUCKDB_TEST_BIN, async file => {
      const local=await openDuckDb(file.binary,file.database,{extensionDirectory:file.extensionDirectory});
      return verifyExtensionCycle(local,file);
    });
    assert.equal(result.fileUnchanged,true);
  });
