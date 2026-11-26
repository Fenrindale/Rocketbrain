'use strict';

const net = require('node:net');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { hostFingerprint, openPinnedSsh, userAuthModes } = require('../db/connection-ssh-credentials');

const timeoutMs = 20000;
const maxBytes = 2 * 1024 * 1024;
const digest = input => createHash('sha256').update(input).digest('hex');
const endOfDirectory = error => error?.code === 1;
const missing = error => error?.code === 2;
const segment = value => typeof value === 'string' && value && value !== '.' && value !== '..' && value.isWellFormed() &&
  Buffer.byteLength(value) <= 255 && !/[\\/:\x00-\x1f\x7f]/u.test(value);

function relativePath(value, allowRoot = false) {
  if (allowRoot && value === '') return '';
  if (typeof value !== 'string' || Buffer.byteLength(value) > 1024 || value.split('/').length > 16 || value.split('/').some(part => !segment(part))) {
    throw Error('Choose a relative SFTP path with ordinary directory and file names.');
  }
  return value;
}

function profileFor(value) {
  const { label, host, port = 22, user, root, hostFingerprint: pin, authentication, privateKeyPath } = value ?? {};
  const hostname = typeof host === 'string' && (net.isIP(host) || /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.\-]*[a-z0-9])?$/i.test(host));
  if (typeof label !== 'string' || !label.trim() || Buffer.byteLength(label) > 80 || /[\x00-\x1f]/.test(label) || !hostname ||
      !Number.isInteger(port) || port < 1 || port > 65535 || typeof user !== 'string' || !/^[\w.@+\\\/-]{1,80}$/u.test(user) ||
      !userAuthModes.has(authentication) || typeof root !== 'string' || !root.startsWith('/')) {
    throw Error('Configure an SFTP label, host, port, account, and absolute remote root.');
  }
  if (root !== '/') relativePath(root.slice(1));
  if (authentication === 'encrypted-key' && (typeof privateKeyPath !== 'string' || !path.isAbsolute(privateKeyPath))) {
    throw Error('Select a local encrypted OpenSSH private key for the SFTP profile.');
  }
  return { label: label.trim(), host, port, user, root, hostFingerprint: hostFingerprint(pin), authentication,
    ...(authentication === 'encrypted-key' && { privateKeyPath }) };
}

function invoke(target, method, args, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => finish(signal.reason);
    const finish = (error, ...data) => {
      signal.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(data);
    };
    signal.addEventListener('abort', abort, { once: true });
    try { target[method](...args, finish); }
    catch (error) { finish(error); }
  });
}

function sameFile(before, after) {
  return after?.isFile() && !after.isSymbolicLink() && ['mode','uid','gid','mtime','size'].every(key => before[key] === after[key]);
}

