'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { fail } = require('./workbench-model');
const { artifactName, MAX_WAR_BYTES } = require('./jakarta-war');
const { hashArchive } = require('./jakarta-tomcat');

const schema = 'RocketbrainTomcatWarHistory-v1';
const storageFolder = 'tomcat-war-history-v1';
const shaPattern = /^[a-f0-9]{64}$/u;
const slotName = /^[0-9]{3}$/u;
const maxManifest = 8192;
const digest = input => createHash('sha256').update(input).digest('hex');
const revisionName = revision => String(revision).padStart(3, '0');
const samePath = (left, right) => !path.relative(left, right);
const sameFile = (left, right) => left.dev === right.dev && left.ino === right.ino;

async function physicalDirectory(dir, optional = false) {
  let stat;
  try { stat = await fs.lstat(dir, { bigint: true }); }
  catch (error) { if (optional && error.code === 'ENOENT') return undefined; throw error; }
  if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(await fs.realpath(dir), dir)) {
    throw fail('Tomcat WAR history requires physical directories inside the extension profile.');
  }
  return stat;
}

async function physicalFile(file, limit) {
  const stat = await fs.lstat(file, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || !samePath(await fs.realpath(file), file) || stat.size > BigInt(limit)) {
    throw fail('A retained Tomcat history file changed or exceeds its size limit.');
  }
  return stat;
}

