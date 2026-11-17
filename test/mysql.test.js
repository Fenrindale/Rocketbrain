'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { MysqlService, validateReadQuery, validateQuery } = require('../src/db/mysql');
const config = { host: 'localhost', port: 3306, user: 'reader', password: 'never-log-this', database: "app's db" };

// These lifecycle tests use a deliberately small fake protocol. Actual SQL
// semantics/server state are independently tested in mysql.integration.test.js.
function fakeServer(behaviors = []) {
  const connections = [];
  function createConnection(options) {
    const behavior = behaviors.shift() || {};
    const c = new EventEmitter();
    c.options = options; c.calls = []; c.destroyed = false; c.status = 2; c.threadId = connections.length + 10;
    c.connect = callback => queueMicrotask(() => callback(behavior.connectError));
    c.destroy = () => { c.destroyed = true; };
    const stream = (request, protocol) => {
      c.calls.push({ ...request, protocol });
      const q = new EventEmitter();
      queueMicrotask(() => {
        if (c.destroyed) return;
        const response = behavior.resolve?.(request.sql, request.values, c) || behavior;
        if (response.hang) return;
        if (response.error) { q.emit('error', response.error); return; }
        if (/^(INSERT|UPDATE|DELETE|REPLACE)/i.test(request.sql) && !(c.status & 2)) c.status |= 1;
        if (/^(ALTER|CREATE TABLE|DROP TABLE|TRUNCATE)/i.test(request.sql)) c.status &= ~1;
        if (response.header || /^(INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|TRUNCATE|SET)/i.test(request.sql)) {
          q.emit('fields', undefined);
          q.emit('result', { affectedRows: 1, warningStatus: 0, serverStatus: c.status, ...(response.header || {}) });
        } else {
          q.emit('fields', (response.columns || ['id', 'name']).map(name => ({ name })));
          for (const row of response.rows || [[1, '<img src=x onerror=alert(1)>'], [2, null]]) {
            if (c.destroyed) break;
            q.emit('result', row);
          }
        }
        if (!c.destroyed) q.emit('end');
      });
      return q;
    };
    c.query = (request, callback) => {
      if (typeof request !== 'string') return stream(request, 'query');
      c.calls.push({ sql: request, protocol: 'control' });
      queueMicrotask(() => {
        const error = behavior.controlError?.(request, c);
        if (error) { callback(error); return; }
        if (request.startsWith('START TRANSACTION')) c.status |= 1;
        if (['COMMIT', 'ROLLBACK'].includes(request)) c.status &= ~1;
        if (request === 'SET SESSION autocommit = 0') c.status &= ~2;
        if (request === 'SET SESSION autocommit = 1') c.status |= 2;
        callback(null, { affectedRows: 0, serverStatus: c.status });
      });
    };
    c.execute = request => stream(request, 'execute');
    connections.push(c); return c;
  }
  return { createConnection, connections };
}
async function withService(server, action) {
  const service = new MysqlService(config, server);
  try { return await action(service); } finally { await service.dispose(); }
}
async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setImmediate(resolve)); }
  assert.fail('Expected asynchronous operation did not start');
}

