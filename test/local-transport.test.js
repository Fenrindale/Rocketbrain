'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createServer } = require('node:net');
const { normalizeLocalTransport, localDriverOptions, connectionEndpoint } = require('../src/db/local-transport');
const { tableLayoutConnectionKey } = require('../src/db/result-layouts');
const { MysqlService } = require('../src/db/mysql');

const pipe = address => ({ kind: 'named-pipe', address });
const unix = address => ({ kind: 'unix-socket', address });
const prefix = '\\\\.\\pipe\\';
const config = transport => ({ transport, user: 'fixture', database: 'app' });

test('local MySQL transports accept normalized endpoint forms and reject remote pipes, unsafe paths and mixed security', () => {
  assert.deepEqual(normalizeLocalTransport(pipe(prefix + 'MySQL-8')), pipe('MySQL-8'));
  assert.deepEqual(normalizeLocalTransport(pipe('MySQL 서버')), pipe('MySQL 서버'));
  assert.deepEqual(localDriverOptions(config(pipe('MySQL-8')), 'win32'), { socketPath: prefix + 'MySQL-8' });
  assert.deepEqual(localDriverOptions(config(unix('/run/MySQL Data/mysql.sock')), 'linux'),
    { socketPath: '/run/MySQL Data/mysql.sock' });
  const invalid = [
    pipe('\\\\remote\\pipe\\MySQL'), pipe('\\\\?\\pipe\\MySQL'), pipe(prefix + 'unrelated\\MySQL'),
    pipe(prefix + 'double//name'), pipe('..'), pipe(''), pipe('a'.repeat(248)), unix('relative.sock'), unix('//host/share/mysql.sock'),
    unix('/run/../other/mysql.sock'), unix('/run//mysql.sock'), unix('/run/mysql.sock/'), unix('/'), unix('/' + '한'.repeat(35)),
    unix('/run/\0name')
  ];
  for (const transport of invalid) assert.throws(() => normalizeLocalTransport(transport), { code: 'ROCKETBRAIN_LOCAL_TRANSPORT' });
  assert.throws(() => localDriverOptions(config(pipe('MySQL')), 'linux'), /Windows extension host/);
  assert.throws(() => localDriverOptions(config(unix('/run/mysql.sock')), 'win32'), /Unix-like extension host/);
  for (const forbidden of [{ host: 'localhost' }, { port: 3306 }, { ssl: {} }, { ssh: { host: 'server' } }]) {
    assert.throws(() => localDriverOptions({ ...config(pipe('MySQL')), ...forbidden }, 'win32'), /one local transport/);
  }
});

test('connection and result layout identity distinguish local paths from TCP while preserving ordinary TCP keys', () => {
  const a = config(pipe('mysql')), b = config(pipe(prefix + 'MySQL')), c = config(pipe('other'));
  const endpoint = connectionEndpoint(localDriverOptions(a, 'win32'));
  assert.deepEqual(endpoint, connectionEndpoint(localDriverOptions(b, 'win32')));
  assert.equal(endpoint.transport, 'named-pipe');
  assert.match(endpoint.addressHash, /^[a-f0-9]{64}$/);
  assert.notDeepEqual(endpoint, connectionEndpoint(localDriverOptions(c, 'win32')));
  assert.deepEqual(connectionEndpoint({ host: 'localhost', port: 3306 }), { host: 'localhost', port: 3306 });
  const key = tableLayoutConnectionKey(a);
  assert.equal(key, tableLayoutConnectionKey(b));
  assert.notEqual(key, tableLayoutConnectionKey(c));
  assert.notEqual(key, tableLayoutConnectionKey({ ...a, database: 'other_schema' }));
  assert.notEqual(key, tableLayoutConnectionKey({ host: 'localhost', user: 'fixture', database: 'app' }));
  assert.notEqual(tableLayoutConnectionKey(config(unix('/run/Mysql.sock'))), tableLayoutConnectionKey(config(unix('/run/mysql.sock'))));
});

test('the active platform resolves only an IPC route and never falls back to a TCP connection', async () => {
  const usePipe = process.platform === 'win32';
  const address = usePipe ? pipe('rocketbrain-test-local-route') : unix('/tmp/rocketbrain-test-local-route.sock');
  const opened = [];
  const service = new MysqlService(config(address), { createConnection(options) {
    opened.push(options);
    throw Object.assign(Error('private socket details'), { code: 'ENOENT' });
  }});
  try {
    await assert.rejects(service.metadata(), error => error.code === 'ENOENT' && !error.message.includes('private socket details'));
    assert.equal(opened.length, 1);
    assert.deepEqual({ socketPath: opened[0].socketPath }, localDriverOptions(config(address)));
    assert.equal(opened[0].host, undefined);
    assert.equal(opened[0].port, undefined);
    assert.equal(opened[0].stream, undefined);
    if (usePipe) assert.equal(typeof opened[0].authPlugins.caching_sha2_password, 'function');
  } finally { await service.dispose(); }
});

test('Unix host opens an actual filesystem socket through the MySQL driver', {
  skip: process.platform === 'win32' ? 'The Windows Node.js host has no Unix filesystem-socket transport.' : false,
  timeout: 15000
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rb-ipc-'));
  const address = join(directory, 'db.sock');
  let accepted = 0;
  // This listens only for proof of the initial local socket connection. It sends no DB handshake.
  const server = createServer(socket => { accepted++; socket.destroy(); });
  await new Promise((resolve, reject) => server.once('error', reject).listen(address, resolve));
  const service = new MysqlService(config(unix(address)));
  try {
    await assert.rejects(service.metadata());
    assert.equal(accepted, 1);
  } finally {
    await service.dispose();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
