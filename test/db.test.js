'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseService, LIMITS } = require('../src/db/service');

async function withDatabase(run) {
  const service = new DatabaseService();
  try { await run(service); } finally { await service.dispose(); }
}

test('demo exposes deterministic schema, joins and aggregates', async () => withDatabase(async (service) => {
  const schema = await service.schema();
  assert.deepEqual(schema.map((table) => table.name), ['people', 'projects', 'tasks']);
  assert.deepEqual(schema[0].columns[0], { name: 'id', type: 'INTEGER', primaryKey: true });
  const result = await service.query(`
    SELECT p.name AS project, count(t.id) AS task_count
    FROM projects p JOIN tasks t ON t.project_id = p.id
    GROUP BY p.id ORDER BY p.id
  `);
  assert.deepEqual(result.columns, ['project', 'task_count']);
  assert.deepEqual(result.rows, [['Rocketbrain', 5], ['Catalog API', 3], ['Design System', 2]]);
  assert.equal(result.rowCount, 3);
  assert.equal(result.truncated, false);
  assert.ok(result.durationMs >= 0);
}));

test('connection read-only enforcement rejects writes including WITH ... DML', async () => withDatabase(async (service) => {
  for (const sql of [
    "UPDATE tasks SET title = 'changed' WHERE id = 1",
    'DROP TABLE tasks',
    'PRAGMA query_only = OFF',
    "ATTACH DATABASE 'demo.sqlite' AS other",
    'WITH selected AS (SELECT 1) DELETE FROM tasks',
    "WITH selected AS (SELECT 1) UPDATE tasks SET title = 'changed' RETURNING title",
    "WITH selected AS (SELECT 1) INSERT INTO tasks(id,project_id,title,status,priority) VALUES (99,1,'x','open',1)",
  ]) {
    await assert.rejects(service.query(sql), /read.?only|readonly/i, sql);
  }
  assert.deepEqual((await service.query('SELECT count(*) FROM tasks')).rows, [[10]]);
  assert.equal((await service.query('SELECT title FROM tasks WHERE id = 1')).rows[0][0], 'Build the Spring service');
}));

test('SQLite statement boundary rejects multiple statements before execution', async () => withDatabase(async (service) => {
  for (const sql of [
    'SELECT 1; SELECT 2',
    "SELECT ';' AS text; /* separation */ DELETE FROM tasks",
    'SELECT 1; PRAGMA query_only = OFF',
    'SELECT 1; /* comment */ WITH x AS (SELECT 1) DELETE FROM tasks',
  ]) await assert.rejects(service.query(sql), /one SQL statement/i);
  assert.deepEqual((await service.query("/* hello */ SELECT ';SELECT 2' AS text; -- trailing\n /* fine */ ;")).rows, [[';SELECT 2']]);
  assert.deepEqual((await service.query('SELECT count(*) FROM tasks')).rows, [[10]]);
}));

test('cell data is returned verbatim, including HTML and SQL-looking content', async () => withDatabase(async (service) => {
  const result = await service.query('SELECT title FROM tasks WHERE id = 10');
  assert.deepEqual(result.rows, [['<img src=x onerror=alert(1)>; DROP TABLE tasks; --']]);
  assert.deepEqual((await service.query("SELECT NULL AS empty, X'CAFE' AS binary")).rows, [[null, '0xcafe']]);
}));

test('row, SQL, column, cell and result-byte limits are enforced', async () => withDatabase(async (service) => {
  const result = await service.query('SELECT id FROM tasks ORDER BY id', { maxRows: 3 });
  assert.deepEqual(result.rows, [[1], [2], [3]]);
  assert.equal(result.rowCount, 3);
  assert.equal(result.truncated, true);
  assert.equal((await service.query('SELECT id FROM tasks ORDER BY id LIMIT 3', { maxRows: 3 })).truncated, false);
  await assert.rejects(service.query('SELECT 1', { maxRows: LIMITS.maxRows + 1 }), /maxRows/);
  await assert.rejects(service.query(`SELECT '${'x'.repeat(LIMITS.maxSqlBytes)}'`), /UTF-8 bytes/);
  await assert.rejects(service.query('SELECT 1\0; SELECT 2'), /NUL/);
  await assert.rejects(service.query(`SELECT ${Array.from({ length: 129 }, (_, i) => `${i} AS c${i}`).join(',')}`), /128 columns/);
  await assert.rejects(service.query('SELECT hex(zeroblob(70000))'), /cell exceeds/);
  await assert.rejects(service.query('SELECT zeroblob(1000000000)'), /out of memory|too big/i);
  assert.deepEqual((await service.query('SELECT count(*) FROM tasks')).rows, [[10]]);
  const bytes = await service.query(`WITH RECURSIVE x(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM x WHERE n<50)
    SELECT hex(zeroblob(60000)) FROM x`, { maxRows: 50 });
  assert.equal(bytes.truncated, true);
  assert.ok(bytes.rowCount > 0 && bytes.rowCount < 50);
  assert.ok(Buffer.byteLength(JSON.stringify(bytes.rows)) <= LIMITS.maxResultBytes);
}));

test('SQL cannot access host files or load extensions', async () => withDatabase(async (service) => {
  await assert.rejects(service.query("SELECT readfile('C:/Windows/win.ini')"), /no such function|not authorized/i);
  await assert.rejects(service.query("SELECT writefile('demo.txt', 'changed')"), /no such function|not authorized/i);
  await assert.rejects(service.query("SELECT load_extension('anything')"), /no such function|not authorized/i);
}));

test('expensive query times out off-thread, then the demo recovers', async () => withDatabase(async (service) => {
  await service.schema();
  let heartbeat = false;
  const heartbeatTimer = setTimeout(() => { heartbeat = true; }, 5);
  await assert.rejects(service.query(`WITH RECURSIVE x(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM x)
    SELECT sum(n) FROM x`, { timeoutMs: 50 }), /timed out/);
  clearTimeout(heartbeatTimer);
  assert.equal(heartbeat, true);
  assert.deepEqual((await service.query('SELECT count(*) FROM tasks')).rows, [[10]]);
}));

test('errors, queued requests and disposal have predictable results', async () => {
  const service = new DatabaseService();
  try {
    await assert.rejects(service.query('SELECT missing FROM tasks'), /no such column/);
    assert.deepEqual(await Promise.all([
      service.query('SELECT 1 AS n').then((r) => r.rows),
      service.query('SELECT 2 AS n').then((r) => r.rows),
    ]), [[[1]], [[2]]]);
  } finally {
    await service.dispose();
  }
  await service.dispose();
  await assert.rejects(service.query('SELECT 1'), /disposed/);
  await assert.rejects(service.schema(), /disposed/);
});
