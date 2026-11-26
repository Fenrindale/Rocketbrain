'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { DatabaseSync } = require('node:sqlite');
const pin = require('./sqlite-edit-pin');
const { SQLITE_FILE_LIMIT, SQLITE_MAGIC, sqliteFileIdentity, hash } = require('./sqlite-local-file');
const { integer, normalizeCell, binding, valueLimit, acceptsCell, cellUpdateSql, quoteIdentifier: q } = require('./sqlite-edit-values');

const fail = (code, message) => Object.assign(Error(message), { code });
const identityPattern = /^[a-f0-9]{64}$/u;
const ordinaryPath = value => typeof value === 'string' && value.length <= 4096 && /^[A-Za-z]:[\\/][^:\x00-\x1f]+$/u.test(value);
const supportedTypes = new Set(['INTEGER', 'REAL', 'TEXT', 'BLOB', 'ANY']);
const maxSchemaObjects = 256, maxColumns = 32, maxRowBytes = 512 * 1024;
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const fold = value => value.replace(/[A-Z]/gu, character => character.toLowerCase());
const ordinaryName = value => typeof value === 'string' && value.isWellFormed() && value.length > 0 && value.length <= 128 &&
  !/[\x00-\x1f\x7f]/u.test(value) && !/^sqlite_/iu.test(value);

function assertFile(file, expected, { checkJournal = true } = {}) {
  if (!ordinaryPath(file) || !identityPattern.test(expected || '')) throw fail('FILE', 'Open a previously selected local SQLite snapshot.');
  const actual = fs.realpathSync(file);
  if (!ordinaryPath(actual)) throw fail('FILE', 'Select a regular local Windows SQLite file.');
  const handle = fs.openSync(actual, 'r');
  try {
    const stat = fs.fstatSync(handle, { bigint: true });
    if (!stat.isFile() || stat.size < 100n || stat.size > BigInt(SQLITE_FILE_LIMIT) || sqliteFileIdentity(actual, stat) !== expected ||
        sqliteFileIdentity(actual, fs.statSync(actual, { bigint: true })) !== expected) {
      throw fail('FILE', 'The selected SQLite file identity changed. Open the current file before editing.');
    }
    const header = Buffer.alloc(100);
    if (fs.readSync(handle, header, 0, header.length, 0) !== header.length || !header.subarray(0, 16).equals(SQLITE_MAGIC) ||
        header[18] !== 1 || header[19] !== 1) throw fail('FILE', 'Choose an ordinary rollback-journal SQLite 3 file.');
  } finally { fs.closeSync(handle); }
  const suffixes = checkJournal ? ['-wal', '-shm', '-journal'] : ['-wal', '-shm'];
  for (const suffix of suffixes) {
    if (fs.lstatSync(actual + suffix, { throwIfNoEntry: false })) {
      throw fail('JOURNAL', 'The SQLite file has an active or retained journal sidecar. Finish other writes and review the clean file again.');
    }
  }
  return actual;
}

