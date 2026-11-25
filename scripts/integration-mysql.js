'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const mysql = require('mysql2/promise');
const { runProcess } = require('./integration-db-runtime');
const { ensureMysqlRuntime, WORKSPACE } = require('./integration-mysql-runtime');
const seed = require('../test/integration/fixture-sql');
const ROOT = path.join(WORKSPACE, 'research', 'implementation', 'db-instances');
const MARKER = 'RocketbrainDisposableOracleMysqlFixture-v1';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitForExit(exitPromise, milliseconds) {
  let timer;
  try { await Promise.race([exitPromise, new Promise(resolve => { timer = setTimeout(resolve, milliseconds); })]); }
  finally { clearTimeout(timer); }
}
async function port() {
  return new Promise((resolve, reject) => {
    const server = net.createServer(); server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const number = server.address().port; server.close(error => error ? reject(error) : resolve(number)); });
  });
}
function owned(folder) {
  const absolute = path.resolve(folder), relative = path.relative(ROOT, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || relative.includes(path.sep)) throw new Error('Unsafe MySQL fixture path.');
  return absolute;
}
async function removeOwned(folder, id) {
  const absolute = owned(folder), marker = JSON.parse(await fsp.readFile(path.join(absolute, 'owner.json'), 'utf8'));
  if (marker.id !== id || marker.kind !== MARKER) throw new Error('Fixture ownership mismatch.');
  const relative = path.relative(await fsp.realpath(ROOT), await fsp.realpath(absolute));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || relative.includes(path.sep)) throw new Error('Fixture real path escaped its workspace.');
  await fsp.rm(absolute, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
async function startMysqlFixture({tls,namedPipe=false,eventScheduler=false,mysqlVersion=process.env.ROCKETBRAIN_TEST_MYSQL_VERSION}={}) {
  if(namedPipe&&process.platform!=='win32')throw Error('The MySQL named pipe fixture needs a Windows host.');
  if(tls){if(Object.keys(tls).some(k=>!['ca','cert','key'].includes(k))||['ca','cert','key'].some(k=>typeof tls[k]!=='string'||!tls[k]||Buffer.byteLength(tls[k])>2*1024*1024||tls[k].includes('\0')))throw Error('Use bounded PEM ca/cert/key strings for the owned TLS fixture.');const cert=new crypto.X509Certificate(tls.cert);new crypto.X509Certificate(tls.ca);if(!cert.checkPrivateKey(crypto.createPrivateKey(tls.key)))throw Error('TLS fixture server certificate/key mismatch.');}
  const runtime = await ensureMysqlRuntime(mysqlVersion);
  await fsp.mkdir(ROOT, { recursive: true });
  const id = crypto.randomUUID(), folder = owned(path.join(ROOT, id));
  const pipeName = namedPipe ? 'rocketbrain-mysql-' + id : undefined;
  await fsp.mkdir(folder);
  await fsp.writeFile(path.join(folder, 'owner.json'), JSON.stringify({ kind: MARKER, id, createdAt: new Date().toISOString() }));
  const datadir = path.join(folder, 'data'), tmpdir = path.join(folder, 'tmp'), filesdir = path.join(folder, 'files');
  await fsp.mkdir(tmpdir); await fsp.mkdir(filesdir);
  const tlsPaths={};if(tls)for(const [key,value]of Object.entries(tls)){tlsPaths[key]=path.join(folder,'tls-'+key+'.pem');await fsp.writeFile(tlsPaths[key],value,{mode:0o600});}
  // Oracle mysqld's Windows argument handling truncates this machine's Korean
  // user path. Only an ASCII junction is outside the workspace; all actual
  // binaries/data stay in research/implementation. Never recursively remove it.
  const implementation = path.join(WORKSPACE, 'research', 'implementation');
  const publicRoot = 'C:\\Users\\Public';
  const alias = path.join(publicRoot, 'Rocketbrain-MySQL-' + id);
  let aliasCreated = false;
  const launch = actual => {
    const relative = path.relative(implementation, path.resolve(actual));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('MySQL launch path escaped the workspace implementation directory.');
    return path.join(alias, relative);
  };
  const password = crypto.randomBytes(24).toString('base64url'), adminPassword = crypto.randomBytes(24).toString('base64url');
  const config = { host: '127.0.0.1', port: await port(), user: 'rb_fixture', password, database: 'rocketbrain_fixture' };
  const adminConfig = { host: config.host, port: config.port, user: 'rb_fixture_admin', password: adminPassword };
  let child, exitPromise, logFd, stopping;
  async function withAdmin(callback){if(typeof callback!=='function'||!child||child.exitCode!==null||stopping)throw Error('Use the live owned fixture admin callback before shutdown.');const connection=await mysql.createConnection(adminConfig);try{const [rows]=await connection.query('SELECT @@datadir AS datadir');if((await fsp.realpath(rows[0].datadir)).toLowerCase()!==(await fsp.realpath(datadir)).toLowerCase())throw Error('Fixture admin datadir ownership mismatch.');return await callback(connection);}finally{await connection.end();}}
  async function stop({ remove = true } = {}) {
    if (stopping) return stopping;
    stopping = (async () => {
      if (child && child.exitCode === null) {
        try {
          const connection = await mysql.createConnection({ ...adminConfig, connectTimeout: 1000 });
          const [rows] = await connection.query('SELECT @@datadir AS datadir');
          if ((await fsp.realpath(rows[0].datadir)).toLowerCase() !== (await fsp.realpath(datadir)).toLowerCase()) throw new Error('Fixture datadir mismatch.');
          await connection.query('SHUTDOWN').catch(error => { if (!['PROTOCOL_CONNECTION_LOST', 'ER_SERVER_SHUTDOWN'].includes(error.code)) throw error; });
          connection.destroy();
        } catch { child.kill(); }
        await waitForExit(exitPromise, 8000);
        if (child.exitCode === null) { child.kill(); await waitForExit(exitPromise, 3000); }
        if (child.exitCode === null) throw new Error('Fixture MySQL did not exit; preserving its files.');
      }
      if (logFd !== undefined) { fs.closeSync(logFd); logFd = undefined; }
      if (aliasCreated) {
        if (path.dirname(alias).toLowerCase() !== publicRoot.toLowerCase() || path.basename(alias) !== 'Rocketbrain-MySQL-' + id) throw new Error('MySQL path alias name mismatch.');
        if ((await fsp.realpath(alias)).toLowerCase() !== (await fsp.realpath(implementation)).toLowerCase()) throw new Error('MySQL path alias ownership mismatch.');
        await fsp.unlink(alias);
        aliasCreated = false;
      }
      if (remove) await removeOwned(folder, id);
    })();
    return stopping;
  }
  try {
    const implementationRelative = path.relative(await fsp.realpath(WORKSPACE), await fsp.realpath(implementation));
    if (implementationRelative !== path.join('research', 'implementation')) throw new Error('MySQL implementation root escaped the workspace.');
    await fsp.symlink(implementation, alias, 'junction'); aliasCreated = true;
    await runProcess(launch(runtime.server), ['--no-defaults', '--initialize-insecure', '--console', '--basedir=' + launch(runtime.home), '--datadir=' + launch(datadir)], { cwd: launch(folder) });
    const initFile = path.join(folder, 'bootstrap.sql');
    await fsp.writeFile(initFile, "ALTER USER 'root'@'localhost' IDENTIFIED BY '" + adminPassword + "';\nCREATE USER 'rb_fixture_admin'@'127.0.0.1' IDENTIFIED BY '" + adminPassword + "';\nGRANT ALL PRIVILEGES ON *.* TO 'rb_fixture_admin'@'127.0.0.1' WITH GRANT OPTION;\n", { mode: 0o600 });
    logFd = fs.openSync(path.join(folder, 'server-console.log'), 'a');
    child = spawn(launch(runtime.server), ['--no-defaults', '--console', '--basedir=' + launch(runtime.home), '--datadir=' + launch(datadir), '--tmpdir=' + launch(tmpdir),
      ...(tls?['--ssl-ca='+launch(tlsPaths.ca),'--ssl-cert='+launch(tlsPaths.cert),'--ssl-key='+launch(tlsPaths.key)]:[]),
      ...(pipeName?['--named-pipe','--socket='+pipeName,'--named-pipe-full-access-group=*everyone*']:[]),
      ...(eventScheduler?['--event-scheduler=ON']:[]),
      '--secure-file-priv=' + launch(filesdir), '--local-infile=0', '--bind-address=127.0.0.1', '--port=' + config.port, '--mysqlx=0',
      '--skip-name-resolve', '--skip-log-bin', '--max-connections=30', '--innodb-buffer-pool-size=33554432', '--init-file=' + launch(initFile),
      '--pid-file=' + launch(path.join(folder, 'server.pid')), '--log-error=' + launch(path.join(folder, 'server-error.log'))],
      { cwd: launch(folder), windowsHide: true, stdio: ['ignore', logFd, logFd] });
    exitPromise = new Promise(resolve => child.once('exit', resolve)); child.once('error', () => {});
    let admin;
    const deadline = Date.now() + 45000;
    while (!admin && Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error('Disposable MySQL exited before readiness. Inspect its workspace log.');
      try { admin = await mysql.createConnection({ ...adminConfig, connectTimeout: 700, multipleStatements: true }); } catch { await pause(150); }
    }
    if (!admin) throw new Error('Disposable MySQL did not become ready.');
    try {
      await fsp.unlink(initFile);
      await admin.query(seed);
      await admin.query('CREATE USER ?@? IDENTIFIED BY ?', [config.user, config.host, password]);
      await admin.query('GRANT ALL PRIVILEGES ON rocketbrain_fixture.* TO ?@?', [config.user, config.host]);
      if(pipeName){
        await admin.query('CREATE USER ?@? IDENTIFIED BY ?', [config.user,'localhost',password]);
        await admin.query('GRANT SELECT ON rocketbrain_fixture.* TO ?@?', [config.user,'localhost']);
      }
      // Only this freshly owned disposable actor can inspect the global FK dictionary.
      await admin.query('GRANT PROCESS ON *.* TO ?@?', [config.user, config.host]);
      let crossConfigPath;
      if (process.env.ROCKETBRAIN_CROSS_SCHEMA_TEST === '1') {
        // This capability exists only inside this freshly created disposable server.
        await admin.query('CREATE DATABASE `rocketbrain_related` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
        await admin.query('GRANT ALL PRIVILEGES ON rocketbrain_related.* TO ?@?', [config.user, config.host]);
        await admin.query('GRANT SELECT, SHOW VIEW, TRIGGER ON *.* TO ?@?', [config.user, config.host]);
        crossConfigPath = path.join(folder, 'cross-schema.json');
        await fsp.writeFile(crossConfigPath, JSON.stringify({ schemas: [config.database, 'rocketbrain_related'], fixtureId: id }), { mode: 0o600 });
      }
      const [versions] = await admin.query('SELECT VERSION() AS version, @@port AS port, @@bind_address AS bindAddress');
      const configPath = path.join(folder, 'connection.json');
      await fsp.writeFile(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
      return { id, folder, datadir, configPath, crossConfigPath, config, pipeName, withAdmin, runtime, process: child, server: versions[0], stop, close: stop };
    } finally { await admin.end(); }
  } catch (error) {
    let detail = '';
    for (const file of ['server-error.log', 'server-console.log']) {
      try { detail += (await fsp.readFile(path.join(folder, file), 'utf8')).slice(-4000); } catch {}
    }
    detail = detail.replaceAll(adminPassword, '[redacted]').replaceAll(password, '[redacted]');
    await stop().catch(() => {});
    if (detail) error.message += '\n' + detail;
    throw error;
  }
}
async function main() {
  if (process.argv[2] === 'runtime') { const runtime = await ensureMysqlRuntime(process.env.ROCKETBRAIN_TEST_MYSQL_VERSION); console.log(JSON.stringify(runtime, null, 2)); return; }
  const fixture = await startMysqlFixture({namedPipe:process.env.ROCKETBRAIN_FIXTURE_NAMED_PIPE==='1'});
  console.log(JSON.stringify({ status: 'ready', engine: 'Oracle MySQL', version: fixture.server.version, id: fixture.id, port: fixture.config.port, configPath: fixture.configPath, installedService: false }));
  try {
    if (process.argv[2] === 'run') {
      const args = process.argv.slice(3); if (!args.length) throw new Error('Pass Node arguments after run.');
      process.exitCode = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, args, { cwd: WORKSPACE, windowsHide: true, stdio: 'inherit', env: { ...process.env,
          ROCKETBRAIN_TEST_MYSQL_ENGINE: 'mysql', ROCKETBRAIN_DB_DISPOSABLE: '1', ROCKETBRAIN_TEST_MYSQL_JSON: JSON.stringify(fixture.config),
          ROCKETBRAIN_TEST_MYSQL_CONFIG: fixture.configPath, ROCKETBRAIN_MYSQL_TEST_CONFIG: fixture.configPath,
          ...(fixture.pipeName?{ROCKETBRAIN_TEST_MYSQL_PIPE:fixture.pipeName}:{}),
          ...(fixture.crossConfigPath ? { ROCKETBRAIN_SCHEMA_CROSS_CONFIG: fixture.crossConfigPath } : {}) } });
        child.once('error', reject); child.once('exit', code => resolve(code ?? 1));
      });
    } else if (process.argv[2] === 'start') {
      const end = async () => { await fixture.stop(); process.exit(); };
      process.once('SIGINT', end); process.once('SIGTERM', end);
      await new Promise(resolve => fixture.process.once('exit', resolve));
    } else {
      const connection = await mysql.createConnection(fixture.config);
      try { const [rows] = await connection.query('SELECT COUNT(*) AS count FROM people'); console.log(JSON.stringify({ engine: 'Oracle MySQL', count: rows[0].count, version: fixture.server.version, sha256: fixture.runtime.actualSha256 })); }
      finally { await connection.end(); }
    }
  } finally { await fixture.stop(); }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { startMysqlFixture };
