'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const mysql = require('mysql2/promise');
const { ensureMariaDbRuntime, runProcess, WORKSPACE } = require('./integration-db-runtime');
const fixtureSql = require('../test/integration/fixture-sql');

const INSTANCE_ROOT = path.join(WORKSPACE, 'research', 'implementation', 'db-instances');
const MARKER = 'RocketbrainDisposableMariaDbFixture-v1';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForExit(exitPromise, timeoutMs) {
  let timer;
  try { await Promise.race([exitPromise, new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); })]); }
  finally { clearTimeout(timer); }
}

function assertOwnedPath(folder) {
  const resolved = path.resolve(folder);
  const relative = path.relative(INSTANCE_ROOT, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || relative.includes(path.sep)) {
    throw new Error('Refusing to operate outside one disposable workspace fixture directory.');
  }
  return resolved;
}

async function removeOwnedInstance(folder, id) {
  const resolved = assertOwnedPath(folder);
  const marker = JSON.parse(await fsp.readFile(path.join(resolved, 'owner.json'), 'utf8'));
  if (marker.kind !== MARKER || marker.id !== id) throw new Error('Disposable fixture ownership marker does not match.');
  const realRoot = await fsp.realpath(INSTANCE_ROOT);
  const realFolder = await fsp.realpath(resolved);
  const relative = path.relative(realRoot, realFolder);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || relative.includes(path.sep)) throw new Error('Fixture path resolves outside its dedicated workspace parent.');
  // Checked absolute path, real path and per-instance ownership before recursive removal.
  await fsp.rm(realFolder, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
}

function unusedPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer(); server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(error => error ? reject(error) : resolve(port)); });
  });
}