function schema(db, table) {
  if (!ordinaryName(table)) throw fail('SCOPE', 'Choose an exact ordinary SQLite table name.');
  const entries = db.prepare('SELECT type,name,tbl_name,rootpage,sql FROM main.sqlite_schema ORDER BY type,name COLLATE BINARY LIMIT 257').all();
  if (entries.length > maxSchemaObjects || Buffer.byteLength(JSON.stringify(entries), 'utf8') > maxRowBytes) {
    throw fail('SCOPE', 'The SQLite schema is above the bounded editor inventory.');
  }
  const entry = entries.find(item => item.type === 'table' && item.name === table);
  const model = db.prepare("SELECT type,strict FROM pragma_table_list WHERE schema='main' AND name=? COLLATE BINARY").get(table);
  if (!entry?.sql || !entry.rootpage || model?.type !== 'table' || entries.some(item => item.type === 'trigger' && fold(item.tbl_name) === fold(table))) {
    throw fail('SCOPE', 'Select an ordinary SQLite base table without triggers.');
  }
  const columns = db.prepare('SELECT cid,name,type,"notnull" AS required,pk,hidden FROM pragma_table_xinfo(?,\'main\') ORDER BY cid LIMIT 33').all(table);
  const keys = columns.filter(column => column.pk);
  if (!columns.length || columns.length > maxColumns || columns.some(column => column.hidden || !ordinaryName(column.name)) ||
      keys.length !== 1 || keys[0].type.toUpperCase() !== 'INTEGER') {
    throw fail('SCOPE', 'Select a table with one INTEGER primary key and at most 32 ordinary, non-generated columns.');
  }
  const excluded = new Set();
  const foreign = db.prepare('SELECT "table","from","to" FROM pragma_foreign_key_list(?,\'main\') LIMIT 257');
  for (const item of entries.filter(value => value.type === 'table' && value.rootpage > 0 && !/^sqlite_/iu.test(value.name))) {
    const references = foreign.all(item.name);
    if (references.length > 256) throw fail('SCOPE', 'The SQLite foreign-key inventory exceeds the edit scope.');
    for (const ref of references) {
      if (item.name === table) excluded.add(fold(ref.from));
      if (fold(ref.table) === fold(table) && ref.to) excluded.add(fold(ref.to));
    }
  }
  const encoding = db.prepare('PRAGMA main.encoding').get().encoding;
  if (!['UTF-8', 'UTF-16le', 'UTF-16be'].includes(encoding)) throw fail('SCOPE', 'The SQLite text encoding is unsupported.');
  const typed = columns.map(column => {
    const type = column.type.toUpperCase();
    return { name: column.name, type, primaryKey: Boolean(column.pk), nullable: !column.pk && !column.required,
      editable: !column.pk && supportedTypes.has(type) && (type !== 'ANY' || Boolean(model.strict)) && !excluded.has(fold(column.name)) };
  });
  if (!typed.some(column => column.editable)) throw fail('SCOPE', 'This SQLite table has no supported non-key editable columns.');
  const version = db.prepare('PRAGMA main.schema_version').get().schema_version;
  return { table, keyColumn: keys[0].name, columns: typed, encoding, schemaFingerprint: hash(JSON.stringify([version, encoding, entries])) };
}

function encode(type, value, decoder) {
  if (type === 'null') return { kind: 'NULL', value: null };
  if (type === 'integer' && typeof value === 'bigint') return { kind: 'INTEGER', value: value.toString() };
  if (type === 'real' && typeof value === 'number' && Number.isFinite(value)) return { kind: 'REAL', value: Object.is(value, -0) ? '-0' : String(value) };
  if (value instanceof Uint8Array && value.length <= valueLimit) {
    if (type === 'blob') return { kind: 'BLOB', value: Buffer.from(value).toString('hex') };
    if (type === 'text') {
      try { return normalizeCell({ kind: 'TEXT', value: decoder.decode(value) }); }
      catch { throw fail('SCOPE', 'The SQLite row contains text without an exact supported encoding.'); }
    }
  }
  throw fail('SCOPE', 'The SQLite row contains a value outside the exact cell review bounds.');
}

function readRow(db, model, key) {
  const fields = model.columns.map(column => {
    const id = q(column.name);
    return 'typeof(' + id + '), CASE WHEN typeof(' + id + ")='text' THEN CAST(" + id + ' AS BLOB) ELSE ' + id + ' END';
  });
  const statement = db.prepare('SELECT ' + fields.join(', ') + ' FROM main.' + q(model.table) + ' WHERE ' + q(model.keyColumn) + '=? LIMIT 2');
  statement.setReadBigInts(true);
  statement.setReturnArrays(true);
  const records = statement.all(BigInt(key));
  if (records.length !== 1) throw fail('ROW', 'The exact reviewed primary key does not identify one live SQLite row.');
  const decoder = new TextDecoder(model.encoding, { fatal: true, ignoreBOM: true });
  const cells = model.columns.map((_, index) => encode(...records[0].slice(index * 2, index * 2 + 2), decoder));
  const image = JSON.stringify(cells);
  if (Buffer.byteLength(image, 'utf8') > maxRowBytes) throw fail('SCOPE', 'The SQLite row exceeds the exact review size bound.');
  return { cells, rowFingerprint: hash(image) };
}

function apply(db, model, observed, request) {
  if (request.schemaFingerprint !== model.schemaFingerprint || request.rowFingerprint !== observed.rowFingerprint) {
    throw fail('STALE', 'The reviewed SQLite schema or row changed. Inspect the current row again.');
  }
  const slot = model.columns.findIndex(column => column.name === request.column);
  const column = model.columns[slot], replacement = normalizeCell(request.replacement);
  if (!acceptsCell(column, replacement) || same(observed.cells[slot], replacement)) {
    throw fail('VALUE', 'Choose one different value in the reviewed column storage type or an allowed SQL NULL.');
  }
  const expected = [...observed.cells];
  expected[slot] = replacement;
  const statement = db.prepare(cellUpdateSql(model.table, column.name, model.keyColumn));
  const result = statement.run(binding(replacement), BigInt(request.key));
  if (Number(result.changes) !== 1 || !same(readRow(db, model, request.key).cells, expected)) {
    throw fail('POSTCONDITION', 'The SQLite storage type or full row did not match the review. The edit was rolled back.');
  }
  return { state: 'applied', changedRows: 1, table: model.table, key: request.key, column: column.name, value: replacement };
}

