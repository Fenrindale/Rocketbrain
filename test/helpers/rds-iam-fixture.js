'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const tls = require('node:tls');
const { randomBytes, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');

const target = Object.freeze({ host: 'fixture-db.rbtest123456.us-east-1.rds.amazonaws.com', port: 3306, user: 'rb_iam_user',
  auth: Object.freeze({ kind: 'aws-rds-iam', region: 'us-east-1', source: 'environment' }) });
const access = 'RBTESTEXAMPLEID', key = 'Rocketbrain-offline-signature-fixture-key', token = 'synthetic/session+test=value';

async function setupWireTlsFixture(serverName, prefix = 'rb-rds-iam-') {
  const parent = await fs.realpath(os.tmpdir());
  const folder = await fs.mkdtemp(path.join(parent, prefix));
  const marker = randomUUID();
  const owner = path.join(folder, 'owner.json');
  await fs.writeFile(owner, marker, { flag: 'wx' });
  async function close() {
    const resolved = await fs.realpath(folder);
    if (path.dirname(resolved) !== parent || resolved !== folder || await fs.readFile(owner, 'utf8') !== marker) {
      throw Error('The TLS protocol fixture ownership changed.');
    }
    await fs.rm(folder, { recursive: true, maxRetries: 3, retryDelay: 100 });
  }

  try {
    const script = path.resolve(__dirname, '../../scripts/connection-security-certificates.ps1');
    await new Promise((resolve, reject) => {
      const child = spawn(process.env.ROCKETBRAIN_TEST_PWSH || 'pwsh', ['-NoProfile', '-NonInteractive', '-File', script,
        '-Folder', folder, '-ServerName', serverName], { shell: false, windowsHide: true, stdio: 'ignore', timeout: 12000 });
      child.once('error', reject);
      child.once('close', code => code === 0 ? resolve() : reject(Error('The owned TLS certificate fixture could not start.')));
    });
    const read = file => fs.readFile(path.join(folder, file), 'utf8');
    return { folder, caPath: path.join(folder, 'ca.pem'), close, ca: await read('ca.pem'), wrongCa: await read('wrong-ca.pem'),
      cert: await read('server.pem'), privateKey: await read('server-key.pem') };
  } catch (error) { await close(); throw error; }
}

async function setupIamFixture() {
  const wire = await setupWireTlsFixture(target.host);
  const credentials = path.join(wire.folder, 'credentials');
  const config = path.join(wire.folder, 'config');
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('AWS_')));
  Object.assign(env, { AWS_CONFIG_FILE: config, AWS_SHARED_CREDENTIALS_FILE: credentials, AWS_ACCESS_KEY_ID: access,
    AWS_SECRET_ACCESS_KEY: key, AWS_SESSION_TOKEN: token, AWS_EC2_METADATA_DISABLED: 'true' });
  try {
    await fs.writeFile(credentials, `[fixture-rds]\naws_access_key_id = ${access}\naws_secret_access_key = ${key}\naws_session_token = ${token}\n`, { flag: 'wx' });
    await fs.writeFile(config, '[profile fixture-rds]\nregion = us-east-1\n', { flag: 'wx' });
    return { ...wire, env };
  } catch (error) { await wire.close(); throw error; }
}

function send(socket, sequence, payload) {
  const header = Buffer.alloc(4);
  header.writeUIntLE(payload.length, 0, 3);
  header[3] = sequence;
  socket.write(Buffer.concat([header, payload]));
}

function greeting(identity, secure) {
  const version = Buffer.from('8.4.13-Rocketbrain-Protocol-Fixture\0');
  const salt = randomBytes(20);
  const head = Buffer.alloc(21);
  const flags = 1 | 4 | 8 | 512 | 8192 | 32768 | 131072 | 524288 | 1048576 | 2097152 | (secure ? 2048 : 0);
  head.writeUInt32LE(identity, 0);
  salt.copy(head, 4, 0, 8);
  head.writeUInt16LE(flags & 0xffff, 13);
  head[15] = 45;
  head.writeUInt16LE(2, 16);
  head.writeUInt16LE(flags >>> 16, 18);
  head[20] = 21;
  return Buffer.concat([Buffer.from([10]), version, head, Buffer.alloc(10), salt.subarray(8), Buffer.from('\0mysql_native_password\0')]);
}

function frames(stream, received) {
  let buffer = Buffer.alloc(0);
  const visit = chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const end = buffer.readUIntLE(0, 3) + 4;
      if (end > 32772) { stream.destroy(); return; }
      if (buffer.length < end) return;
      const packet = buffer.subarray(4, end), sequence = buffer[3];
      buffer = buffer.subarray(end);
      try {
        if (received(packet, sequence, buffer) === false) { stream.off('data', visit); return; }
      } catch { stream.destroy(); return; }
    }
  };
  stream.on('data', visit);
  return () => stream.off('data', visit);
}

async function mysqlIamEndpoint(credentials, { secure = true, requestToken = true, rejectToken = false, verify, databaseUser = target.user } = {}) {
  const context = tls.createSecureContext({ cert: credentials.cert, key: credentials.privateKey, minVersion: 'TLSv1.2' });
  const sockets = new Set(), state = { initialEmpty: 0, receivedTokens: 0, accepted: 0, commands: [] };
  const ok = Buffer.from([0, 0, 0, 2, 0, 0, 0]);
  let id = 100;
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
    send(socket, 0, greeting(++id, secure));
    const stopRaw = frames(socket, (payload, sequence, rest) => {
      assert(secure && sequence === 1 && payload.length === 32 && (payload.readUInt32LE(0) & 2048));
      stopRaw();
      socket.pause();
      if (rest.length) socket.unshift(rest);
      const stream = new tls.TLSSocket(socket, { isServer: true, secureContext: context });
      stream.on('error', () => {});
      let phase = 'login';
      frames(stream, (packet, number) => {
        if (phase === 'login') {
          assert.equal(number, 2);
          const usernameEnds = packet.indexOf(0, 32);
          assert.equal(packet.subarray(32, usernameEnds).toString('utf8'), databaseUser);
          assert.equal(packet[usernameEnds + 1], 0);
          state.initialEmpty++;
          phase = requestToken ? 'token' : 'query';
          if (requestToken) send(stream, 3, Buffer.from('\xfemysql_clear_password\0', 'latin1'));
          else send(stream, 3, ok);
          return;
        }
        if (phase === 'token') {
          assert.equal(number, 4);
          assert.equal(packet.at(-1), 0);
          state.receivedTokens++;
          verify?.(packet.subarray(0, -1).toString('utf8'));
          if (rejectToken) {
            const denied = Buffer.concat([Buffer.from([0xff, 0x15, 0x04]), Buffer.from('#28000Fixture authentication denied')]);
            send(stream, 5, denied);
            return false;
          }
          state.accepted++;
          phase = 'query';
          send(stream, 5, ok);
          return;
        }
        if (packet[0] === 1) { stream.end(); return false; }
        const sql = packet.subarray(1).toString('utf8');
        assert(packet[0] === 3 && ['SET SESSION TRANSACTION READ ONLY', 'DO 0'].includes(sql));
        state.commands.push(sql);
        send(stream, 1, ok);
      });
      stream.resume();
      return false;
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { state, port: server.address().port, disconnect() { for (const socket of sockets) socket.destroy(); },
    async close() { this.disconnect(); await new Promise(resolve => server.close(resolve)); } };
}

module.exports = { target, access, key, token, setupWireTlsFixture, setupIamFixture, mysqlIamEndpoint };
