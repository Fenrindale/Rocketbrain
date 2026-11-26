'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { prepareOne, sqliteReadQuery, skipTrivia } = require('./sqlite-read');
const { SQLITE_FILE_LIMIT: maxFileBytes, SQLITE_MAGIC: magic, sqliteFileIdentity } = require('./sqlite-local-file');
const LIMITS = require('./limits');

const catalogLimit = 256, indexLimit = 32;
const utf8Text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const fail = message => new Error(message);
const sameFile = (a, b) => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => a[key] === b[key]);
const localPath = file => typeof file === 'string' && path.isAbsolute(file) && !file.includes('\0') && !/^[\\/]{2}/u.test(file);

async function checkSidecars(file) {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const retained = await fs.lstat(file + suffix).catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (retained) throw fail('Select a clean checkpointed SQLite copy without WAL, SHM or rollback journal sidecars.');
  }
}

async function readSnapshot(file) {
  if (!localPath(file)) throw fail('Choose an absolute local SQLite file.');
  const actual = await fs.realpath(file);
  if (!localPath(actual)) throw fail('Choose a local SQLite file on this extension host.');
  const selected = await fs.stat(actual, { bigint: true });
  if (!selected.isFile() || selected.size < 100n || selected.size > BigInt(maxFileBytes)) {
    throw fail('Choose a regular SQLite database file of at most 32 MiB.');
  }
  await checkSidecars(actual);
  const flags = constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const handle = await fs.open(actual, flags);
  let image;
  try {
    const initial = await handle.stat({ bigint: true });
    if (!initial.isFile() || !sameFile(initial, selected)) throw fail('The selected SQLite file changed while opening.');
    image = Buffer.alloc(Number(initial.size));
    let offset = 0;
    while (offset < image.byteLength) {
      const { bytesRead } = await handle.read(image, offset, image.byteLength - offset, offset);
      if (!bytesRead) throw fail('The selected SQLite file changed during the snapshot.');
      offset += bytesRead;
    }
    await checkSidecars(actual);
    if (!sameFile(initial, await handle.stat({ bigint: true })) ||
        !sameFile(initial, await fs.stat(actual, { bigint: true }))) throw fail('The selected SQLite file changed during the snapshot.');
  } finally { await handle.close(); }
  if (!image.subarray(0, 16).equals(magic)) throw fail('The selected file is not a plain SQLite 3 database.');
  if (image[18] !== 1 || image[19] !== 1) throw fail('Select a clean rollback-journal format SQLite copy. WAL-mode file headers cannot be opened as snapshots.');
  const source = { name: path.basename(actual), bytes: image.byteLength,
    snapshotSha256: createHash('sha256').update(image).digest('hex'), fileIdentity: sqliteFileIdentity(actual, selected),
    capturedAt: new Date().toISOString(), readOnly: true };
  return { image, source };
}

function inspect(db, sql, values = []) {
  const statement = db.prepare(sql);
  try {
    statement.bind(values);
    const rows = [];
    while (statement.step()) rows.push(statement.get());
    return rows;
  } finally { statement.free(); }
}

function capped(rows, limit, object) {
  if (rows.length > limit) throw fail('The selected SQLite ' + object + ' exceeds the inspection limit.');
  return rows;
}

function sized(value, message) {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > LIMITS.maxResultBytes) throw fail(message);
  return value;
}

function catalog(db) {
  const objects = inspect(db, 'SELECT t.name,t.type,t.ncol,t.wr,t.strict,s.sql IS NOT NULL FROM pragma_table_list t ' +
    'JOIN main.sqlite_schema s ON s.name=t.name COLLATE BINARY AND s.type IN (\'table\',\'view\') ' +
    "WHERE t.schema='main' AND t.type IN ('table','view','virtual') AND substr(t.name,1,7)!='sqlite_' " +
    'ORDER BY t.name COLLATE NOCASE,t.name COLLATE BINARY LIMIT ' + (catalogLimit + 1));
  return sized({ objects: objects.slice(0, catalogLimit).map(([name, kind, columns, noRowid, strict, hasSource]) =>
    ({ name, kind, columns, withoutRowid: Boolean(noRowid), strict: Boolean(strict), hasSource: Boolean(hasSource) })),
    truncated: objects.length > catalogLimit }, 'The SQLite catalog names exceed the result size limit.');
}