function channel(sftp, profile, signal) {
  const call = async (method, ...args) => (await invoke(sftp, method, args, signal))[0];
  // ssh2 1.17.0 exposes the negotiated extension map through this member.
  const atomicReplace = sftp._extensions?.['posix-rename@openssh.com'] === '1';

  async function lstat(filename) {
    try { return await call('lstat', filename); }
    catch (error) { if (!missing(error)) throw error; }
  }

  async function directory(relative = '') {
    const target = path.posix.join(profile.root, relativePath(relative, true));
    let current = '/';
    for (const name of target.split('/').filter(Boolean)) {
      current = path.posix.join(current, name);
      const attrs = await lstat(current);
      if (!attrs?.isDirectory() || attrs.isSymbolicLink()) throw Error('Choose an existing remote directory without symbolic links.');
    }
    const canonical = await call('realpath', target);
    if (canonical !== target) throw Error('The scoped remote directory resolved to a different location.');
    return target;
  }

  async function target(relative) {
    const safe = relativePath(relative);
    const dir = path.posix.dirname(safe);
    const parent = await directory(dir === '.' ? '' : dir);
    return path.posix.join(parent, path.posix.basename(safe));
  }

  async function withHandle(handle, action) {
    try { return await action(); }
    finally { await invoke(sftp, 'close', [handle], AbortSignal.timeout(3000)); }
  }

  async function readAbsolute(filename) {
    const before = await lstat(filename);
    if (!before) return { exists: false, sha256: null };
    if (!before.isFile() || before.isSymbolicLink() || !Number.isSafeInteger(before.size) || before.size < 0 || before.size > maxBytes ||
        await call('realpath', filename) !== filename) throw Error('Choose one regular remote file of at most 2 MiB inside the configured root.');
    const handle = await call('open', filename, 'r');
    return withHandle(handle, async () => {
      if (!sameFile(before, await call('fstat', handle)) || await call('realpath', filename) !== filename) throw Error('The remote file changed while opening it.');
      const data = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < data.length) {
        const bytes = await call('read', handle, data, offset, Math.min(data.length - offset, 32768), offset);
        if (!Number.isInteger(bytes) || bytes < 1) throw Error('The remote file changed while reading it.');
        offset += bytes;
      }
      if (!sameFile(before, await call('fstat', handle)) || !sameFile(before, await lstat(filename))) throw Error('The remote file changed while reading it.');
      return { exists: true, bytes: data, sha256: digest(data), mode: before.mode & 0o777, uid: before.uid, gid: before.gid };
    });
  }

  return { atomicReplace, target,
    async list(relative) {
      const folder = await directory(relative);
      const handle = await call('opendir', folder);
      return withHandle(handle, async () => {
        const entries = [];
        for (;;) {
          let batch;
          try { batch = await call('readdir', handle); }
          catch (error) { if (endOfDirectory(error)) break; throw error; }
          if (!Array.isArray(batch)) throw Error('The SFTP directory returned an invalid listing.');
          for (const item of batch) {
            if (!segment(item.filename)) continue;
            const kind = item.attrs.isSymbolicLink() ? 'link' : item.attrs.isDirectory() ? 'directory' : item.attrs.isFile() ? 'file' : 'other';
            entries.push({ name: item.filename, kind, ...(kind === 'file' && { bytes: item.attrs.size }) });
            if (entries.length > 256) throw Error('Choose a remote folder with at most 256 listed entries.');
          }
        }
        return entries.sort((a, b) => a.name.localeCompare(b.name));
      });
    },
    async inspect(relative) {
      const filename = await target(relative), attrs = await lstat(filename);
      return { filename, kind: !attrs ? 'missing' : attrs.isSymbolicLink() ? 'link' : attrs.isDirectory() ? 'directory' : attrs.isFile() ? 'file' : 'other' };
    },
    async read(relative) { return readAbsolute(await target(relative)); },
    async makeDirectory(relative) { return call('mkdir', await target(relative), { mode: 0o750 }); },
    async writeStage(filename, data, mode, created) {
      const handle = await call('open', filename, 'wx', mode);
      created();
      await withHandle(handle, async () => {
        for (let position = 0; position < data.length; position += 32768) {
          await call('write', handle, data, position, Math.min(data.length - position, 32768), position);
        }
      });
      const verified = await readAbsolute(filename);
      if (verified.sha256 !== digest(data)) throw Error('The staged SFTP bytes did not match the reviewed local source.');
      return verified;
    },
    async rename(stage, destination, replace) {
      if (replace && !atomicReplace) throw Error('The remote server does not advertise atomic POSIX replacement.');
      return call(replace ? 'ext_openssh_rename' : 'rename', stage, destination);
    },
    async clearStage(filename) {
      try { await invoke(sftp, 'unlink', [filename], AbortSignal.timeout(3000)); }
      catch (error) { if (!missing(error)) throw error; }
    }
  };
}

async function withSftp(profile, credential, signal, action) {
  const duration = AbortSignal.timeout(timeoutMs);
  const disconnected = new AbortController();
  const limit = AbortSignal.any([duration, disconnected.signal, ...(signal ? [signal] : [])]);
  const connection = await openPinnedSsh(profile, { credential, cancellation: limit,
    onExit: () => disconnected.abort(Error('The verified SFTP connection closed.')) });
  try {
    const [sftp] = await invoke(connection.client, 'sftp', [], limit);
    return await action(channel(sftp, profile, limit));
  } catch (error) {
    if (Number.isInteger(error?.code)) {
      throw Object.assign(Error('The SFTP server rejected the requested operation with status ' + error.code + '.'), { code: error.code });
    }
    throw error;
  } finally { await connection.dispose(); }
}

module.exports = { profileFor, relativePath, withSftp, digest, maxBytes };
