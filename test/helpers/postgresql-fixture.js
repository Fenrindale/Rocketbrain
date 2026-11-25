'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { randomBytes, randomUUID } = require('node:crypto');
const timers = require('node:timers/promises');

const marker = 'RocketbrainDisposablePostgreSqlFixture-v1';
const pause = timers.setTimeout;

function run(binary, args, { cwd, env, input, timeout = 20000 } = {}) {
  const child = spawn(binary, args, { cwd, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', error = '', timedOut = false;
  const timeoutHandle = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout);
  return new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => { output = (output + chunk.toString()).slice(-16384); });
    child.stderr.on('data', chunk => { error = (error + chunk.toString()).slice(-16384); });
    child.stdin.on('error', () => {});
    child.once('error', reject);
    child.once('close', code => {
      if (code || timedOut) return reject(Error(path.basename(binary) + ' failed' + (timedOut ? ' (timeout)' : '') + ': ' + error));
      resolve(output);
    });
    child.stdin.end(input);
  }).finally(() => clearTimeout(timeoutHandle));
}

async function port() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const selected = server.address().port;
      server.close(cause => cause ? reject(cause) : resolve(selected));
    });
  });
}

async function startPostgreSqlFixture(bin) {
  if (!bin || !path.isAbsolute(bin)) throw Error('Select the official local PostgreSQL fixture binary directory.');
  let launchBin = await fs.realpath(bin);
  const runtimeRoot = path.dirname(launchBin);
  const program = name => path.join(launchBin, name + (process.platform === 'win32' ? '.exe' : ''));
  for (const name of ['postgres', 'initdb', 'psql', 'pg_ctl']) assert.ok((await fs.stat(program(name))).isFile());
  const root = await fs.realpath(os.tmpdir());
  const folder = await fs.mkdtemp(path.join(root, 'rocketbrain-postgres-'));
  const id = randomUUID(), owner = path.join(folder, 'owner.json');
  const alias = process.platform === 'win32' ? path.join('C:/Users/Public', 'Rocketbrain-PostgreSQL-' + id) : folder;
  const runtimeAlias = path.join(alias, 'runtime');
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    ['SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR'].includes(name.toUpperCase()))), LANG: 'C', LC_ALL: 'C', TZ: 'UTC' };
  const password = randomBytes(24).toString('base64url'), adminPassword = randomBytes(24).toString('base64url');
  const postgresPort = await port();
  const data = path.join(alias, 'data'), secureFile = path.join(alias, 'bootstrap-secret');
  const route = { host: '127.0.0.1', port: postgresPort, database: 'rocketbrain_fixture', schema: 'pilot', tls: 'loopback' };
  const auth = { user: 'rb_fixture', password };
  let child, exited = false, exit, aliased = false, runtimeLinked = false;
  await fs.writeFile(owner, JSON.stringify({ kind: marker, id }));

  function client(database, user, secret, sql) {
    return run(program('psql'), ['-X', '-w', '-h', route.host, '-p', String(route.port), '-U', user, '-d', database,
      '-v', 'ON_ERROR_STOP=1', '-Atq'], { cwd: alias, input: sql + '\n',
      env: { ...env, PGPASSWORD: secret, PGCONNECT_TIMEOUT: '2', PGCLIENTENCODING: 'UTF8' } });
  }

  async function close() {
    assert.ok((await fs.stat(owner)).isFile());
    const tag = JSON.parse(await fs.readFile(owner, 'utf8'));
    assert.deepEqual(tag, { kind: marker, id });
    assert.equal(path.dirname(await fs.realpath(folder)), root);
    if (child && !exited) {
      try { await run(program('pg_ctl'), ['stop', '-D', data, '-m', 'fast', '-w', '-t', '10'], { cwd: alias, env, timeout: 12000 }); }
      catch { child.kill('SIGKILL'); }
      const halted = await Promise.race([exit.then(() => true), pause(4000, false, { ref: false })]);
      assert.equal(halted, true, 'The owned PostgreSQL process did not exit.');
    }
    if (aliased) {
      assert.equal(await fs.realpath(alias), await fs.realpath(folder));
      if (runtimeLinked) {
        assert.equal(await fs.realpath(runtimeAlias), runtimeRoot);
        await fs.unlink(runtimeAlias);
        runtimeLinked = false;
      }
      await fs.unlink(alias);
      aliased = false;
    }
    await fs.rm(folder, { recursive: true, maxRetries: 5, retryDelay: 100 });
  }

  try {
    if (alias !== folder) {
      // Windows initdb can feed launcher-path bytes to its UTF-8 bootstrap SQL.
      await fs.symlink(folder, alias, 'junction');
      aliased = true;
      await fs.symlink(runtimeRoot, runtimeAlias, 'junction');
      runtimeLinked = true;
      launchBin = path.join(runtimeAlias, path.basename(launchBin));
    }
    await fs.writeFile(secureFile, adminPassword + '\n', { flag: 'wx', mode: 0o600 });
    await run(program('initdb'), ['-D', data, '--auth=scram-sha-256', '--username=rb_fixture_admin', '--pwfile=' + secureFile,
      '--encoding=UTF8', '--locale=C', '--no-sync'], { cwd: alias, env, timeout: 60000 });
    await fs.unlink(secureFile);
    child = spawn(program('postgres'), ['-D', data, '-h', route.host, '-p', String(route.port),
      '-c', 'shared_buffers=16MB', '-c', 'max_connections=20', '-c', 'log_statement=none'],
    { cwd: alias, env, windowsHide: true, shell: false, stdio: ['ignore', 'ignore', 'pipe'] });
    let last = '';
    child.stderr.on('data', chunk => { last = (last + chunk.toString()).slice(-4096); });
    exit = new Promise(resolve => {
      child.once('close', () => { exited = true; resolve(); });
      child.once('error', () => { exited = true; resolve(); });
    });
    const deadline = Date.now() + 20000;
    let version;
    while (!version && !exited && Date.now() < deadline) {
      try { version = (await client('postgres', 'rb_fixture_admin', adminPassword, 'SELECT version();')).trim(); }
      catch { await pause(150); }
    }
    if (!version) throw Error('The disposable PostgreSQL server did not start: ' + last);
    await client('postgres', 'rb_fixture_admin', adminPassword, `CREATE ROLE rb_fixture LOGIN PASSWORD '${password}';\nCREATE DATABASE rocketbrain_fixture;`);
    await client(route.database, 'rb_fixture_admin', adminPassword, `CREATE SCHEMA pilot;
CREATE SCHEMA hidden;
CREATE TABLE hidden.outside(id int);
CREATE TABLE pilot.events (id bigint NOT NULL PRIMARY KEY, amount numeric(22,6), bytes bytea, properties jsonb, notes text[], "이름" text);
INSERT INTO pilot.events VALUES (9007199254740994, 1234567890.123450, decode('000aff','hex'), '{"message":"semi;colon"}', ARRAY['a','b'], '한글'),
  (9007199254740995, NULL, NULL, NULL, NULL, 'other');
CREATE VIEW pilot.active_events AS SELECT id FROM pilot.events WHERE amount IS NOT NULL;
CREATE MATERIALIZED VIEW pilot.cached_events AS SELECT id FROM pilot.events;
CREATE TABLE pilot.guard_write(id int);
CREATE FUNCTION pilot.test_guard() RETURNS int LANGUAGE SQL VOLATILE AS 'INSERT INTO pilot.guard_write VALUES (9) RETURNING id';
GRANT CONNECT ON DATABASE rocketbrain_fixture TO rb_fixture;
GRANT USAGE ON SCHEMA pilot TO rb_fixture;
GRANT SELECT ON ALL TABLES IN SCHEMA pilot TO rb_fixture;
GRANT INSERT ON pilot.guard_write TO rb_fixture;
GRANT EXECUTE ON FUNCTION pilot.test_guard() TO rb_fixture;`);
    return { route, auth, folder, version, close, query: sql => client(route.database, auth.user, auth.password, sql),
      ownerQuery: sql => client(route.database, 'rb_fixture_admin', adminPassword, sql) };
  } catch (cause) {
    await close();
    throw Error(String(cause.message).replaceAll(password, '[redacted]').replaceAll(adminPassword, '[redacted]'));
  }
}

module.exports = { startPostgreSqlFixture };