function describe(db, requested) {
  if (typeof requested !== 'string' || !requested || requested.includes('\0') || Buffer.byteLength(requested, 'utf8') > 4096) {
    throw fail('Choose one observed SQLite table or view.');
  }
  const rows = inspect(db, 'SELECT s.name,t.type,s.sql,t.wr,t.strict FROM main.sqlite_schema s JOIN pragma_table_list t ON t.name=s.name COLLATE BINARY ' +
    "WHERE t.schema='main' AND s.name=? COLLATE BINARY AND s.type IN ('table','view') AND t.type IN ('table','view','virtual') " +
    "AND substr(s.name,1,7)!='sqlite_' LIMIT 2", [requested]);
  if (rows.length !== 1 || rows[0][0] !== requested) throw fail('The exact SQLite object is not visible in this snapshot.');
  const [name, kind, source, withoutRowid, strict] = rows[0];
  const columns = capped(inspect(db, 'SELECT cid,name,type,"notnull",dflt_value,pk,hidden FROM pragma_table_xinfo(?,\'main\') ' +
    'ORDER BY cid LIMIT ' + (catalogLimit + 1), [name]), catalogLimit, 'column list').map(([ordinal, field, type, notNull, defaultSql, primaryKeyOrder, hidden]) =>
    ({ ordinal, name: field, type, notNull: Boolean(notNull), defaultSql, primaryKeyOrder,
      generated: hidden === 2 ? 'virtual' : hidden === 3 ? 'stored' : null, hidden: hidden === 1 }));
  const indexes = capped(inspect(db, 'SELECT name,"unique",origin,partial FROM pragma_index_list(?,\'main\') ' +
    'ORDER BY name COLLATE BINARY LIMIT ' + (indexLimit + 1), [name]), indexLimit, 'index list').map(([index, unique, origin, partial]) => {
    const parts = capped(inspect(db, 'SELECT seqno,cid,name,"desc",coll,"key" FROM pragma_index_xinfo(?,\'main\') ' +
      'ORDER BY seqno LIMIT ' + (catalogLimit + 1), [index]), catalogLimit, 'index column list').map(([ordinal, cid, field, desc, collation, key]) =>
      ({ ordinal, column: field, term: cid === -2 ? 'expression' : cid === -1 ? 'rowid' : 'column', descending: Boolean(desc), collation, key: Boolean(key) }));
    const definition = inspect(db, "SELECT sql FROM main.sqlite_schema WHERE name=? COLLATE BINARY AND type='index' LIMIT 1", [index])[0]?.[0];
    return { name: index, unique: Boolean(unique), origin, partial: Boolean(partial), columns: parts, source: definition ?? null };
  });
  const foreignKeys = capped(inspect(db, 'SELECT id,seq,"table","from","to",on_update,on_delete,"match" FROM pragma_foreign_key_list(?,\'main\') ' +
    'ORDER BY id,seq LIMIT ' + (catalogLimit + 1), [name]), catalogLimit, 'foreign key list').map(([id, ordinal, table, from, to, onUpdate, onDelete, match]) =>
    ({ id, ordinal, table, from, to, onUpdate, onDelete, match }));
  return sized({ name, kind, source, withoutRowid: Boolean(withoutRowid), strict: Boolean(strict), columns, indexes, foreignKeys },
    'The selected SQLite metadata exceeds the result size limit.');
}

function prepareQuery(db, sql) {
  if (typeof sql !== 'string' || !sql.trim() || sql.includes('\0') || Buffer.byteLength(sql, 'utf8') > LIMITS.maxSqlBytes) {
    throw fail('Enter SQL without NUL, up to 64 KiB.');
  }
  sqliteReadQuery(sql);
  return prepareOne(db, sql, 'Review exactly one SQLite statement.');
}

