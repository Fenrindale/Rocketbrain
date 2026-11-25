'use strict';

const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { setTimeout: wait } = require('node:timers/promises');
const { promisify } = require('node:util');
const mysql = require('mysql2');
const { createConnectionProfiles } = require('../src/db/connection-profiles');
const { MysqlService } = require('../src/db/mysql');

const images = {
  mysql: {
    // Docker Hub library/mysql, 8.4.13 image index.
    reference: 'docker.io/library/mysql:8.4.13@sha256:8c233bad33d520a7aae1c1e619c3a9775f4a1ba2d463d692fada04ec7f40be00',
    administrator: 'mysqladmin',
    environmentPrefix: 'MYSQL',
    flags: ['--mysqlx=0']
  },
  mariadb: {
    // Docker Hub library/mariadb, 11.4.8 image index.
    reference: 'docker.io/library/mariadb:11.4.8@sha256:bc474f00629f0123c10f9e1bca193a45d18af15a274cf0656acda64f1086c3b6',
    administrator: 'mariadb-admin',
    environmentPrefix: 'MARIADB',
    flags: []
  }
};
const database = 'rocketbrain_socket';
const user = 'rocketbrain_socket_probe';
const mount = '/run/mysqld';
const containerSocket = mount + '/rocketbrain.sock';
const exec = promisify(execFile);

async function docker(args, timeout = 10000) {
  const env = { ...process.env };
  delete env.DOCKER_HOST;
  delete env.DOCKER_CONTEXT;
  try {
    const { stdout } = await exec('docker', ['--host=unix:///var/run/docker.sock', ...args], { env, timeout, maxBuffer: 512 * 1024 });
    return stdout.trim();
  } catch (error) {
    // Initializer output may contain server-side diagnostics. Keep only a bounded Docker status in the smoke log.
    throw Error('Docker ' + args[0] + ' failed' + (error.code !== undefined ? ' (' + error.code + ')' : '') + '.');
  }
}

async function waitForServer(id, address, administrator) {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const running = await docker(['inspect', '--format', '{{.State.Running}}', id]);
    if (running !== 'true') throw Error('The disposable database stopped before opening its Unix socket.');
    if ((await fs.lstat(address).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    }))?.isSocket()) {
      try {
        // The initialization daemon also opens a socket. Wait for the final daemon running as the container PID 1.
        await docker(['exec', id, '/bin/sh', '-c',
          'case "$(cat /proc/1/comm)" in mysqld|mariadbd) exec "$@" ;; *) exit 1 ;; esac', 'check',
          administrator, '--protocol=SOCKET', '--socket=' + containerSocket, '--connect-timeout=1', 'ping'], 5000);
        return;
      } catch { /* Continue until the final server owns the socket and accepts connections. */ }
    }
    await wait(750);
  }
  throw Error('The owned database did not become ready on its Unix socket within two minutes.');
}

async function proveProfile(engine, address, password) {
  const state = new Map(), secrets = new Map();
  let active, opened = 0;
  function createService(config) {
    return new MysqlService(config, {
      createConnection(options) {
        assert.equal(options.socketPath, address);
        assert.equal(options.host, undefined);
        assert.equal(options.port, undefined);
        assert.equal(options.stream, undefined);
        opened++;
        return mysql.createConnection(options);
      }
    });
  }
  const profiles = createConnectionProfiles({
    state: { get: (key, fallback) => state.get(key) ?? fallback, async update(key, value) { state.set(key, value); } },
    secrets: { async get(key) { return secrets.get(key); }, async store(key, value) { secrets.set(key, value); },
      async delete(key) { secrets.delete(key); } },
    isTrusted: () => true,
    createService,
    async connect(config) { active = createService(config); await active.metadata(); }
  });
  try {
    const saved = await profiles.save({
      profile: { name: 'Owned Unix fixture', database, user, transport: { kind: 'unix-socket', address } },
      password, rememberPassword: true
    });
    assert.equal(saved.hasSavedPassword, true);
    assert.deepEqual(saved.observed.transport, { kind: 'unix-socket' });
    assert.ok(!JSON.stringify([...state.values()]).includes(password));
    assert.ok((await profiles.schemas({ id: saved.id })).includes(database));
    await profiles.connect({ id: saved.id });
    const catalog = await active.metadata();
    assert.ok(catalog.tables.some(table => table.name === 'socket_probe'));
    const sessionId = 'unix-proof';
    const session = await active.openSession(sessionId);
    assert.equal(session.readOnly, true);
    const { rows: [row] } = await active.query('SELECT VERSION(), DATABASE(), @@socket, @@skip_networking, CURRENT_USER()', { sessionId });
    const [version, schema, observedSocket, skipNetworking, account] = row;
    assert.equal(/MariaDB/i.test(version), engine === 'mariadb');
    assert.equal(schema, database);
    assert.equal(observedSocket, containerSocket);
    assert.equal(Number(skipNetworking), 1);
    assert.equal(account.split('@')[0], user);
    const bound = await active.query('SELECT label FROM socket_probe WHERE id = ?', { sessionId, values: [2] });
    assert.deepEqual(bound.rows, [['socket path']]);
    const exported = profiles.exportProfiles();
    assert.equal(exported.version, 2);
    assert.deepEqual(exported.profiles[0].transport, { kind: 'unix-socket' });
    const share = JSON.stringify(exported);
    assert.ok(!share.includes(address) && !share.includes(password));
    assert.ok(opened >= 4);
    return { engine, version, unixSocket: true, tcpDisabled: true, savedProfile: true,
      metadata: true, boundQuery: true, secretAndPathRedaction: true, driverConnections: opened };
  } finally {
    try { await active?.dispose(); }
    finally { await profiles.dispose(); }
  }
}