async function readManifest(dir) {
  const file = path.join(dir, 'confirmed.json');
  let stat;
  try { stat = await physicalFile(file, maxManifest); }
  catch (error) {
    if (error.code === 'ENOENT') throw fail('A tracked Tomcat change was interrupted or is still in progress. Check its server state before making another change.');
    throw error;
  }
  const handle = await fs.open(file, 'r');
  try {
    const bytes = Buffer.alloc(maxManifest + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const current = await fs.lstat(file, { bigint: true });
    if (BigInt(bytesRead) !== stat.size || !sameFile(stat, current) || !sameFile(stat, await handle.stat({ bigint: true })) ||
        current.ctimeNs !== stat.ctimeNs || current.mtimeNs !== stat.mtimeNs) {
      throw fail('A retained Tomcat history manifest changed while reading.');
    }
    const body = bytes.subarray(0, bytesRead);
    try { return { value: JSON.parse(body.toString('utf8')), head: digest(body) }; }
    catch { throw fail('A retained Tomcat history manifest is invalid.'); }
  } finally { await handle.close(); }
}

function checkRecord(value, { key, context, sequence, head, owner }) {
  const docBase = context.slice(1) + '##' + value?.version;
  const { archive } = value || {};
  if (value?.schema !== schema || value.scope !== key || value.context !== context || value.revision !== sequence ||
      value.parent !== head || !shaPattern.test(value.owner || '') || owner && value.owner !== owner ||
      typeof value.version !== 'string' || !/^rb[0-9]{3}-[a-f0-9]{32}$/u.test(value.version) ||
      !value.version.startsWith('rb' + revisionName(sequence) + '-') ||
      value.location !== docBase && value.location !== docBase + '.war' ||
      !archive || !Number.isInteger(archive.revision) || archive.revision < 1 || archive.revision > sequence ||
      typeof archive.name !== 'string' || !artifactName.test(archive.name) || !archive.name.endsWith('.war') ||
      !Number.isSafeInteger(archive.size) || archive.size < 4 || archive.size > MAX_WAR_BYTES || !shaPattern.test(archive.sha256 || '')) {
    throw fail('A retained Tomcat history manifest is invalid or no longer matches its deployment scope.');
  }
}

function createManagerJournal(storagePath, { maxContexts, maxVersions, maxBytes }) {
  if (!path.isAbsolute(storagePath)) throw fail('Tomcat history requires the extension’s local profile storage.');
  const root = path.join(storagePath, storageFolder);
  const scope = key => {
    if (!shaPattern.test(key)) throw fail('Invalid Tomcat history deployment scope.');
    return path.join(root, key);
  };

  async function physicalRoot(create = false) {
    if (create) await fs.mkdir(storagePath, { recursive: true, mode: 0o700 });
    if (!await physicalDirectory(storagePath, !create)) return false;
    if (create) await fs.mkdir(root, { recursive: true, mode: 0o700 });
    return !!await physicalDirectory(root, !create);
  }

  async function read(key, context) {
    if (!await physicalRoot()) return undefined;
    const dir = scope(key);
    if (!await physicalDirectory(dir, true)) return undefined;
    const slots = (await fs.readdir(dir)).sort();
    if (slots.length > maxVersions || slots.some((name, index) => !slotName.test(name) || name !== revisionName(index + 1))) {
      throw fail('Tomcat WAR history has unexpected revision directories.');
    }
    let head = null, owner, bytes = 0;
    const revisions = [], archives = new Map();
    for (const [index, name] of slots.entries()) {
      const sequence = index + 1, slot = path.join(dir, name);
      await physicalDirectory(slot);
      const record = await readManifest(slot);
      checkRecord(record.value, { key, context, sequence, head, owner });
      const { value } = record, { archive } = value;
      if (archive.revision === sequence) {
        const file = path.join(slot, 'reviewed.war');
        const stat = await physicalFile(file, MAX_WAR_BYTES);
        if (BigInt(archive.size) !== stat.size || (bytes += archive.size) > maxBytes) {
          throw fail('A retained Tomcat WAR changed or exceeds its context archive budget.');
        }
        archives.set(sequence, { ...archive, file });
      }
      const saved = archives.get(archive.revision);
      if (!saved || saved.name !== archive.name || saved.size !== archive.size || saved.sha256 !== archive.sha256) {
        throw fail('A retained Tomcat WAR archive reference changed.');
      }
      revisions.push({ version: value.version, location: value.location, artifact: saved, sha256: saved.sha256 });
      ({ owner } = value);
      ({ head } = record);
    }
    return revisions.length ? { head, owner, revisions, bytes } : undefined;
  }

  async function reserve(tracked, archive, sha256) {
    const { key, context, before, nextRevision, previous, owner } = tracked;
    if (!Number.isInteger(nextRevision) || nextRevision < 1 || nextRevision > maxVersions ||
        nextRevision !== (before?.revisions.length || 0) + 1) {
      throw fail('The tracked Tomcat history revision is no longer valid.');
    }
    await physicalRoot(true);
    const dir = scope(key);
    if (!await physicalDirectory(dir, true)) {
      if ((await fs.readdir(root)).length >= maxContexts) throw fail('This Tomcat profile is already tracking sixteen contexts.');
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      await physicalDirectory(dir);
    }
    const current = await read(key, context);
    if (current?.head !== before?.head) throw fail('The saved Tomcat history changed. Review it again.');
    const slot = path.join(dir, revisionName(nextRevision));
    try { await fs.mkdir(slot, { mode: 0o700 }); }
    catch (error) {
      if (error.code === 'EEXIST') throw fail('Another Rocketbrain window is changing this Tomcat context. Review it again.');
      throw error;
    }
    const identity = await physicalDirectory(slot);
    async function verify() {
      if (!sameFile(identity, await physicalDirectory(slot))) throw fail('The claimed Tomcat history directory changed.');
    }
    async function abort() {
      await verify();
      await fs.rm(slot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
    let retained = previous?.artifact;
    try {
      if (!retained) {
        const { name, size } = archive;
        if (!artifactName.test(name) || !name.endsWith('.war') || (before?.bytes || 0) + size > maxBytes) {
          throw fail('The selected WAR exceeds the retained Tomcat context archive budget.');
        }
        const file = path.join(slot, 'reviewed.war');
        await hashArchive(archive, { destination: file, expectedSha256: sha256 });
        const handle = await fs.open(file, 'r+');
        try { await handle.sync(); } finally { await handle.close(); }
        retained = { revision: nextRevision, file, name, size, sha256 };
      }
    } catch (error) { await abort(); throw error; }
    return { abort, assertActive: verify, async confirm(version, location) {
      await verify();
      const { revision, name, size } = retained;
      if (retained.sha256 !== sha256) throw fail('The retained Tomcat WAR digest changed.');
      await hashArchive(retained, { expectedSha256: sha256 });
      const value = { schema, scope: key, context, owner, parent: before?.head ?? null, revision: nextRevision,
        version, location, archive: { revision, name, size, sha256 } };
      const temporary = path.join(slot, 'manifest-' + randomUUID() + '.tmp');
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(value) + '\n'); await handle.sync(); }
      finally { await handle.close(); }
      await fs.rename(temporary, path.join(slot, 'confirmed.json'));
    } };
  }

  return { read, reserve };
}

module.exports = { createManagerJournal, digest, storageFolder };