function review(db, sql) {
  const statement = prepareQuery(db, sql);
  try {
    const columns = statement.getColumnNames();
    if (!columns.length || columns.length > LIMITS.maxColumns) throw fail('A reviewed SQLite query requires 1–128 output columns.');
    const planStatement = db.prepare('EXPLAIN QUERY PLAN ' + skipTrivia(statement.getSQL()));
    try {
      const plan = [];
      while (plan.length < 51 && planStatement.step()) {
        const [id, parent, , detail] = planStatement.get();
        plan.push({ id, parent, detail });
      }
      return sized({ columns, plan: plan.slice(0, 50), planTruncated: plan.length > 50 }, 'The SQLite plan exceeds the result size limit.');
    } finally { planStatement.free(); }
  } finally { statement.free(); }
}

function exactCell(value, statement, index) {
  if (value === null) return [null, 'NULL'];
  if (typeof value === 'bigint') return [String(value), 'INTEGER'];
  if (typeof value === 'number') return [Object.is(value, -0) ? '-0' : Number.isFinite(value) ? value : String(value), 'REAL'];
  const text = typeof value === 'string';
  const bytes = text ? statement.getBlob(index) : value;
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > LIMITS.maxCellBytes) throw fail('A SQLite result cell exceeds 128 KiB.');
  if (text) {
    try { return [utf8Text.decode(bytes), 'TEXT']; }
    catch { return ['0x' + Buffer.from(bytes).toString('hex'), 'TEXT_BYTES']; }
  }
  return ['0x' + Buffer.from(bytes).toString('hex'), 'BLOB'];
}

function execute(db, sql, maxRows) {
  if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > LIMITS.maxRows) throw fail('Invalid SQLite result row limit.');
  const started = performance.now(), statement = prepareQuery(db, sql);
  try {
    const columns = statement.getColumnNames();
    if (!columns.length || columns.length > LIMITS.maxColumns) throw fail('A reviewed SQLite query requires 1–128 output columns.');
    let bytes = Buffer.byteLength(JSON.stringify(columns), 'utf8');
    if (bytes > LIMITS.maxResultBytes) throw fail('SQLite result columns exceed the size limit.');
    const rows = [], sqliteStorageClasses = [];
    let truncated = false;
    while (statement.step()) {
      if (rows.length === maxRows) { truncated = true; break; }
      const cells = statement.get(null, { useBigInt: true }).map((value, index) => exactCell(value, statement, index));
      const values = cells.map(([value]) => value), types = cells.map(([, kind]) => kind);
      bytes += Buffer.byteLength(JSON.stringify([values, types]), 'utf8');
      if (bytes > LIMITS.maxResultBytes) { truncated = true; break; }
      rows.push(values);
      sqliteStorageClasses.push(types);
    }
    return { columns, rows, sqliteStorageClasses, rowCount: rows.length, truncated, durationMs: performance.now() - started };
  } finally { statement.free(); }
}

async function serveSqliteFile(port, SQL, file) {
  const { image, source } = await readSnapshot(file);
  const db = new SQL.Database(image);
  db.run('PRAGMA temp_store=MEMORY; PRAGMA hard_heap_limit=67108864; PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;');
  const [[version, sourceId]] = inspect(db, 'SELECT sqlite_version(),sqlite_source_id()');
  const [[schemaVersion]] = inspect(db, 'PRAGMA schema_version');
  port.on('message', ({ type, id, sql, name, maxRows }) => {
    try {
      let result;
      switch (type) {
        case 'catalog': result = catalog(db); break;
        case 'describe': result = describe(db, name); break;
        case 'review': result = review(db, sql); break;
        case 'execute': result = execute(db, sql, maxRows); break;
        default: throw fail('Unknown SQLite file operation.');
      }
      port.postMessage({ id, result });
    } catch (error) { port.postMessage({ id, error: String(error.message || error).slice(0, 700) }); }
  });
  port.postMessage({ type: 'ready', source: { ...source, version, sourceId, schemaVersion } });
}

module.exports = { serveSqliteFile };
