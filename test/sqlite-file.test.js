'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const test = require('node:test');
const assert = require('node:assert/strict');
const initSqlJs = require('sql.js');
const { openSqliteSnapshot } = require('../src/db/sqlite-file');
const { sqliteReadQuery } = require('../src/db/sqlite-read');
const { statementAt } = require('../src/sql');
const { createResultExport } = require('../src/db/result-export');

const request = 'SELECT binary_value, label, value, NULL AS missing FROM measurements';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t) {
  const root = await fs.realpath(os.tmpdir());
  const folder = await fs.mkdtemp(path.join(root, 'rocketbrain-sqlite-test-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  let bytes;
  try {
    db.run(`CREATE TABLE measurements (id INTEGER PRIMARY KEY, binary_value BLOB, label TEXT, value INTEGER) STRICT;
      CREATE INDEX by_label ON measurements(label);
      INSERT INTO measurements VALUES (1,x'ff00',char(54620,0,44544),9223372036854775807);`);
    bytes = db.export();
  } finally { db.close(); }
  const file = path.join(folder, '측정 snapshot.sqlite');
  await fs.writeFile(file, bytes);
  return { file, bytes };
}

test('SQLite file worker safely opens a real image and keeps exact query data while the review token is single-use', async t => {
  const { file, bytes } = await fixture(t);
  const snapshot = await openSqliteSnapshot(file);
  t.after(() => snapshot.stop());
  assert.equal(snapshot.source.snapshotSha256, digest(bytes));
  assert.deepEqual((await snapshot.catalog()).objects.map(object => object.name), ['measurements']);
  assert.equal((await snapshot.describe('measurements')).indexes[0].name, 'by_label');
  await assert.rejects(snapshot.execute('arbitrary-review'), /Review the exact query/u);
  await assert.rejects(snapshot.prepare('SELECT 1; PRAGMA query_only=OFF'), /one SQLite statement/u);
  const proposal = await snapshot.prepare(request);
  assert.equal(proposal.plan[0].detail, 'SCAN measurements');
  proposal.sql = 'SELECT 99';
  const result = await snapshot.execute(proposal.reviewId);
  assert.deepEqual(result.rows, [['0xff00', '한\0글', '9223372036854775807', null]]);
  assert.deepEqual(result.sqliteStorageClasses, [['BLOB', 'TEXT', 'INTEGER', 'NULL']]);
  const serialized = JSON.parse(createResultExport(result, 'json').data.toString('utf8'));
  assert.deepEqual(serialized.rows, result.rows);
  assert.deepEqual(serialized.sqliteStorageClasses, result.sqliteStorageClasses);
  await assert.rejects(snapshot.execute(proposal.reviewId), /Review the exact query/u);
  assert.equal(digest(await fs.readFile(file)), digest(bytes));
});

test('SQLite file worker rejects non-database images, journal sidecars and unresolved non-local routes', async t => {
  const { file, bytes } = await fixture(t);
  await fs.writeFile(file + '-wal', Buffer.alloc(0), { flag: 'wx' });
  await assert.rejects(openSqliteSnapshot(file), /without WAL, SHM or rollback journal sidecars/u);
  const malformed = file + '.invalid';
  await fs.writeFile(malformed, Buffer.alloc(bytes.byteLength), { flag: 'wx' });
  await assert.rejects(openSqliteSnapshot(malformed), /not a plain SQLite 3/u);
  await assert.rejects(openSqliteSnapshot('relative.sqlite'), /absolute local SQLite file/u);
});

test('SQLite identifies an outer read verb independently of quoted CTE names and delimiters', () => {
  const read = "--sqlite comment\nWITH [select;append](id) AS NOT MATERIALIZED (SELECT 'UPDATE'), c AS (SELECT 2) VALUES (3)";
  assert.doesNotThrow(() => sqliteReadQuery(read));
  assert.throws(() => sqliteReadQuery('WITH [SELECT](id) AS (SELECT 1) INSERT INTO test VALUES(3) RETURNING id;'), /read-only SQLite/u);
  const joined = 'SELECT [a;b] FROM t; --comment;not a separator\nSELECT 23;';
  assert.equal(statementAt(joined, joined.indexOf('a;b'), { dialect: 'sqlite' }), 'SELECT [a;b] FROM t;');
  assert.ok(statementAt(joined, joined.length, { dialect: 'sqlite' }).endsWith('SELECT 23;'));
});
