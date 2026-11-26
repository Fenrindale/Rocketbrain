'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { performance } = require('node:perf_hooks');
const fs = require('node:fs');
const path = require('node:path');
const initSqlJs = require('sql.js');
const LIMITS = require('./limits');
const { skipTrivia, prepareOne } = require('./sqlite-read');

let database;

function seed(SQL) {
  const db = new SQL.Database();
  db.run(`
    PRAGMA foreign_keys = ON;
    PRAGMA temp_store = MEMORY;
    PRAGMA hard_heap_limit = 33554432;
    CREATE TABLE people (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      email TEXT NOT NULL
    );
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      owner_id INTEGER NOT NULL REFERENCES people(id),
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id),
      assignee_id INTEGER REFERENCES people(id),
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      priority INTEGER NOT NULL,
      estimate_hours REAL,
      due_date TEXT
    );
    INSERT INTO people VALUES
      (1, 'Alex Kim', 'Backend Engineer', 'alex@example.test'),
      (2, 'Mina Park', 'Database Engineer', 'mina@example.test'),
      (3, 'Sam Lee', 'Product Designer', 'sam@example.test'),
      (4, 'Robin Chen', 'QA Engineer', 'robin@example.test');
    INSERT INTO projects VALUES
      (1, 'Rocketbrain', 1, 'active', '2026-11-01'),
      (2, 'Catalog API', 2, 'active', '2026-10-15'),
      (3, 'Design System', 3, 'review', '2026-09-20');
  `);
  const statement = db.prepare('INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const tasks = [
    [1, 1, 1, 'Build the Spring service', 'in_progress', 1, 8, '2026-11-16'],
    [2, 1, 2, 'Review the query console', 'in_progress', 1, 5, '2026-11-17'],
    [3, 1, 3, 'Refine keyboard navigation', 'open', 2, 3, '2026-11-18'],
    [4, 1, 4, 'Verify read-only execution', 'done', 1, 4, '2026-11-12'],
    [5, 2, 1, 'Add catalog search', 'open', 2, 6, '2026-11-20'],
    [6, 2, 2, 'Inspect composite indexes', 'review', 1, 3.5, '2026-11-19'],
    [7, 2, 4, 'Test pagination boundaries', 'open', 2, 2, null],
    [8, 3, 3, 'Publish spacing tokens', 'done', 3, 2, '2026-11-10'],
    [9, 3, null, 'Document accessible focus', 'open', 2, null, null],
    [10, 1, 4, '<img src=x onerror=alert(1)>; DROP TABLE tasks; --', 'open', 3, 1, null],
  ];
  try {
    for (const task of tasks) statement.run(task);
  } finally {
    statement.free();
  }
  // The SQLite connection enforces read-only execution, including WITH ... DML.
  db.run('PRAGMA query_only = ON;');
  return db;
}

function validateQuery(sql, maxRows) {
  if (typeof sql !== 'string' || sql.includes('\0') || Buffer.byteLength(sql, 'utf8') > LIMITS.maxSqlBytes) {
    throw new Error('Invalid or oversized demo SQL.');
  }
  if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > LIMITS.maxRows) {
    throw new Error('Invalid demo row limit.');
  }
  const keyword = /^[A-Za-z]+/.exec(skipTrivia(sql))?.[0].toUpperCase();
  if (!['SELECT', 'WITH', 'VALUES'].includes(keyword)) {
    throw new Error('The demo database is read-only. Use one SELECT, WITH, or VALUES query.');
  }
}

function serializeCell(value) {
  if (value instanceof Uint8Array) {
    if (value.byteLength > LIMITS.maxCellBytes / 2) throw new Error('A demo result cell exceeds the 128 KiB limit.');
    return `0x${Buffer.from(value).toString('hex')}`;
  }
  if (typeof value === 'string' && Buffer.byteLength(value, 'utf8') > LIMITS.maxCellBytes) {
    throw new Error('A demo result cell exceeds the 128 KiB limit.');
  }
  return value;
}

function query(sql, maxRows) {
  validateQuery(sql, maxRows);
  const started = performance.now();
  database.run('PRAGMA query_only = ON;');
  // SQLite determines the first statement boundary before any second statement is prepared.
  const statement = prepareOne(database, sql, 'Only one SQL statement can run at a time in the demo database.');
  try {
    const columns = statement.getColumnNames();
    if (!columns.length) {
      // A WITH ... UPDATE/DELETE has no columns but must still meet SQLite's
      // connection-level read-only check rather than pass a keyword filter.
      statement.step();
      throw new Error('Only read-only result queries are supported in the demo database.');
    }
    if (columns.length > LIMITS.maxColumns) throw new Error('Demo results support at most 128 columns.');
    let bytes = Buffer.byteLength(JSON.stringify(columns), 'utf8');
    if (bytes > LIMITS.maxResultBytes) throw new Error('Demo result column names exceed the size limit.');
    const rows = [];
    let truncated = false;
    while (statement.step()) {
      if (rows.length === maxRows) {
        truncated = true;
        break;
      }
      const row = statement.get().map(serializeCell);
      const rowBytes = Buffer.byteLength(JSON.stringify(row), 'utf8');
      if (bytes + rowBytes > LIMITS.maxResultBytes) {
        truncated = true;
        break;
      }
      bytes += rowBytes;
      rows.push(row);
    }
    return { columns, rows, rowCount: rows.length, truncated, durationMs: performance.now() - started };
  } finally {
    statement.free();
  }
}

function schema() {
  const names = database.exec("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")[0];
  return (names?.values || []).map(([name]) => {
    const statement = database.prepare('SELECT name, type, pk FROM pragma_table_info(?) ORDER BY cid');
    const columns = [];
    try {
      statement.bind([name]);
      while (statement.step()) {
        const [columnName, type, primaryKey] = statement.get();
        columns.push({ name: columnName, type, primaryKey: Boolean(primaryKey) });
      }
    } finally {
      statement.free();
    }
    return { name, columns };
  });
}

(async () => {
  try {
    const adjacentWasm = path.join(__dirname, 'sql-wasm.wasm');
    const wasmPath = fs.existsSync(adjacentWasm) ? adjacentWasm : require.resolve('sql.js/dist/sql-wasm.wasm');
    const SQL = await initSqlJs({ locateFile: () => wasmPath });
    if (workerData?.mode === 'sqlite-file') {
      await require('./sqlite-file-worker').serveSqliteFile(parentPort, SQL, workerData.file);
      return;
    }
    database = seed(SQL);
    parentPort.on('message', (message) => {
      try {
        const result = message.type === 'schema' ? schema()
          : message.type === 'query' ? query(message.sql, message.maxRows)
            : (() => { throw new Error('Unknown demo database operation.'); })();
        parentPort.postMessage({ id: message.id, result });
      } catch (error) {
        parentPort.postMessage({ id: message.id, error: String(error.message || error) });
      }
    });
    parentPort.postMessage({ type: 'ready' });
  } catch (error) {
    parentPort.postMessage({ type: 'fatal', error: String(error.message || error) });
    parentPort.close();
  }
})();