test('policy accepts read CTEs, EXPLAIN, system variables, quoted names and literal semicolons', () => {
  for (const sql of [
    "SELECT t.id FROM tasks t WHERE t.name='O''Brien; DELETE';",
    'WITH active AS (SELECT id FROM tasks) SELECT * FROM active',
    'EXPLAIN SELECT * FROM tasks', 'SELECT @@autocommit',
    'SELECT ' + String.fromCharCode(96) + 'update' + String.fromCharCode(96) + ', "delete" FROM tasks; -- note',
    '/* normal */ SELECT 1 # trailing comment',
  ]) assert.equal(validateReadQuery(sql), sql);
});
test('policy refuses mutation, admin, executable comments, file/lock functions and second statements', () => {
  for (const sql of [
    'DELETE FROM tasks', 'WITH rows AS (SELECT 1) DELETE FROM tasks',
    'SELECT 1; DROP TABLE tasks', 'SELECT 1;;', 'SET @x=1', 'CALL mutate()',
    "SELECT 1 INTO OUTFILE '/tmp/output'", "SELECT LOAD_FILE('/etc/passwd')",
    'SELECT ' + String.fromCharCode(96) + 'GET_LOCK' + String.fromCharCode(96) + "('x',1)",
    'SELECT @x:=1', 'SELECT * FROM tasks FOR UPDATE', 'SELECT * FROM tasks FOR SHARE',
    'SELECT * FROM tasks LOCK IN SHARE MODE', '/*!50000 SET @x=1 */ SELECT 1',
    '/*M! SET @x=1 */ SELECT 1', "SELECT 'unterminated", "SELECT 'back\\slash'", 'SELECT 1\0',
  ]) assert.throws(() => validateReadQuery(sql), { code: 'ROCKETBRAIN_READ_ONLY' }, sql);
});
test('write mode permits explicit data/table changes and user variables but guards settings and administration', () => {
  for (const sql of ['UPDATE t SET name=? WHERE id=?', 'CREATE TEMPORARY TABLE t(id int)', 'SET @x=1,@y=2', 'SELECT @x', 'ALTER TABLE t ADD x int']) {
    assert.ok(validateQuery(sql, { readOnly: false }));
  }
  for (const sql of ['COMMIT', 'START TRANSACTION', 'SET autocommit=0', 'SET @x=1,autocommit=0',
    'SET @x=1,' + String.fromCharCode(96) + 'autocommit' + String.fromCharCode(96) + '=0',
    'SET @@transaction_read_only=0', 'CREATE USER x', 'DROP DATABASE x', 'CALL x()', 'LOAD DATA LOCAL INFILE ?', 'SELECT 1; UPDATE t SET x=1']) {
    assert.throws(() => validateQuery(sql, { readOnly: false }), /controls|supported|unavailable|user variable|statement/i, sql);
  }
});
test('constructor and invalid requests remain offline; TLS verification and parameter types are enforced', async () => {
  const server = fakeServer();
  await withService(server, async service => {
    assert.equal(server.connections.length, 0);
    await assert.rejects(service.query('SELECT 1', { maxRows: 0 }), /maxRows/);
    await assert.rejects(service.query('SELECT 1', { timeoutMs: Infinity }), /timeoutMs/);
    await assert.rejects(service.query('SELECT ?', { values: [{ toSqlString: () => 'DROP TABLE t' }] }), /parameters/);
    await assert.rejects(service.query('DELETE FROM tasks'), { code: 'ROCKETBRAIN_READ_ONLY' });
    assert.equal(server.connections.length, 0);
  });
  assert.throws(() => new MysqlService({ ...config, ssl: { rejectUnauthorized: false } }), /verification/);
});
test('one console reuses its pinned connection and reads actual status after each SELECT', async () => {
  const server = fakeServer([{ columns: ['same', 'same'], rows: [[1, null]] }]);
  await withService(server, async service => {
    const first = await service.query('SELECT 1, NULL');
    const second = await service.query('SELECT 2, NULL');
    assert.deepEqual(first.columns, ['same', 'same']); assert.deepEqual(first.rows, [[1, null]]);
    assert.equal(first.state.connectionId, second.state.connectionId);
    assert.equal(server.connections.length, 1); assert.equal(server.connections[0].destroyed, false);
    assert.equal(first.state.autocommit, true); assert.equal(first.state.inTransaction, false);
    assert.deepEqual(server.connections[0].calls.map(call => call.sql), [
      'SET SESSION TRANSACTION READ ONLY', 'DO 0', 'SELECT 1, NULL', 'DO 0', 'SELECT 2, NULL', 'DO 0',
    ]);
    assert.equal(server.connections[0].options.multipleStatements, false);
    assert.equal(server.connections[0].options.flags, '-LOCAL_FILES');
  });
});
test('named consoles isolate connection and mode and serialize work within one console', async () => {
  const server = fakeServer();
  await withService(server, async service => {
    await service.openSession('a'); await service.openSession('b');
    await service.setReadOnly(false, { sessionId: 'a' });
    await Promise.all([service.query('SELECT 1', { sessionId: 'a' }), service.query('SELECT 2', { sessionId: 'a' }), service.query('SELECT 3', { sessionId: 'b' })]);
    assert.notEqual(service.getSessionState('a').connectionId, service.getSessionState('b').connectionId);
    assert.equal(service.getSessionState('b').readOnly, true);
    assert.equal(server.connections.length, 2);
    await assert.rejects(service.query('DELETE FROM t', { sessionId: 'b' }), { code: 'ROCKETBRAIN_READ_ONLY' });
  });
});
test('server rejection of READ ONLY never runs user SQL', async () => {
  const server = fakeServer([{ controlError: sql => sql.startsWith('SET SESSION TRANSACTION') ? { code: 'ER_NOT_SUPPORTED_YET' } : null }]);
  await withService(server, async service => {
    await assert.rejects(service.query('SELECT 1'), /ER_NOT_SUPPORTED_YET/);
    assert.deepEqual(server.connections[0].calls.map(call => call.sql), ['SET SESSION TRANSACTION READ ONLY']);
    assert.equal(service.getSessionState().needsReconnect, true);
  });
});
test('explicit begin/commit/rollback and autocommit use server status, mode changes require an idle transaction', async () => {
  const server = fakeServer();
  await withService(server, async service => {
    assert.equal((await service.begin()).inTransaction, true);
    await assert.rejects(service.setReadOnly(false), /Commit or roll back/);
    await assert.rejects(service.begin(), /Commit or roll back/);
    assert.equal((await service.rollback()).inTransaction, false);
    await service.setReadOnly(false);
    assert.equal((await service.setAutocommit(false)).autocommit, false);
    assert.equal((await service.query('UPDATE t SET x=1')).state.inTransaction, true);
    await assert.rejects(service.setAutocommit(true), /implicitly commit/);
    assert.equal((await service.commit()).inTransaction, false);
    assert.equal(service.getSessionState().autocommit, false);
    assert.equal((await service.setAutocommit(true)).autocommit, true);
  });
});
test('bound values use binary execute, duplicate columns and precision-safe cells survive, DML reports affected rows', async () => {
  const secret = "'; DROP TABLE t; --";
  const server = fakeServer([{ resolve: sql => sql.startsWith('SELECT') ? { columns: ['v', 'v', 'v'], rows: [[null, '9007199254740993', Buffer.from([0, 255])]] } : { header: { affectedRows: 3, warningStatus: 2 } } }]);
  await withService(server, async service => {
    const read = await service.query('SELECT ?, ?, ?', { values: [secret, 9007199254740993n, null] });
    assert.deepEqual(read.rows, [[null, '9007199254740993', '0x00ff']]);
    const request = server.connections[0].calls.find(call => call.protocol === 'execute');
    assert.deepEqual(request.values, [secret, '9007199254740993', null]); assert.ok(!request.sql.includes(secret));
    await service.setReadOnly(false);
    const write = await service.query('UPDATE t SET x=?', { values: [1] });
    assert.equal(write.affectedRows, 3); assert.equal(write.warningCount, 2); assert.equal(write.rowCount, 0);
  });
});
test('DDL implicit commit and errors are followed by an authoritative status probe', async () => {
  const server = fakeServer([{ resolve: (sql, values, c) => {
    if (sql.startsWith('ALTER')) { c.status &= ~1; return { error: { code: 'ER_PARSE_ERROR', message: 'private never-log-this' } }; }
    return {};
  } }]);
  await withService(server, async service => {
    await service.setReadOnly(false); await service.begin();
    await assert.rejects(service.query('ALTER TABLE broken'), error => !error.message.includes('never-log-this'));
    assert.equal(service.getSessionState().inTransaction, false);
    assert.equal(server.connections[0].calls.at(-1).sql, 'DO 0');
    assert.equal(service.getSessionState().needsReconnect, false);
  });
});
test('fatal DML disconnect is never retried and requires explicit reconnect with outcome warning', async () => {
  const server = fakeServer([{ resolve: sql => sql.startsWith('UPDATE') ? { error: { code: 'PROTOCOL_CONNECTION_LOST', fatal: true } } : {} }, { rows: [[7]] }]);
  await withService(server, async service => {
    await service.setReadOnly(false);
    await assert.rejects(service.query('UPDATE t SET x=1'), { code: 'PROTOCOL_CONNECTION_LOST' });
    assert.equal(service.getSessionState().outcomeUnknown, true);
    await assert.rejects(service.query('SELECT 7'), { code: 'ROCKETBRAIN_RECONNECT_REQUIRED' });
    assert.equal(server.connections.length, 1);
    await service.reconnect();
    assert.deepEqual((await service.query('SELECT 7')).rows, [[7]]);
    assert.equal(server.connections.flatMap(c => c.calls).filter(c => c.sql === 'UPDATE t SET x=1').length, 1);
    assert.equal(service.getSessionState().outcomeUnknown, true);
  });
});
test('timeout of autocommit DML closes the session and marks its unknown outcome', async () => {
  const server = fakeServer([{ resolve: sql => sql.startsWith('UPDATE') ? { hang: true } : {} }]);
  await withService(server, async service => {
    await service.setReadOnly(false);
    await assert.rejects(service.query('UPDATE t SET x=1', { timeoutMs: 15 }), { code: 'ROCKETBRAIN_TIMEOUT' });
    assert.equal(service.getSessionState().outcomeUnknown, true);
    assert.equal(service.getSessionState().transactionState, 'unknown');
  });
});
test('cancel interrupts active query, and closing a console destroys only its pinned connection', async () => {
  const server = fakeServer([{ hang: true }, {}]);
  await withService(server, async service => {
    await service.openSession('a'); await service.openSession('b');
    const pending = service.query('SELECT SLEEP(100)', { sessionId: 'a' });
    const rejection = assert.rejects(pending, { code: 'ROCKETBRAIN_CANCELLED' });
    await until(() => server.connections[0].calls.some(call => call.sql === 'SELECT SLEEP(100)'));
    const state = await service.cancel('a'); await rejection;
    assert.equal(state.needsReconnect, true); assert.equal(state.outcomeUnknown, false);
    assert.equal(service.getSessionState('b').connected, true);
    await service.closeSession('b'); assert.equal(server.connections[1].destroyed, true);
  });
});
test('cancel before a queued statement starts prevents network access rather than starting it later', async () => {
  const server = fakeServer();
  await withService(server, async service => {
    const pending = service.query('SELECT 1');
    const rejected = assert.rejects(pending, { code: 'ROCKETBRAIN_CANCELLED' });
    await service.cancel(); await rejected;
    assert.equal(server.connections.length, 0);
    assert.equal(service.getSessionState().needsReconnect, false);
    await service.query('SELECT 2');
    assert.equal(server.connections.length, 1);
  });
});
test('bounded streaming truncation explicitly loses manual transaction and requires reconnect', async () => {
  const server = fakeServer([{ rows: [[1], [2], [3]] }]);
  await withService(server, async service => {
    await service.setReadOnly(false); await service.begin();
    const result = await service.query('SELECT x FROM t', { maxRows: 2 });
    assert.deepEqual(result.rows, [[1], [2]]); assert.equal(result.truncated, true);
    assert.equal(result.state.needsReconnect, true); assert.equal(result.state.outcomeUnknown, true);
    await assert.rejects(service.commit(), { code: 'ROCKETBRAIN_RECONNECT_REQUIRED' });
    assert.equal(server.connections[0].destroyed, true);
  });
});
test('oversized cell fails bounded output and disposal rejects queued work and clears password', async () => {
  const server = fakeServer([{ rows: [['x'.repeat(5 * 1024 * 1024)]] }]);
  const service = new MysqlService(config, server);
  await assert.rejects(service.query('SELECT large FROM t'), /4 MiB/);
  await service.dispose(); await service.dispose();
  await assert.rejects(service.query('SELECT 1'), /closed/);
  assert.equal(service._options.password, '');
});
test('schema binds the database name on a distinct read-only metadata connection', async () => {
  const server = fakeServer([{ rows: [[1]] }, { columns: ['TABLE_NAME', 'COLUMN_NAME', 'COLUMN_TYPE', 'COLUMN_KEY'], rows: [['people', 'id', 'bigint', 'PRI'], ['people', 'name', 'varchar(100)', '']] }]);
  await withService(server, async service => {
    await service.setReadOnly(false); await service.begin();
    const schema = await service.schema();
    assert.deepEqual(schema, [{ name: 'people', columns: [{ name: 'id', type: 'bigint', primaryKey: true }, { name: 'name', type: 'varchar(100)', primaryKey: false }] }]);
    const request = server.connections[1].calls.find(call => call.protocol === 'execute');
    assert.deepEqual(request.values, ["app's db"]); assert.ok(!request.sql.includes("app's db"));
    assert.equal(server.connections[1].calls[0].sql, 'SET SESSION TRANSACTION READ ONLY');
    assert.equal(service.getSessionState().inTransaction, true);
  });
});
test('a failed server-state probe disables the console after a completed statement', async () => {
  let probes = 0;
  const server = fakeServer([{ controlError: sql => sql === 'DO 0' && ++probes > 1 ? { code: 'ER_UNKNOWN_ERROR' } : null }]);
  await withService(server, async service => {
    await assert.rejects(service.query('SELECT 1'), { code: 'ROCKETBRAIN_STATE_UNAVAILABLE', queryCompleted: true });
    assert.equal(service.getSessionState().needsReconnect, true); assert.equal(service.getSessionState().connected, false);
  });
});