async function main(engine) {
  if (process.platform !== 'linux' || !Object.hasOwn(images, engine)) throw Error('Choose mysql or mariadb on a Linux host with Docker.');
  const image = images[engine], root = await fs.mkdtemp('/tmp/rb-db-ipc-');
  const socketDir = path.join(root, 'socket'), address = path.join(socketDir, 'rocketbrain.sock');
  const cidfile = path.join(root, 'container.id'), password = randomBytes(36).toString('base64url');
  const secretsDir = path.join(root, 'credentials'), seed = path.join(root, 'seed.sql');
  let proof, id;
  try {
    await fs.mkdir(socketDir);
    // The image daemon uses its own UID. Only this child directory needs write access, under the 0700 fixture root.
    await fs.chmod(socketDir, 0o777);
    await fs.mkdir(secretsDir);
    await fs.chmod(secretsDir, 0o755);
    await fs.writeFile(path.join(secretsDir, 'root'), randomBytes(36).toString('base64url'), { mode: 0o444, flag: 'wx' });
    await fs.writeFile(path.join(secretsDir, 'probe'), password, { mode: 0o444, flag: 'wx' });
    await fs.writeFile(seed, 'USE rocketbrain_socket;\n' +
      'CREATE TABLE socket_probe (id INT PRIMARY KEY, label VARCHAR(30) NOT NULL);\n' +
      "INSERT INTO socket_probe VALUES (1, 'fixture'), (2, 'socket path');\n", { mode: 0o444, flag: 'wx' });
    const prefix = image.environmentPrefix;
    id = await docker(['create', '--platform', 'linux/amd64', '--network', 'none', '--cidfile', cidfile,
      '--mount', 'type=bind,src=' + socketDir + ',dst=' + mount,
      '--mount', 'type=bind,src=' + secretsDir + ',dst=/run/rb-credentials,readonly',
      '--mount', 'type=bind,src=' + seed + ',dst=/docker-entrypoint-initdb.d/80-source-probe.sql,readonly',
      '--tmpfs', '/var/lib/mysql:rw,nosuid,size=512m',
      '--env', prefix + '_ROOT_HOST=localhost', '--env', prefix + '_ROOT_PASSWORD_FILE=/run/rb-credentials/root',
      '--env', prefix + '_DATABASE=' + database, '--env', prefix + '_USER=' + user,
      '--env', prefix + '_PASSWORD_FILE=/run/rb-credentials/probe',
      '--env', prefix + '_INITDB_SKIP_TZINFO=1',
      image.reference, '--socket=' + containerSocket, '--skip-networking', ...image.flags], 240000);
    assert.match(id, /^[0-9a-f]{64}$/);
    await docker(['start', id]);
    await waitForServer(id, address, image.administrator);
    proof = await proveProfile(engine, address, password);
    await docker(['rm', '-fv', id]);
    id = undefined;
    await fs.unlink(cidfile);
  } finally {
    const container = id || (await fs.readFile(cidfile, 'utf8').catch(error => {
      if (error.code !== 'ENOENT') throw error;
    }))?.trim();
    try {
      if (/^[0-9a-f]{64}$/.test(container || '')) await docker(['rm', '-fv', container]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
  console.log(JSON.stringify({ ...proof, image: image.reference, containerRemoved: true, fixtureFilesRemoved: true }));
}

main(process.env.ROCKETBRAIN_UNIX_TEST_ENGINE).catch(error => {
  console.error('Unix database transport verification failed. ' + error.message);
  process.exitCode = 1;
});
