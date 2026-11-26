'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

const apiVersion = 'client.authentication.k8s.io/v1';
const maxExecutableBytes = 96 * 1024 * 1024;
const fields = new Set(['apiVersion', 'command', 'args', 'interactiveMode', 'provideClusterInfo', 'env']);
const control = /[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u;
const localFile = value => typeof value === 'string' && value.length <= 768 && path.isAbsolute(value) &&
  !/^[\\/]{2}/u.test(value) && !control.test(value);

function parseExecCredential(exec) {
  if (!exec || typeof exec !== 'object' || Array.isArray(exec) || !Object.keys(exec).every(name => fields.has(name)) ||
      exec.apiVersion !== apiVersion || exec.interactiveMode !== 'Never' || !localFile(exec.command) ||
      (exec.provideClusterInfo !== undefined && exec.provideClusterInfo !== false) ||
      (exec.env !== undefined && (!Array.isArray(exec.env) || exec.env.length))) return null;
  const args = exec.args ?? [];
  if (!Array.isArray(args) || args.length > 24 ||
      args.some(arg => typeof arg !== 'string' || arg.length > 512 || control.test(arg))) return null;
  return { command: exec.command, args: [...args] };
}

async function readExecutable(command) {
  const physical = await fs.realpath(command).catch(() => null);
  if (!localFile(physical) || (process.platform === 'win32' && path.extname(physical).toLowerCase() !== '.exe')) {
    throw Error('Choose an absolute standalone local credential executable.');
  }
  const handle = await fs.open(physical, 'r').catch(() => null);
  if (!handle) throw Error('The credential executable could not be read.');
  try {
    const before = await handle.stat({ bigint: true });
    if (!(before.isFile() && before.size > 0n && before.size <= BigInt(maxExecutableBytes)) ||
        (process.platform !== 'win32' && !(before.mode & 0o100n))) throw Error('Choose a bounded executable file.');
    const bytes = Buffer.allocUnsafe(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const piece = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!piece.bytesRead) throw Error('The credential executable changed while it was read.');
      offset += piece.bytesRead;
    }
    const after = await fs.lstat(physical, { bigint: true });
    if (!after.isFile() || before.size !== after.size || before.ino !== after.ino || before.dev !== after.dev ||
        before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw Error('The credential executable changed while it was read.');
    }
    return { physical, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
  } finally { await handle.close(); }
}

function createCredentialReview(folder) {
  const tickets = new WeakMap();
  return {
    async review(provider) {
      const { physical, sha256 } = await readExecutable(provider.command);
      const receipt = Object.freeze({ file: physical, args: Object.freeze([...provider.args]), sha256 });
      tickets.set(receipt, provider);
      return receipt;
    },
    async stage(provider, receipt) {
      if (tickets.get(receipt) !== provider) throw Error('Approve the reviewed credential executable for this context.');
      tickets.delete(receipt);
      const snapshot = await readExecutable(provider.command);
      if (path.relative(receipt.file, snapshot.physical) !== '' || snapshot.sha256 !== receipt.sha256) {
        throw Error('The credential executable changed. Review the context again.');
      }
      const directory = path.join(folder, 'credential-bin');
      await fs.mkdir(directory, { mode: 0o700 });
      const command = path.join(directory, path.basename(snapshot.physical));
      await fs.writeFile(command, snapshot.bytes, { flag: 'wx', mode: 0o500 });
      return { exec: { apiVersion, command, args: [...provider.args], interactiveMode: 'Never', provideClusterInfo: false } };
    }
  };
}

module.exports = { parseExecCredential, createCredentialReview };