function operation(request) {
  if (!['observe', 'apply'].includes(request?.operation)) throw fail('SCOPE', 'Choose a typed SQLite cell operation.');
  const editing = request.operation === 'apply';
  if (editing && request.approved !== true) throw fail('REVIEW', 'Approve the exact SQLite cell review first.');
  const key = integer(request.key);
  const actual = assertFile(request.file, request.fileIdentity);
  const uri = pathToFileURL(actual);
  uri.searchParams.set('mode', editing ? 'rw' : 'ro');
  const db = new DatabaseSync(uri.href, { timeout: 0, readOnly: !editing, allowExtension: false, enableForeignKeyConstraints: true });
  try {
    if (assertFile(db.location('main'), request.fileIdentity) !== actual) throw fail('FILE', 'SQLite opened a different file than the selected snapshot.');
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY; PRAGMA hard_heap_limit=67108864;');
    if (editing) db.exec('PRAGMA synchronous=FULL;');
    db.exec(editing ? 'BEGIN IMMEDIATE' : 'BEGIN');
    assertFile(actual, request.fileIdentity);
    if (db.prepare('PRAGMA main.journal_mode').get().journal_mode !== 'delete' || !db.prepare('PRAGMA foreign_keys').get().foreign_keys) {
      throw fail('JOURNAL', 'The SQLite editor requires DELETE journaling and verified foreign-key enforcement.');
    }
    const model = schema(db, request.table), before = readRow(db, model, key);
    if (!editing) return { ...model, ...before, key };
    const result = apply(db, model, before, { ...request, key });
    assertFile(actual, request.fileIdentity, { checkJournal: false });
    try { db.exec('COMMIT'); }
    catch (error) {
      if ((error.errcode & 0xff) === 5 && db.isTransaction) throw error;
      throw fail('UNKNOWN', 'The SQLite commit outcome could not be confirmed. Reopen the file and inspect the cell before another edit.');
    }
    return result;
  } finally {
    try { if (db.isTransaction) db.exec('ROLLBACK'); }
    catch { throw fail('UNKNOWN', 'SQLite could not confirm rollback. Reopen the file and inspect the cell.'); }
    finally {
      try { db.close(); }
      catch (error) {
        if (editing) throw fail('UNKNOWN', 'SQLite could not confirm connection teardown. Reopen the file and inspect the exact cell.');
        throw error;
      }
    }
  }
}

function errorReport(error) {
  if ((error.errcode & 0xff) === 5 || (error.errcode & 0xff) === 6) return { code: 'BUSY', message: 'SQLite reported SQLITE_BUSY or SQLITE_LOCKED. Finish the competing transaction and prepare a fresh review.', sqliteCode: error.errcode & 0xff };
  if ((error.errcode & 0xff) === 19) return { code: 'CONSTRAINT', message: 'SQLite rejected the cell constraint. The edit was rolled back.' };
  const known = ['FILE', 'JOURNAL', 'SCOPE', 'ROW', 'STALE', 'VALUE', 'POSTCONDITION', 'REVIEW', 'UNKNOWN', 'RUNTIME'];
  if (known.includes(error.code)) return { code: error.code, message: error.message };
  if (['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) return { code: 'FILE', message: 'The reviewed SQLite file is missing or unavailable.' };
  return { code: 'ENGINE', message: 'SQLite could not complete the typed file operation.', ...(Number.isInteger(error.errcode) && { sqliteCode: error.errcode }) };
}

try {
  if (process.platform !== pin.platform || process.arch !== pin.arch || process.version !== pin.node || process.versions.sqlite !== pin.sqlite) {
    throw fail('RUNTIME', 'The pinned Node.js SQLite runtime did not match the approved release.');
  }
  const bytes = fs.readFileSync(0);
  if (bytes.length > 256 * 1024) throw fail('VALUE', 'The SQLite cell request exceeds its size limit.');
  const result = operation(JSON.parse(bytes.toString('utf8')));
  process.stdout.write(JSON.stringify({ result }));
} catch (error) { process.stdout.write(JSON.stringify({ error: errorReport(error) })); }
