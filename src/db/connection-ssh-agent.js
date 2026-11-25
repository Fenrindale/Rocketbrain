'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');

const publicFileBytes = 8192;
const fail = text => Object.assign(new Error(text), { code: 'ROCKETBRAIN_SSH' });

function agentSelection(value, platform = process.platform) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => key !== 'endpoint' && key !== 'publicKeyPath')) {
    throw fail('Choose a local SSH agent endpoint and one OpenSSH Ed25519 public-key file.');
  }
  const { endpoint, publicKeyPath } = value;
  const pipe = /^\\\\\.\\pipe\\[A-Za-z\d_.-]{1,120}$/u;
  if (typeof endpoint !== 'string' || (platform === 'win32' ? !pipe.test(endpoint) :
    !path.posix.isAbsolute(endpoint) || Buffer.byteLength(endpoint) > 103 || /[\0\r\n]/u.test(endpoint))) {
    throw fail(platform === 'win32' ? 'Choose a local Windows named pipe for the SSH agent.' :
      'Choose an absolute Unix socket path for the SSH agent.');
  }
  const paths = platform === 'win32' ? path.win32 : path.posix;
  if (typeof publicKeyPath !== 'string' || publicKeyPath.length > 4096 || /[\0\r\n]/u.test(publicKeyPath) ||
      !paths.isAbsolute(publicKeyPath) || platform === 'win32' && !/^[A-Za-z]:[\\/]/u.test(publicKeyPath)) {
    throw fail('Choose a local absolute OpenSSH public-key file.');
  }
  return { endpoint, publicKeyPath };
}

function decodeEd25519(text) {
  const match = /^ssh-ed25519[ \t]+([A-Za-z0-9+/]{68})(?:[ \t]+[^\r\n]*)?\r?\n?$/u.exec(text);
  if (!match) throw fail('Select a file containing one OpenSSH Ed25519 public key.');
  const key = Buffer.from(match[1], 'base64');
  if (key.length !== 51 || key.readUInt32BE(0) !== 11 || key.toString('ascii', 4, 15) !== 'ssh-ed25519' ||
      key.readUInt32BE(15) !== 32) throw fail('The selected Ed25519 public key is malformed.');
  return { publicLine: 'ssh-ed25519 ' + key.toString('base64') + '\n',
    fingerprint: 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/u, '') };
}

async function readSelection(value) {
  const selection = agentSelection(value);
  let endpoint = selection.endpoint;
  if (process.platform !== 'win32') {
    try {
      endpoint = await fs.realpath(endpoint);
      if (Buffer.byteLength(endpoint) > 103 || !(await fs.stat(endpoint)).isSocket()) throw Error();
    } catch { throw fail('The selected SSH agent Unix socket is unavailable.'); }
  }
  let handle;
  try {
    const file = await fs.realpath(selection.publicKeyPath);
    if (process.platform === 'win32' && !/^[A-Za-z]:[\\/]/u.test(file)) throw Error();
    if (!(await fs.stat(file)).isFile()) throw Error();
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > publicFileBytes) throw Error();
    const bytes = Buffer.alloc(publicFileBytes + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > publicFileBytes) throw Error();
    return { endpoint, ...decodeEd25519(bytes.subarray(0, bytesRead).toString('utf8')) };
  } catch (error) {
    if (error?.code === 'ROCKETBRAIN_SSH') throw error;
    throw fail('Read a regular local OpenSSH public-key file of at most 8 KiB.');
  } finally { await handle?.close(); }
}

async function prepareAgentIdentity(value) {
  const { endpoint, publicLine, fingerprint } = await readSelection(value);
  // OpenSSH sees only this validated public key. No same-name private key or certificate can be found beside it.
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'rocketbrain-ssh-public-'));
  const identity = path.join(folder, 'selected.pub');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'SSH_AUTH_SOCK'));
  env.SSH_AUTH_SOCK = endpoint;
  async function dispose() {
    await fs.unlink(identity).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await fs.rmdir(folder).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  try {
    if (/\$\{/u.test(identity)) throw fail('Use a local temporary directory without OpenSSH expansion syntax.');
    await fs.writeFile(identity, publicLine, { flag: 'wx', mode: 0o600 });
    return {
      options: ['-o', 'IdentityAgent=SSH_AUTH_SOCK', '-o', 'IdentitiesOnly=yes', '-o', 'PreferredAuthentications=publickey',
        '-o', 'UpdateHostKeys=no', '-i', identity.replaceAll('%', '%%')],
      env, fingerprint, dispose
    };
  } catch (error) { await dispose(); throw error; }
}

module.exports = { agentSelection, prepareAgentIdentity };
