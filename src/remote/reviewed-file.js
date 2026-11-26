'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const maxFileBytes = 2 * 1024 * 1024;
const hash = input => createHash('sha256').update(input).digest('hex');

async function readSavedWorkspaceFile(root, relative) {
  if (typeof relative !== 'string' || relative.split('/').some(part =>
    !part || part === '.' || part === '..' || /[\\:\x00-\x1f\x7f]/u.test(part))) {
    throw Error('Choose one saved file inside the local workspace.');
  }
  const canonical = await fs.realpath(root);
  if (canonical !== root) throw Error('The local workspace root changed. Review the current source again.');
  let filename = canonical;
  for (const part of relative.split('/')) {
    filename = path.join(filename, part);
    if ((await fs.lstat(filename)).isSymbolicLink()) throw Error('Review a local source without symbolic links.');
  }
  const observed = await fs.lstat(filename);
  if (!observed.isFile() || observed.size > maxFileBytes || observed.nlink !== 1 || await fs.realpath(filename) !== filename) {
    throw Error('Review one regular saved workspace file of at most 2 MiB.');
  }
  const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const current = await handle.stat();
    if (current.dev !== observed.dev || current.ino !== observed.ino || current.size !== observed.size || !current.isFile()) {
      throw Error('The local source changed while opening it.');
    }
    const bytes = Buffer.alloc(current.size);
    for (let offset = 0; offset < bytes.length;) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw Error('The local source changed while reading it.');
      offset += bytesRead;
    }
    const final = await handle.stat();
    if (final.size !== current.size || final.mtimeMs !== current.mtimeMs || await fs.realpath(filename) !== filename) {
      throw Error('The local source changed while reading it.');
    }
    return { bytes, sha256: hash(bytes) };
  } finally { await handle.close(); }
}

function previewText(data) {
  if (!data || data.length > 64 * 1024 || data.includes(0)) return undefined;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(data); }
  catch { return undefined; }
}

module.exports = { readSavedWorkspaceFile, previewText, maxFileBytes, hash };