async function waitForDatabase(config, child, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  let lastCode;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Disposable MariaDB exited before readiness (${child.exitCode}).`);
    try {
      const connection = await mysql.createConnection({ ...config, connectTimeout: 600 });
      await connection.query('SELECT 1');
      return connection;
    } catch (error) { lastCode = error.code; }
    await delay(150);
  }
  throw new Error(`Disposable MariaDB did not become ready (${lastCode || 'timeout'}).`);
}

async function startFixture({tls,namedPipe=false,eventScheduler=false}={}) {
  if(namedPipe&&process.platform!=='win32')throw Error('The MariaDB named pipe fixture needs a Windows host.');
  if(tls){if(Object.keys(tls).some(k=>!['ca','cert','key'].includes(k))||['ca','cert','key'].some(k=>typeof tls[k]!=='string'||!tls[k]||Buffer.byteLength(tls[k])>2*1024*1024||tls[k].includes('\0')))throw Error('Use bounded PEM ca/cert/key strings for the owned TLS fixture.');const cert=new crypto.X509Certificate(tls.cert);new crypto.X509Certificate(tls.ca);if(!cert.checkPrivateKey(crypto.createPrivateKey(tls.key)))throw Error('TLS fixture server certificate/key mismatch.');}
  const runtime = await ensureMariaDbRuntime();
  await fsp.mkdir(INSTANCE_ROOT, { recursive: true });
  const id = crypto.randomUUID();
  const pipeName = namedPipe ? 'rocketbrain-mariadb-' + id : undefined;
  const folder = assertOwnedPath(path.join(INSTANCE_ROOT, id));
  await fsp.mkdir(folder);
  await fsp.writeFile(path.join(folder, 'owner.json'), JSON.stringify({ kind: MARKER, id, workspace: WORKSPACE, createdAt: new Date().toISOString() }));
  const datadir = path.join(folder, 'data');
  const tmpdir = path.join(folder, 'tmp');
  const filesdir = path.join(folder, 'files');
  await fsp.mkdir(tmpdir); await fsp.mkdir(filesdir);
  const tlsPaths={};if(tls)for(const [key,value]of Object.entries(tls)){tlsPaths[key]=path.join(folder,'tls-'+key+'.pem');await fsp.writeFile(tlsPaths[key],value,{mode:0o600});}
  const rootPassword = crypto.randomBytes(24).toString('base64url');
  const password = crypto.randomBytes(24).toString('base64url');
  const readerPassword = crypto.randomBytes(24).toString('base64url');
  const port = await unusedPort();
  let child;
  let admin;
  let stopping;
  let logFd;
  let exitPromise;
  const config = { host: '127.0.0.1', port, user: 'rb_fixture', password, database: 'rocketbrain_fixture' };
  const readOnlyConfig = { ...config, user: 'rb_reader', password: readerPassword };
  const adminConfig = { host: '127.0.0.1', port, user: 'root', password: rootPassword, connectTimeout: 1000 };
  async function withAdmin(callback){if(typeof callback!=='function'||!child||child.exitCode!==null||stopping)throw Error('Use the live owned fixture admin callback before shutdown.');const connection=await mysql.createConnection(adminConfig);try{const [rows]=await connection.query('SELECT @@datadir AS datadir');if((await fsp.realpath(rows[0].datadir)).toLowerCase()!==(await fsp.realpath(datadir)).toLowerCase())throw Error('Fixture admin datadir ownership mismatch.');return await callback(connection);}finally{await connection.end();}}
  async function stop({ remove = true } = {}) {
    if (stopping) return stopping;
    stopping = (async () => {
      if (admin) { await admin.end().catch(() => {}); admin = undefined; }
      if (child && child.exitCode === null) {
        try {
          const connection = await mysql.createConnection(adminConfig);
          const [rows] = await connection.query('SELECT @@datadir AS datadir');
          const actual = path.resolve(rows[0].datadir);
          if (actual.toLowerCase() !== path.resolve(datadir).toLowerCase()) throw new Error('Server datadir did not match this fixture.');
          await connection.query('SHUTDOWN').catch(error => {
            if (!['PROTOCOL_CONNECTION_LOST', 'ER_SERVER_SHUTDOWN'].includes(error.code)) throw error;
          });
          connection.destroy();
        } catch {
          // This ChildProcess was created here; never kill an inventory/PID supplied by another process.
          child.kill();
        }
        await waitForExit(exitPromise, 8000);
        if (child.exitCode === null) { child.kill(); await waitForExit(exitPromise, 3000); }
        if (child.exitCode === null) throw new Error('Disposable server did not exit; preserving files for inspection.');
      }
      if (logFd !== undefined) { fs.closeSync(logFd); logFd = undefined; }
      if (remove) await removeOwnedInstance(folder, id);
    })();
    return stopping;
  }
  try {
    // Omitting --service ensures no Windows service is installed.
    await runProcess(runtime.initializer, [`--datadir=${datadir}`, `--password=${rootPassword}`, `--port=${port}`, '--silent'], { cwd: runtime.home });
    logFd = fs.openSync(path.join(folder, 'server-console.log'), 'a');
    child = spawn(runtime.server, ['--no-defaults', `--basedir=${runtime.home}`, `--datadir=${datadir}`, `--tmpdir=${tmpdir}`, `--secure-file-priv=${filesdir}`,
      ...(tls?[`--ssl-ca=${tlsPaths.ca}`,`--ssl-cert=${tlsPaths.cert}`,`--ssl-key=${tlsPaths.key}`]:[]),
      ...(pipeName?['--enable-named-pipe','--socket='+pipeName]:[]),
      ...(eventScheduler?['--event-scheduler=ON']:[]),
      '--local-infile=0', '--bind-address=127.0.0.1', `--port=${port}`, '--skip-name-resolve', '--skip-log-bin', '--max-connections=20',
      '--innodb-buffer-pool-size=33554432', `--pid-file=${path.join(folder, 'server.pid')}`,
      `--log-error=${path.join(folder, 'server-error.log')}`, '--console'], { cwd: folder, windowsHide: true, stdio: ['ignore', logFd, logFd] });
    exitPromise = new Promise(resolve => child.once('exit', resolve));
    child.once('error', () => {});
    admin = await waitForDatabase(adminConfig, child);
    // Multiple statements are confined to this original seed on this fresh instance.
    await admin.end();
    admin = await mysql.createConnection({ ...adminConfig, multipleStatements: true });
    await admin.query(fixtureSql);
    await admin.query('CREATE USER ?@? IDENTIFIED BY ?', [config.user, '127.0.0.1', password]);
    await admin.query('GRANT ALL PRIVILEGES ON rocketbrain_fixture.* TO ?@?', [config.user, '127.0.0.1']);
    if(pipeName){
      await admin.query('CREATE USER ?@? IDENTIFIED BY ?', [config.user,'localhost',password]);
      await admin.query('GRANT SELECT ON rocketbrain_fixture.* TO ?@?', [config.user,'localhost']);
    }
    // Only this freshly owned disposable actor can inspect the global FK dictionary.
    await admin.query('GRANT PROCESS ON *.* TO ?@?', [config.user, '127.0.0.1']);
    let crossConfigPath;
    if (process.env.ROCKETBRAIN_CROSS_SCHEMA_TEST === '1') {
      // This capability exists only inside this freshly created disposable server.
      await admin.query('CREATE DATABASE `rocketbrain_related` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
      await admin.query('GRANT ALL PRIVILEGES ON rocketbrain_related.* TO ?@?', [config.user, '127.0.0.1']);
      await admin.query('GRANT SELECT, SHOW VIEW, TRIGGER ON *.* TO ?@?', [config.user, '127.0.0.1']);
      crossConfigPath = path.join(folder, 'cross-schema.json');
      await fsp.writeFile(crossConfigPath, JSON.stringify({ schemas: [config.database, 'rocketbrain_related'], fixtureId: id }), { mode: 0o600 });
    }
    await admin.query('CREATE USER ?@? IDENTIFIED BY ?', [readOnlyConfig.user, '127.0.0.1', readerPassword]);
    await admin.query('GRANT SELECT, SHOW VIEW ON rocketbrain_fixture.* TO ?@?', [readOnlyConfig.user, '127.0.0.1']);
    const [versionRows] = await admin.query('SELECT VERSION() AS version, @@port AS port, @@bind_address AS bindAddress, @@datadir AS datadir');
    await admin.end(); admin = undefined;
    const configPath = path.join(folder, 'connection.json');
    await fsp.writeFile(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
    await fsp.writeFile(path.join(folder, 'fixture.json'), JSON.stringify({ readOnlyConfig, id, datadir, processId: child.pid }, null, 2), { mode: 0o600 });
    return { id, folder, datadir, configPath, crossConfigPath, config, pipeName, readOnlyConfig, withAdmin, runtime, process: child, server: versionRows[0], stop, close: stop };
  } catch (error) {
    await stop().catch(() => {});
    throw error;
  }
}

async function main() {
  const mode = process.argv[2] || 'smoke';
  if (!['smoke', 'run', 'start', 'runtime'].includes(mode)) throw new Error('Use integration-db.js smoke | runtime | start | run <node arguments>.');
  if (mode === 'runtime') { const runtime = await ensureMariaDbRuntime(); console.log(JSON.stringify(runtime, null, 2)); return; }
  const fixture = await startFixture({namedPipe:process.env.ROCKETBRAIN_FIXTURE_NAMED_PIPE==='1'});
  console.log(JSON.stringify({ status: 'ready', id: fixture.id, host: fixture.config.host, port: fixture.config.port, version: fixture.server.version, configPath: fixture.configPath, processId: fixture.process.pid, installedService: false }));
  try {
    if (mode === 'smoke') {
      const connection = await mysql.createConnection(fixture.config);
      const [rows] = await connection.query('SELECT COUNT(*) AS count FROM people');
      await connection.end();
      const report = { checkedAt: new Date().toISOString(), server: fixture.server.version, bindAddress: fixture.server.bindAddress, rows: rows[0].count, runtimeSha256: fixture.runtime.actualSha256, originalIdeUsed: false, windowsServiceInstalled: false, existingDatabaseTouched: false, passwordsRecordedInReport: false, teardown: 'pending' };
      await fixture.stop(); report.teardown = 'own datadir and credentials removed';
      await fsp.writeFile(path.join(WORKSPACE, 'research', 'implementation', 'mariadb-fixture-smoke.json'), JSON.stringify(report, null, 2) + '\n');
      console.log(JSON.stringify(report));
    } else if (mode === 'run') {
      const args = process.argv.slice(3);
      if (!args.length) throw new Error('Pass Node arguments after run.');
      const code = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, args, { cwd: WORKSPACE, windowsHide: true, stdio: 'inherit', env: { ...process.env, ROCKETBRAIN_TEST_MYSQL_JSON: JSON.stringify(fixture.config), ROCKETBRAIN_TEST_MYSQL_CONFIG: fixture.configPath, ROCKETBRAIN_MYSQL_TEST_CONFIG: fixture.configPath,
          ...(fixture.pipeName?{ROCKETBRAIN_TEST_MYSQL_PIPE:fixture.pipeName}:{}),
          ...(fixture.crossConfigPath ? { ROCKETBRAIN_SCHEMA_CROSS_CONFIG: fixture.crossConfigPath } : {}) } });
        child.once('error', reject); child.once('exit', code => resolve(code ?? 1));
      });
      process.exitCode = code;
    } else {
      const end = async () => { await fixture.stop(); process.exit(); };
      process.once('SIGINT', end); process.once('SIGTERM', end);
      await new Promise(resolve => fixture.process.once('exit', resolve));
    }
  } finally { await fixture.stop(); }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { startFixture, assertOwnedPath, removeOwnedInstance, INSTANCE_ROOT };
