'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { createCipheriv, createHash, generateKeyPairSync, randomBytes, randomInt } = require('node:crypto');
const { createRequire } = require('node:module');
const { Server, utils } = require('ssh2');

const integer = n => { const value = Buffer.alloc(4); value.writeUInt32BE(n); return value; };
const field = data => { const value = Buffer.from(data); return Buffer.concat([integer(value.length), value]); };

function openSshTestKey(passphrase) {
  const { privateKey } = generateKeyPairSync('ed25519');
  const { x, d } = privateKey.export({ format: 'jwk' });
  const publicBytes = Buffer.from(x, 'base64url'), seed = Buffer.from(d, 'base64url');
  const name = field('ssh-ed25519'), identity = Buffer.concat([name, field(publicBytes)]);
  const check = integer(randomInt(0, 2 ** 32));
  const plain = Buffer.concat([check, check, identity, field(Buffer.concat([seed, publicBytes])), field('rocketbrain fixture')]);
  const blockSize = passphrase ? 16 : 8;
  const pad = Buffer.from(Array.from({ length: blockSize - plain.length % blockSize }, (_, i) => i + 1));
  let payload = Buffer.concat([plain, pad]), cipher = 'none', kdf = 'none', options = Buffer.alloc(0);
  try {
    if (passphrase) {
      const { pbkdf } = createRequire(require.resolve('ssh2'))('bcrypt-pbkdf');
      const salt = randomBytes(16), derivation = Buffer.alloc(48), secret = Buffer.from(passphrase);
      try {
        const rounds = 8;
        if (pbkdf(secret, secret.length, salt, salt.length, derivation, derivation.length, rounds) !== 0) throw Error('Fixture key encryption failed.');
        const aes = createCipheriv('aes-256-ctr', derivation.subarray(0, 32), derivation.subarray(32));
        const ciphertext = Buffer.concat([aes.update(payload), aes.final()]);
        payload.fill(0);
        payload = ciphertext;
        cipher = 'aes256-ctr'; kdf = 'bcrypt'; options = Buffer.concat([field(salt), integer(rounds)]);
      } finally { derivation.fill(0); secret.fill(0); }
    }
    const body = Buffer.concat([Buffer.from('openssh-key-v1\0'), field(cipher), field(kdf), field(options), integer(1), field(identity), field(payload)]);
    try {
      const keyType = 'OPENSSH PRIVATE KEY';
      return { identity, armored: '-----BEGIN ' + keyType + '-----\n' +
        body.toString('base64').match(/.{1,70}/g).join('\n') + '\n-----END ' + keyType + '-----\n' };
    } finally { body.fill(0); }
  } finally { seed.fill(0); plain.fill(0); payload.fill(0); }
}

async function createSshCredentialFixture(parent, destination, { stall = false } = {}) {
  const folder = await fs.mkdtemp(path.join(parent, 'ssh-attempt-'));
  const password = randomBytes(18).toString('base64url') + ' å';
  const passphrase = 'ä ' + randomBytes(16).toString('base64url');
  const host = openSshTestKey(), unlocked = openSshTestKey(), encrypted = openSshTestKey(passphrase);
  const privateKeyPath = path.join(folder, 'encrypted');
  const unlockedKeyPath = path.join(folder, 'unlocked');
  const knownHostsPath = path.join(folder, 'known_hosts');
  const clients = new Set(), sockets = new Set();
  const count = { connections: 0, password: 0, publickey: 0, other: 0, forward: 0 };
  const server = new Server({ hostKeys: [host.armored] }, client => {
    count.connections++;
    clients.add(client);
    client.on('error', () => {});
    client.once('close', () => clients.delete(client));
    client.on('authentication', context => {
      if (context.method === 'password') {
        count.password++;
        if (stall) return;
        if (context.username === 'rb_ssh_pw' && context.password === password) { context.accept(); return; }
      } else if (context.method === 'publickey') {
        count.publickey++;
        const accepted = context.username === 'rb_ssh_encrypted' ? encrypted : context.username === 'rb_ssh_unlocked' ? unlocked : null;
        if (accepted && context.key.algo === 'ssh-ed25519' && context.key.data.equals(accepted.identity)) {
          const publicKey = utils.parseKey('ssh-ed25519 ' + accepted.identity.toString('base64'));
          if (!context.signature || publicKey.verify(context.blob, context.signature, context.hashAlgo) === true) { context.accept(); return; }
        }
      } else { count.other++; }
      context.reject(['password', 'publickey']);
    });
    client.on('ready', () => client.on('tcpip', (accept, reject, info) => {
      if (info.destIP !== destination.host || info.destPort !== destination.port) { reject(); return; }
      count.forward++;
      const socket = net.connect(destination);
      sockets.add(socket);
      socket.on('error', () => reject());
      socket.once('close', () => sockets.delete(socket));
      socket.once('connect', () => {
        const channel = accept();
        if (!channel) { socket.destroy(); return; }
        channel.on('error', () => socket.destroy());
        channel.once('close', () => socket.destroy());
        socket.pipe(channel).pipe(socket);
      });
    }));
  });
  let disposed;
  async function close() {
    if (!disposed) disposed = (async () => {
      for (const socket of sockets) socket.destroy();
      for (const client of clients) client.end();
      if (server.address()) await new Promise(resolve => server.close(resolve));
      for (const file of [privateKeyPath, unlockedKeyPath, knownHostsPath]) {
        await fs.unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
      await fs.rmdir(folder);
    })();
    return disposed;
  }
  try {
    await fs.writeFile(privateKeyPath, encrypted.armored, { flag: 'wx', mode: 0o600 });
    await fs.writeFile(unlockedKeyPath, unlocked.armored, { flag: 'wx', mode: 0o600 });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const hostAddress = { host: '127.0.0.1', port: server.address().port };
    const hostFingerprint = 'SHA256:' + createHash('sha256').update(host.identity).digest('base64').slice(0, -1);
    await fs.writeFile(knownHostsPath, '[127.0.0.1]:' + hostAddress.port + ' ssh-ed25519 ' + host.identity.toString('base64') + '\n');
    return { password, passphrase, count, clients, sockets, close,
      passwordProfile: { ...hostAddress, user: 'rb_ssh_pw', authentication: 'password', hostFingerprint },
      keyProfile: { ...hostAddress, user: 'rb_ssh_encrypted', authentication: 'encrypted-key', hostFingerprint, privateKeyPath },
      systemProfile: { ...hostAddress, user: 'rb_ssh_unlocked', privateKeyPath: unlockedKeyPath, knownHostsPath } };
  } catch (error) { await close(); throw error; }
}

async function waitFor(check, message) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw Error(message);
}

module.exports = { createSshCredentialFixture, waitFor };
