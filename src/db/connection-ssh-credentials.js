'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { createHash, timingSafeEqual } = require('node:crypto');

const maxKeyBytes = 64 * 1024;
const maxChannels = 24;
const timeoutMs = 10000;
const userAuthModes = new Set(['password', 'encrypted-key']);
const hostAlgorithms = ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'rsa-sha2-512', 'rsa-sha2-256'];
const fail = message => Object.assign(new Error(message), { code: 'ROCKETBRAIN_SSH' });
const cancelled = signal => signal?.aborted || signal?.isCancellationRequested;
const keyProblem = () => fail('Select one passphrase-protected OpenSSH private key with a supported cipher and bcrypt work factor.');

function hostFingerprint(value) {
  if (typeof value !== 'string' || !/^SHA256:[A-Za-z0-9+/]{43}$/u.test(value)) {
    throw fail('Enter the verified OpenSSH SHA-256 host-key fingerprint.');
  }
  const digest = Buffer.from(value.slice(7), 'base64');
  if (digest.length !== 32 || digest.toString('base64').slice(0, -1) !== value.slice(7)) {
    throw fail('Enter the verified OpenSSH SHA-256 host-key fingerprint.');
  }
  return value;
}

function credentialFor(mode, value) {
  if (!userAuthModes.has(mode)) {
    if (value !== undefined) throw fail('Select password or encrypted-key SSH authentication before supplying an SSH credential.');
    return undefined;
  }
  if (typeof value !== 'string' || !value || value.includes('\0') || Buffer.byteLength(value) > 4096) {
    throw fail(mode === 'password' ? 'Enter the SSH password for this attempt.' : 'Enter the SSH key passphrase for this attempt.');
  }
  return value;
}

function validateEncryptedKey(bytes) {
  const keyType = 'OPENSSH PRIVATE KEY';
  const lines = bytes.toString('ascii').trimEnd().split(/\r?\n/);
  if (lines.shift() !== '-----BEGIN ' + keyType + '-----' || lines.pop() !== '-----END ' + keyType + '-----') throw keyProblem();
  const armor = lines.join('');
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(armor)) throw keyProblem();
  const binary = Buffer.from(armor, 'base64');
  try {
    const header = Buffer.from('openssh-key-v1\0');
    if (!binary.subarray(0, header.length).equals(header)) throw keyProblem();
    let offset = header.length;
    function nextField() {
      if (offset + 4 > binary.length) throw keyProblem();
      const size = binary.readUInt32BE(offset);
      offset += 4;
      const end = offset + size;
      if (end > binary.length) throw keyProblem();
      const value = binary.subarray(offset, end);
      offset = end;
      return value;
    }
    const cipher = nextField().toString('ascii'), kdf = nextField().toString('ascii'), options = nextField();
    if (!['aes128-ctr', 'aes192-ctr', 'aes256-ctr', 'aes128-cbc', 'aes192-cbc', 'aes256-cbc'].includes(cipher) ||
        kdf !== 'bcrypt' || options.length < 8 || options.readUInt32BE(0) !== options.length - 8 ||
        options.length > 72 || offset + 4 > binary.length || binary.readUInt32BE(offset) !== 1) throw keyProblem();
    const rounds = options.readUInt32BE(options.length - 4);
    if (!rounds || rounds > 64) throw keyProblem();
  } finally { binary.fill(0); }
}

async function readEncryptedKey(file, passphrase, parseKey) {
  let handle, bytes;
  try {
    if (typeof file !== 'string' || !path.isAbsolute(file) || /[\0\r\n]/u.test(file) ||
        process.platform === 'win32' && !/^[A-Za-z]:[\\/]/u.test(file)) throw keyProblem();
    const target = await fs.realpath(file);
    if (!path.isAbsolute(target) || process.platform === 'win32' && !/^[A-Za-z]:[\\/]/u.test(target)) throw keyProblem();
    if (!(await fs.stat(target)).isFile()) throw keyProblem();
    handle = await fs.open(target, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || !stat.size || stat.size > maxKeyBytes) throw keyProblem();
    bytes = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await handle.read(bytes);
    if (bytesRead !== stat.size) throw keyProblem();
    const key = bytes.subarray(0, bytesRead);
    validateEncryptedKey(key);
    const parsed = parseKey(key, passphrase);
    const single = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : parsed;
    if (!single?.isPrivateKey?.()) throw fail('The encrypted SSH key could not be unlocked with this passphrase.');
    return single;
  } catch (error) {
    if (error?.code === 'ROCKETBRAIN_SSH') throw error;
    throw keyProblem();
  } finally {
    bytes?.fill(0);
    await handle?.close();
  }
}

