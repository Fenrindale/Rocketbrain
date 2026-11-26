'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { profileFor, relativePath, withSftp, digest, maxBytes } = require('./sftp-channel');

async function readLocal(root, relative) {
  const safe = relativePath(relative), canonical = await fs.realpath(root);
  if (canonical !== root) throw Error('The local workspace root changed. Review the current source again.');
  let filename = canonical;
  for (const part of safe.split('/')) {
    filename = path.join(filename, part);
    const current = await fs.lstat(filename);
    if (current.isSymbolicLink()) throw Error('Review a local source without symbolic links.');
  }
  const observed = await fs.lstat(filename);
  if (!observed.isFile() || observed.size > maxBytes || observed.nlink !== 1 || await fs.realpath(filename) !== filename) {
    throw Error('Review one regular saved workspace file of at most 2 MiB.');
  }
  const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const current = await handle.stat();
    if (current.dev !== observed.dev || current.ino !== observed.ino || current.size !== observed.size || !current.isFile()) {
      throw Error('The local source changed while opening it.');
    }
    const data = Buffer.alloc(current.size);
    for (let offset = 0; offset < data.length;) {
      const { bytesRead } = await handle.read(data, offset, data.length - offset, offset);
      if (!bytesRead) throw Error('The local source changed while reading it.');
      offset += bytesRead;
    }
    const final = await handle.stat();
    if (final.size !== current.size || final.mtimeMs !== current.mtimeMs || await fs.realpath(filename) !== filename) {
      throw Error('The local source changed while reading it.');
    }
    return { bytes: data, sha256: digest(data) };
  } finally { await handle.close(); }
}

function textOf(data) {
  if (!data || data.length > 64 * 1024 || data.includes(0)) return undefined;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(data); }
  catch { return undefined; }
}

function bindFailure(message, relative, stage, error) {
  return Object.assign(Error(message), { code: 'ROCKETBRAIN_SFTP_UNCONFIRMED', target: relative,
    ...(stage && { stagedPath: stage }), causeCode: error?.code });
}

