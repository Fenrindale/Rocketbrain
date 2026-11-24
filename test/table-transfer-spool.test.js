'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Readable } = require('node:stream');
const { createRowSpool } = require('../src/db/table-transfer-spool');
const { readSnapshot, sourceQuery } = require('../src/db/table-transfer-snapshot');

async function fixture(t, limits = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rocketbrain-cipher-test-'));
  const spool = await createRowSpool({ columns: [{ name: 'note' }, { name: 'payload' }], maxRows: 5, maxRowBytes: 1024,
    maxBytes: 4096, directoryRoot: root, ...limits });
  t.after(async () => { await spool.dispose(); await fs.rmdir(root); });
  const [directory] = await fs.readdir(root);
  return { spool, root, file: path.join(root, directory, 'rows.bin') };
}

test('sealed encrypted snapshot replays exact rows, verifies a bounded frame and releases the private directory', async t => {
  const { spool, root, file } = await fixture(t);
  const rows = [['Sentinel for private application data 한국어\r\n', '0x00ff'], ['', null], ['line one\rline two\n', '0x']];
  for (const row of rows) await spool.append(row);
  const seal = await spool.seal();
  assert.equal(seal.rowCount, rows.length);
  assert.ok(seal.maxFrameBytes <= 1024 + 20);
  assert.equal((await fs.readFile(file)).includes(Buffer.from('Sentinel for private application data')), false);
  const read = [];
  assert.deepEqual(await spool.scan({ onRow: async (row, offset) => {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(offset, read.length);
    read.push(row);
  } }), seal);
  assert.deepEqual(read, rows);
  await spool.dispose();
  assert.deepEqual(await fs.readdir(root), []);
});

test('the row spool refuses size overflow, cancelled replay and mutation after the reader verifies file identity', async t => {
  const { spool, file } = await fixture(t, { maxRows: 1, maxRowBytes: 32, maxBytes: 64 });
  await assert.rejects(spool.append(['large '.repeat(12), null]), /bounded row/);
  await spool.append(['valid', null]);
  await assert.rejects(spool.append(['extra', null]), /bounded row/);
  const sealed = await spool.seal();
  assert.equal(sealed.rowCount, 1);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(spool.scan({ cancellation: abort.signal }), /cancelled/);
  let delivered = false;
  await assert.rejects(spool.scan({
    onStart: async () => {
      const mutation = await fs.open(file, 'r+');
      try {
        const bytes = Buffer.alloc(1);
        await mutation.read(bytes, 0, 1, 5);
        bytes[0] ^= 0xff;
        await mutation.write(bytes, 0, 1, 5);
      }
      finally { await mutation.close(); }
    },
    onRow: () => { delivered = true; }
  }), /authentication/);
  assert.equal(delivered, false);
});

test('stream SELECT caps raw data before driver decode, orders by the qualified key and binds projection aliases to catalog columns', () => {
  const fields = [{ name: 'key`value', kind: 'integer' }, { name: 'bytes', kind: 'binary' }];
  const query = sourceQuery('database', 'table`name', fields, [fields[0]]);
  assert.deepEqual(query.headers, ['key`value', 'bytes', '__rb_source_overflow']);
  assert.ok(query.sql.includes('OCTET_LENGTH(rb_source.`bytes`), 0) > 65535'));
  assert.ok(query.sql.includes('> 524288'));
  assert.ok(query.sql.includes('THEN NULL ELSE rb_source.`bytes` END AS `bytes`'));
  assert.match(query.sql, /FROM `database`.`table``name` AS rb_source ORDER BY rb_source.`key``value`$/);
});

test('stream capture observes one owned transaction, driver backpressure, schema verification and cancellation cleanup', async () => {
  const columns = [{ name: 'id', kind: 'integer' }, { name: 'name', kind: 'text' }], headers = sourceQuery('app', 'people', columns, [columns[0]]).headers;
  const controls = [], expectations = [];
  function makeSession() {
    const s = { connected: true, inTransaction: false, active: null };
    s.connection = { query: () => ({ stream: options => {
      assert.deepEqual(options, { highWaterMark: 1 });
      const stream = Readable.from(Array.from({ length: 246 }, (_, i) => [i, 'row-' + i, 0]), { objectMode: true, highWaterMark: 1 });
      queueMicrotask(() => stream.emit('fields', headers.map(name => ({ name }))));
      return stream;
    } }) };
    return s;
  }
  const db = {
    async _control(session, sql) {
      controls.push(sql);
      if (sql.startsWith('START')) session.inTransaction = true;
      if (sql === 'ROLLBACK') session.inTransaction = false;
    },
    async _refreshState() {},
    async _stream() { return { rows: [] }; },
    _lose(session, error) {
      session.connected = false;
      session.active?.abort(error);
    }
  };
  const capture = (session, overrides = {}) => readSnapshot({ db, session, schema: 'app', table: 'people', columns, keys: [columns[0]],
    check() {}, serializeRow: row => row.map(String), verify: async () => expectations.push(session.inTransaction), ...overrides });
  const first = makeSession(), snapshot = await capture(first);
  try {
    assert.equal(snapshot.rowCount, 246);
    assert.ok(snapshot.maxBufferedRows <= 1);
    assert.deepEqual(expectations, [true]);
    assert.deepEqual(controls, ['SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ', 'START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY', 'ROLLBACK']);
    assert.equal(first.inTransaction, false);
  } finally { await snapshot.spool.dispose(); }
  const interrupted = makeSession(), abort = new AbortController();
  await assert.rejects(capture(interrupted, { cancellation: abort.signal, onProgress: () => abort.abort() }), /cancelled/);
  assert.equal(interrupted.connected, false);
});