function waitForReady(client, options, signal, verify) {
  return new Promise((resolve, reject) => {
    let cancellation;
    function done(error) {
      clearTimeout(deadline);
      signal?.removeEventListener?.('abort', onAbort);
      cancellation?.dispose();
      client.removeListener('ready', onReady);
      client.removeListener('error', onError);
      client.removeListener('close', onError);
      client.removeListener('change password', onPasswordChange);
      error ? reject(error) : resolve();
    }
    const onAbort = () => done(fail('SSH connection cancelled.'));
    const onReady = () => done(verify() ? null : fail('SSH host-key verification failed. Review the pinned host key.'));
    const onError = error => done(error?.level === 'client-authentication'
      ? fail('The SSH server rejected the selected authentication method or credential.')
      : fail(verify() === false ? 'SSH host-key verification failed. Review the pinned host key.' : 'The owned SSH connection could not be established.'));
    const onPasswordChange = () => done(fail('The SSH server requires a password change. Change it separately before connecting.'));
    const deadline = setTimeout(() => done(fail('SSH authentication timed out.')), timeoutMs);
    client.once('ready', onReady);
    client.once('error', onError);
    client.once('close', onError);
    client.once('change password', onPasswordChange);
    signal?.addEventListener?.('abort', onAbort, { once: true });
    cancellation = signal?.onCancellationRequested?.(onAbort);
    if (cancelled(signal)) { onAbort(); return; }
    try { client.connect(options); }
    catch { onError(); }
  });
}

async function openPinnedTunnel(ssh, destination, { credential, cancellation, onExit } = {}) {
  const expected = Buffer.from(hostFingerprint(ssh.hostFingerprint).slice(7), 'base64');
  credential = credentialFor(ssh.authentication, credential);
  if (cancelled(cancellation)) throw fail('SSH connection cancelled.');
  const { Client, utils } = require('ssh2');
  let authentication = Buffer.from(credential, 'utf8');
  credential = undefined;
  let privateKey;
  if (ssh.authentication === 'encrypted-key') {
    try { privateKey = await readEncryptedKey(ssh.privateKeyPath, authentication, utils.parseKey); }
    finally { authentication.fill(0); }
  }
  let acceptedPin, attempted = false, established = false, closed;
  const client = new Client(), transport = new net.Socket(), sockets = new Set();
  const transportClosed = new Promise(resolve => transport.once('close', resolve));
  const server = net.createServer({ pauseOnConnect: true }, local => {
    local.on('error', () => {});
    if (closed || sockets.size >= maxChannels) { local.destroy(); return; }
    sockets.add(local);
    let channel;
    const timer = setTimeout(() => local.destroy(), timeoutMs);
    local.once('close', () => { clearTimeout(timer); sockets.delete(local); channel?.destroy(); });
    try {
      client.forwardOut('127.0.0.1', local.remotePort, destination.host, destination.port, (error, stream) => {
        clearTimeout(timer);
        if (error || closed || local.destroyed) { stream?.destroy(); local.destroy(); return; }
        channel = stream;
        channel.on('error', () => local.destroy());
        channel.once('close', () => local.destroy());
        local.pipe(channel).pipe(local);
      });
    } catch { local.destroy(); }
  });
  server.maxConnections = maxChannels;
  function dispose() {
    if (!closed) {
      const listenerClosed = new Promise(resolve => {
        if (server.listening) server.close(resolve);
        else resolve();
      });
      closed = Promise.all([transportClosed, listenerClosed]).then(() => undefined);
      for (const socket of sockets) socket.destroy();
      transport.destroy();
    }
    return closed;
  }
  function lost() {
    if (closed) return;
    void dispose();
    if (established) onExit?.();
  }
  transport.on('error', () => {});
  client.on('error', () => { if (established) lost(); });
  client.on('close', () => { if (established) lost(); });
  server.on('error', () => { if (established) lost(); });

  try {
    transport.connect({ host: ssh.host, port: ssh.port });
    await waitForReady(client, {
      host: ssh.host, port: ssh.port, sock: transport, username: ssh.user, readyTimeout: timeoutMs,
      keepaliveInterval: 15000, keepaliveCountMax: 2, algorithms: { serverHostKey: hostAlgorithms },
      hostVerifier(key) {
        acceptedPin = timingSafeEqual(createHash('sha256').update(key).digest(), expected);
        return acceptedPin;
      },
      authHandler(_methods, _partial, done) {
        if (acceptedPin !== true || attempted) { done(false); return; }
        attempted = true;
        if (privateKey) {
          const key = privateKey;
          privateKey = undefined;
          done({ type: 'publickey', username: ssh.user, key });
        } else {
          // ssh2 consumes the Buffer synchronously and retains the same zeroed copy.
          try { done({ type: 'password', username: ssh.user, password: authentication }); }
          finally { authentication.fill(0); }
        }
      }
    }, cancellation, () => acceptedPin);
    if (!attempted || cancelled(cancellation) || transport.destroyed) throw fail('The selected SSH authentication did not complete.');
    await new Promise((resolve, reject) => {
      function onError() { reject(fail('The owned SSH loopback listener could not start.')); }
      server.once('error', onError);
      server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => { server.removeListener('error', onError); resolve(); });
    });
    if (cancelled(cancellation) || transport.destroyed) throw fail('The owned SSH connection closed before forwarding was ready.');
    established = true;
    return { endpoint: { host: '127.0.0.1', port: server.address().port }, dispose };
  } catch (error) {
    await dispose();
    if (error?.code === 'ROCKETBRAIN_SSH') throw error;
    throw fail('The owned SSH connection could not be established.');
  } finally { authentication.fill(0); privateKey = undefined; }
}

module.exports = { openPinnedTunnel, userAuthModes, hostFingerprint, credentialFor };