function createSftpDeployment() {
  const reviews = new Map();
  const publishing = new Set();
  const cap = 8;
  let closed = false;
  let version = 0;

  function check(epoch) {
    if (closed || epoch !== version) throw Error('The scoped deployment profile changed. Review the source and destination again.');
  }

  async function browse({ profile, remote = '', credential, signal }) {
    const next = version, route = profileFor(profile);
    check(next);
    const directory = relativePath(remote, true);
    const rows = await withSftp(route, credential, signal, peer => peer.list(directory));
    check(next);
    return { root: route.root, directory, entries: rows };
  }

  async function prepare({ profile, remote, action, localRoot, local, credential, signal }) {
    const epoch = version, route = profileFor(profile);
    check(epoch);
    if (!['upload','mkdir'].includes(action)) throw Error('Choose file upload or creation of one remote folder.');
    const relative = relativePath(remote);
    let source;
    if (action === 'upload') {
      if (!path.isAbsolute(localRoot ?? '')) throw Error('Choose a current local workspace as the source.');
      localRoot = await fs.realpath(localRoot);
      source = await readLocal(localRoot, local);
    }
    const target = await withSftp(route, credential, signal, async peer => {
      if (action === 'mkdir') return peer.inspect(relative);
      const current = await peer.read(relative);
      return { ...current, atomicReplace: peer.atomicReplace };
    });
    check(epoch);
    if (action === 'mkdir' && target.kind !== 'missing') throw Error('The reviewed remote folder path already exists.');
    const id = randomUUID();
    const hash = digest(JSON.stringify({ route, action, relative, local, source: source?.sha256, target: target.sha256,
      mode: target.mode, uid: target.uid, gid: target.gid, capabilities: target.atomicReplace }));
    const changed = source && target.sha256 !== source.sha256;
    const canApply = action === 'mkdir' || Boolean(changed && (!target.exists || target.atomicReplace));
    const preview = { id, hash, action, profile: route.label, root: route.root, remote: relative, host: route.host, port: route.port,
      user: route.user, hostFingerprint: route.hostFingerprint, local, canApply,
      ...(source && { localHash: source.sha256, localBytes: source.bytes.length, localText: textOf(source.bytes),
        remoteHash: target.sha256, remoteBytes: target.bytes?.length, remoteText: textOf(target.bytes),
        disposition: !target.exists ? 'create' : changed ? 'replace' : 'identical', atomicReplace: target.atomicReplace }) };
    while (reviews.size >= cap) reviews.delete(reviews.keys().next().value);
    reviews.set(id, { epoch, route, relative, action, localRoot, local, sourceHash: source?.sha256, targetHash: target.sha256,
      targetMode: target.mode, targetUid: target.uid, targetGid: target.gid, preview, expiresAt: Date.now() + 120000 });
    return structuredClone(preview);
  }

  async function apply(id, { confirmed, hash, credential, signal, guard } = {}) {
    const record = reviews.get(id);
    if (confirmed !== true || !record || record.expiresAt <= Date.now() || hash !== record.preview.hash || !record.preview.canApply) {
      throw Error('Approve one eligible SFTP deployment with its current source and destination review.');
    }
    const { epoch, route, relative } = record;
    const approved = () => { check(epoch); guard?.(); };
    approved();
    const destination = JSON.stringify([route.host.toLowerCase(), route.port, route.hostFingerprint, path.posix.join(route.root, relative)]);
    if (publishing.has(destination)) throw Error('A publication to the reviewed SFTP path is already in progress.');
    reviews.delete(id);
    publishing.add(destination);
    try { return await publish(record, credential, signal, approved); }
    finally { publishing.delete(destination); }
  }

  async function publish(record, credential, signal, approved) {
    const { route, relative, action, localRoot, local, sourceHash, targetHash, targetMode, targetUid, targetGid } = record;
    if (action === 'mkdir') {
      return withSftp(route, credential, signal, async peer => {
        if ((await peer.inspect(relative)).kind !== 'missing') throw Error('The remote path appeared after review.');
        approved();
        try { await peer.makeDirectory(relative); }
        catch (error) { throw bindFailure('The SFTP folder creation was not confirmed. Inspect the target before retrying.', relative, undefined, error); }
        let verified;
        try { verified = (await peer.inspect(relative)).kind === 'directory'; }
        catch (error) { throw bindFailure('The SFTP folder creation was acknowledged. The folder could not be read back.', relative, undefined, error); }
        if (!verified) throw bindFailure('The SFTP folder could not be verified.', relative);
        return { state: 'verified', action, remote: relative };
      });
    }

    const updatedLocal = async () => {
      const current = await readLocal(localRoot, local);
      if (current.sha256 !== sourceHash) throw Error('The saved local source changed after review.');
      return current.bytes;
    };
    const bytes = await updatedLocal();
    return withSftp(route, credential, signal, async peer => {
      const target = await peer.target(relative);
      const replacement = targetHash !== null;
      const current = async () => {
        const state = await peer.read(relative);
        if (state.sha256 !== targetHash || state.mode !== targetMode || state.uid !== targetUid || state.gid !== targetGid) throw Error('The remote file changed after review.');
        if (replacement && !peer.atomicReplace) throw Error('The remote server no longer advertises atomic POSIX replacement.');
        approved();
      };
      await current();
      const stage = path.posix.join(path.posix.dirname(target), `.rocketbrain-upload-${randomUUID()}.tmp`);
      let owned = false, renamed = false;
      try {
        let staged;
        try { staged = await peer.writeStage(stage, bytes, targetMode ?? 0o640, () => { owned = true; }); }
        catch (error) {
          if (!owned) throw bindFailure('The SFTP staging file was not confirmed. Inspect the reported path before retrying.', relative, stage, error);
          throw error;
        }
        if (replacement && (staged.uid !== targetUid || staged.gid !== targetGid || staged.mode !== targetMode)) {
          throw Error('The SFTP staging file could not preserve the reviewed remote owner and mode.');
        }
        await updatedLocal();
        await current();
        if (await peer.target(relative) !== target) throw Error('The scoped remote path changed before publication.');
        approved();
        try { await peer.rename(stage, target, replacement); renamed = true; }
        catch (error) { throw bindFailure('The SFTP publication was not confirmed. Inspect the target before retrying.', relative, stage, error); }
        let readback;
        try { readback = await peer.read(relative); }
        catch (error) { throw bindFailure('The SFTP rename was acknowledged. The resulting bytes could not be read back.', relative, undefined, error); }
        if (readback.sha256 !== sourceHash) throw bindFailure('The remote bytes after publication differ from the reviewed source. Inspect the target.', relative);
        return { state: 'verified', action, remote: relative, sha256: readback.sha256, bytes: readback.bytes.length,
          publication: replacement ? 'posix-rename' : 'sftp-create-rename' };
      } finally {
        if (owned && !renamed) {
          try { await peer.clearStage(stage); }
          catch (error) { throw bindFailure('The SFTP staging file could not be cleared. Inspect the reported path before retrying.', relative, stage, error); }
        }
      }
    });
  }

  return { browse, prepare, apply, invalidate() { version++; reviews.clear(); }, dispose() { closed = true; version++; reviews.clear(); } };
}

module.exports = { createSftpDeployment };
