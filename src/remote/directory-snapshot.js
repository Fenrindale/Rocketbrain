'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { readSavedWorkspaceFile, maxFileBytes, hash } = require('./reviewed-file');

const maxEntries = 64;
const maxFiles = 20;
const maxSnapshotBytes = 8 * 1024 * 1024;

function nameOf(value) {
  if (typeof value !== 'string' || !value || value === '.' || value === '..' || !value.isWellFormed() ||
      Buffer.byteLength(value) > 255 || /[\\/:"\x00-\x1f\x7f]/u.test(value) || value.trim() !== value) {
    throw Error('Choose a deployment folder with ordinary direct file names.');
  }
  return value;
}

function directoryPath(value = '') {
  if (value === '') return '';
  if (typeof value !== 'string' || Buffer.byteLength(value) > 1024 || value.split('/').length > 16) {
    throw Error('Choose a workspace-relative deployment directory.');
  }
  return value.split('/').map(nameOf).join('/');
}

async function captureDirectory(list, read, { excluded = () => false, signal } = {}) {
  async function inventory() {
    signal?.throwIfAborted();
    const entries = await list();
    if (!Array.isArray(entries) || entries.length > maxEntries) throw Error('Choose a deployment directory with at most 64 direct entries.');
    const keys = new Set();
    const rows = entries.map(item => {
      const name = nameOf(item.name), key = name.normalize('NFC').toLowerCase();
      if (keys.has(key)) throw Error('The deployment directory contains ambiguous names.');
      keys.add(key);
      return { name, kind: item.kind, bytes: item.bytes, tag: item.tag };
    });
    return rows.sort((a, b) => a.name.localeCompare(b.name));
  }
  const before = await inventory();
  const files = before.filter(row => row.kind === 'file' && !excluded(row.name));
  const skipped = before.filter(row => !files.includes(row)).map(({ name, kind }) => ({ name, kind }));
  if (files.length > maxFiles) throw Error('Choose a deployment directory with at most 20 compared files.');
  let size = 0;
  const entries = new Map();
  for (const row of files) {
    signal?.throwIfAborted();
    if (row.bytes !== undefined && (!Number.isSafeInteger(row.bytes) || row.bytes < 0 || row.bytes > maxFileBytes)) {
      throw Error('Choose deployment files of at most 2 MiB each.');
    }
    const current = await read(row);
    if (!current || !Buffer.isBuffer(current.bytes) || current.sha256 !== hash(current.bytes) ||
        row.bytes !== undefined && row.bytes !== current.bytes.length) {
      throw Error('A deployment file changed while reading. Refresh both sides.');
    }
    size += current.bytes.length;
    if (size > maxSnapshotBytes) throw Error('Compare no more than 8 MiB per side.');
    entries.set(row.name, current);
  }
  if (JSON.stringify(await inventory()) !== JSON.stringify(before)) {
    throw Error('The deployment directory changed while reading. Refresh both sides.');
  }
  return { entries, skipped, bytes: size };
}

async function localDirectory(workspace, directory) {
  if (!path.isAbsolute(workspace ?? '')) throw Error('Choose a local workspace directory.');
  const workspaceRoot = await fs.realpath(workspace);
  let root = workspaceRoot;
  for (const part of directoryPath(directory).split('/').filter(Boolean)) {
    root = path.join(root, part);
    const attrs = await fs.lstat(root);
    if (!attrs.isDirectory() || attrs.isSymbolicLink()) throw Error('Use a local deployment directory without symbolic links.');
  }
  if (await fs.realpath(root) !== root) throw Error('The selected local deployment directory resolves outside its original path.');
  const attrs = await fs.lstat(root);
  return { root, identity: [workspaceRoot, root, attrs.dev, attrs.ino] };
}

async function captureLocalDirectory(workspace, directory, { excluded, signal } = {}) {
  const { root, identity } = await localDirectory(workspace, directory);
  const current = await captureDirectory(async () => {
    const observed = await localDirectory(workspace, directory);
    if (JSON.stringify(observed.identity) !== JSON.stringify(identity)) throw Error('The selected local deployment directory changed.');
    const names = [];
    for await (const child of await fs.opendir(root)) {
      if (names.length >= maxEntries) throw Error('Choose a deployment directory with at most 64 direct entries.');
      signal?.throwIfAborted();
      const attrs = await fs.lstat(path.join(root, child.name));
      names.push({ name: child.name, kind: attrs.isSymbolicLink() ? 'link' : attrs.isDirectory() ? 'directory' : attrs.isFile() ? 'file' : 'other',
        ...(attrs.isFile() && { bytes: attrs.size, tag: [attrs.dev, attrs.ino, attrs.mtimeMs, attrs.ctimeMs] }) });
    }
    return names;
  }, row => readSavedWorkspaceFile(root, row.name), { excluded, signal });
  return { ...current, identity, root };
}

module.exports = { captureDirectory, captureLocalDirectory, directoryPath, nameOf, maxEntries };
