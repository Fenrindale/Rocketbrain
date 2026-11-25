'use strict';

const fs = require('node:fs/promises');
const { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } = require('node:crypto');

const magic = Buffer.from('RocketbrainTableCopyCommitV3\0');
const nonceBytes = 12, tagBytes = 16;
const headerBytes = magic.length + nonceBytes + tagBytes;
const maximumBytes = 256 * 1024;
const legacyCommitMarker = Buffer.from('1\n');
const missing = error => { if (error.code !== 'ENOENT') throw error; };
const fileIdentity = stat => stat && [String(stat.dev), String(stat.ino)];
const sameIdentity = (a, b) => a && b && a[0] === b[0] && a[1] === b[1];

function markerKey(item) {
  const key = item.recovery.key;
  if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)) return;
  const source = Buffer.from(key, 'hex');
  try { return createHmac('sha256', source).update('rocketbrain/table-copy/commit-marker/v3').digest(); }
  finally { source.fill(0); }
}

function associatedData(item, scope) {
  return Buffer.from(JSON.stringify(['RocketbrainTableCopyCommitV3', scope, item.metadata.id, item.metadata.expiresAt,
    item.recovery.sealed.rowCount, item.recovery.sealed.sourceHash]));
}

function closeEvidence(item, evidence, scope) {
  if (evidence?.version !== 3) return legacyCommitMarker;
  const key = markerKey(item);
  if (!key) throw Error('The encrypted table copy key cannot bind commit evidence.');
  let plain;
  try {
    plain = Buffer.from(JSON.stringify(evidence));
    if (plain.length + headerBytes > maximumBytes) throw Error('The table copy commit evidence is too large.');
    const nonce = randomBytes(nonceBytes);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(associatedData(item, scope));
    const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
    return Buffer.concat([magic, nonce, cipher.getAuthTag(), encrypted]);
  } finally {
    plain?.fill(0);
    key.fill(0);
  }
}

function openEvidence(item, bytes, scope) {
  if (!bytes || bytes.length <= headerBytes || !bytes.subarray(0, magic.length).equals(magic)) return;
  const key = markerKey(item);
  if (!key) return;
  let body, trailer;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(magic.length, magic.length + nonceBytes));
    decipher.setAAD(associatedData(item, scope));
    decipher.setAuthTag(bytes.subarray(magic.length + nonceBytes, headerBytes));
    body = decipher.update(bytes.subarray(headerBytes));
    trailer = decipher.final();
    if (trailer.length) return;
    const evidence = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
    if (evidence?.version === 3) return evidence;
  } catch { /* An unauthenticated marker does not establish reviewed evidence. */ }
  finally {
    body?.fill(0);
    trailer?.fill(0);
    key.fill(0);
  }
}

async function readMarker(file) {
  const pathState = await fs.lstat(file).catch(missing);
  if (!pathState?.isFile() || pathState.size < 1 || pathState.size > maximumBytes) return;
  const handle = await fs.open(file, 'r').catch(missing);
  if (!handle) return;
  try {
    const initial = await handle.stat(), identity = fileIdentity(initial);
    if (!initial.isFile() || initial.size !== pathState.size || !sameIdentity(fileIdentity(pathState), identity)) return;
    const bytes = Buffer.alloc(initial.size);
    for (let offset = 0; offset < bytes.length;) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) return;
      offset += bytesRead;
    }
    const final = await handle.stat(), current = await fs.lstat(file).catch(missing);
    if (!current?.isFile() || !sameIdentity(fileIdentity(current), identity) || final.size !== initial.size ||
        current.size !== initial.size || final.mtimeMs !== initial.mtimeMs || current.mtimeMs !== initial.mtimeMs) return;
    return { bytes, identity, digest: createHash('sha256').update(bytes).digest('hex') };
  } finally { await handle.close(); }
}

module.exports = { closeEvidence, openEvidence, readMarker, fileIdentity, sameIdentity, legacyCommitMarker };
