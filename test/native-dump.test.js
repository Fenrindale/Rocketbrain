'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { selectTables } = require('../src/db/native-dump');
const { measure, runner, withPrivateDirectory, writeClientFile } = require('../src/db/native-dump-process');

test('native backup accepts only visible InnoDB tables and requires the full same-schema FK dependency chain', () => {
  const tables = [
    { name: 'parent', kind: 'table', engine: 'InnoDB', foreignKeys: [] },
    { name: 'child', kind: 'table', engine: 'InnoDB', foreignKeys: [{ referencedSchema: 'app', referencedTable: 'parent' }] },
    { name: 'historic', kind: 'table', engine: 'MyISAM', foreignKeys: [] },
    { name: 'external', kind: 'table', engine: 'InnoDB', foreignKeys: [{ referencedSchema: 'other', referencedTable: 'parent' }] }
  ];
  const catalog = { scope: 'database', database: 'app', coverage: { tables: 'loaded', foreignKeys: 'loaded' }, tables };
  assert.deepEqual(selectTables(catalog, ['parent', 'child']), ['child', 'parent']);
  assert.throws(() => selectTables(catalog, ['child']), /Include all selected/);
  assert.throws(() => selectTables(catalog, ['parent', 'external']), /same schema/);
  assert.throws(() => selectTables(catalog, ['historic']), /observed InnoDB/);
  assert.throws(() => selectTables(catalog, ['--global']), /distinct InnoDB/);
  assert.throws(() => selectTables({ ...catalog, coverage: {} }, ['parent']), /Observe the database/);
});

test('a native subprocess stops at output bounds, drops external client env and masks database error text', async () => {
  const previous = process.env.MYSQL_PWD;
  process.env.MYSQL_PWD = 'ephemeral_env_test_marker';
  try {
    const child = await runner(process.execPath, ['-e', "process.stdout.write(process.env.MYSQL_PWD || 'absent')"], { probe: true });
    assert.equal(child.text, 'absent');
  } finally {
    if (previous === undefined) delete process.env.MYSQL_PWD;
    else process.env.MYSQL_PWD = previous;
  }
  await assert.rejects(runner(process.execPath, ['-e', "console.error('ERROR 1064 secret query text'); process.exitCode = 1"]),
    { message: 'The native database tool stopped (database error 1064).' });
  await assert.rejects(runner(process.execPath, ['-e', "process.stderr.write('x'.repeat(9000))"]), { code: 'ROCKETBRAIN_NATIVE_DUMP_OUTPUT_LIMIT' });
  await assert.rejects(runner(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { limit: 100 }), { code: 'ROCKETBRAIN_NATIVE_DUMP_TIMEOUT' });
});

test('the stream meter hashes exact bytes and rejects data that exceed the cap', async () => {
  const destination = () => new Writable({ write(value, encoding, done) { done(); } });
  const checked = measure(4);
  await pipeline(Readable.from([Buffer.from('abc')]), checked.stream, destination());
  assert.deepEqual(checked.summary(), { bytes: 3, sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' });
  await assert.rejects(pipeline(Readable.from([Buffer.from('abc')]), measure(2).stream, destination()), { code: 'ROCKETBRAIN_NATIVE_DUMP_SIZE' });
});

test('the native credential file handles punctuation, rejects control characters and is removed after failure', async () => {
  let directory;
  const config = { host: '127.0.0.1', port: 3306, user: 'client', password: 'quote" slash\\ newline\nsemi; hash#' };
  await assert.rejects(withPrivateDirectory(async folder => {
    directory = folder;
    await assert.rejects(writeClientFile(folder, { ...config, password: '\0' }), { code: 'ROCKETBRAIN_NATIVE_DUMP_CREDENTIALS' });
    await writeClientFile(folder, config);
    const file = path.join(folder, 'rb-client.cnf');
    assert.match(await fs.readFile(file, 'utf8'), /password="quote\\" slash\\\\ newline\\nsemi; hash#"/);
    if (process.platform !== 'win32') assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    throw new Error('fixture failure');
  }), /fixture failure/);
  await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
});
