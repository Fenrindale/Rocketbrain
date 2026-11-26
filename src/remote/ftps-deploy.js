'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { profileFor, relativePath, withFtps } = require('./ftps-channel');
const { readSavedWorkspaceFile, previewText, hash } = require('./reviewed-file');

function createFtpsDeployment() {
  const reviews = new Map(), active = new Set();
  let generation = 0, disposed = false;

  function guard(epoch) {
    if (disposed || epoch !== generation) throw Error('The scoped FTPS route changed. Review the file or folder again.');
  }

  async function browse({ profile, remote = '', credential, signal }) {
    const epoch = generation, route = profileFor(profile);
    guard(epoch);
    const directory = relativePath(remote, true);
    const entries = await withFtps(route, credential, signal, async peer =>
      (await peer.list(directory)).map(({ name, kind, bytes }) => ({ name, kind, ...(kind === 'file' && { bytes }) })));
    guard(epoch);
    return { root: route.root, directory, entries };
  }

  async function prepare({ profile, remote, action, localRoot, local, credential, signal }) {
    const epoch = generation, route = profileFor(profile);
    guard(epoch);
    if (!['upload','mkdir'].includes(action)) throw Error('Choose a unique FTPS upload or creation of one folder.');
    const relative = relativePath(remote);
    let source, prefix;
    if (action === 'upload') {
      if (!path.isAbsolute(localRoot ?? '')) throw Error('Choose a current local workspace as the source.');
      localRoot = await fs.realpath(localRoot);
      source = await readSavedWorkspaceFile(localRoot, relativePath(local));
      const leaf = path.posix.basename(relative);
      if (!/^[a-z0-9][\w.-]{0,94}$/iu.test(leaf)) throw Error('Use a comparison filename of at most 95 letters, numbers, dots, underscores or dashes.');
      prefix = leaf + '.rb-upload';
    }
    const observed = await withFtps(route, credential, signal, async peer => ({
      binding: peer.trust,
      ...(action === 'upload' ? { target: await peer.file(relative) } : { folder: await peer.inspect(relative) }),
    }));
    guard(epoch);
    if (observed.folder) throw Error('The reviewed FTPS folder path already exists.');
    const { binding, target } = observed;
    const id = randomUUID();
    const digest = hash(JSON.stringify({ route, action, relative, local, localRoot, prefix, binding,
      source: source?.sha256, target: target?.sha256 }));
    const preview = { id, hash: digest, action, profile: route.label, root: route.root, remote: relative, host: route.host,
      port: route.port, user: route.user, tlsServerName: route.tlsServerName, certificateSha256: binding.certificate,
      local, canApply: action === 'mkdir' || source.sha256 !== target.sha256,
      ...(source && { localHash: source.sha256, localBytes: source.bytes.length, localText: previewText(source.bytes),
        remoteHash: target.sha256, remoteBytes: target.bytes?.length, remoteText: previewText(target.bytes),
        disposition: source.sha256 === target.sha256 ? 'identical' : 'create unique', prefix }) };
    while (reviews.size >= 8) reviews.delete(reviews.keys().next().value);
    reviews.set(id, { epoch, route, relative, action, binding, prefix, localRoot, local, sourceHash: source?.sha256,
      targetHash: target?.sha256, preview, expiresAt: Date.now() + 120000 });
    return structuredClone(preview);
  }

  async function apply(id, { confirmed, hash: expected, credential, signal, guard: workspaceGuard } = {}) {
    const record = reviews.get(id);
    if (confirmed !== true || !record || record.expiresAt <= Date.now() || expected !== record.preview.hash || !record.preview.canApply) {
      throw Error('Approve one eligible FTPS publication with its current source and destination review.');
    }
    function approved() { guard(record.epoch); workspaceGuard?.(); }
    approved();
    const key = JSON.stringify([record.route.host.toLowerCase(), record.route.port, record.binding.certificate,
      path.posix.join(record.route.root, record.relative)]);
    if (active.has(key)) throw Error('An FTPS publication for this reviewed path is already in progress.');
    reviews.delete(id);
    active.add(key);
    try { return await publish(record, credential, signal, approved); }
    finally { active.delete(key); }
  }

  async function publish(record, credential, signal, approved) {
    const { route, relative, action, localRoot, local, binding, prefix, sourceHash, targetHash } = record;
    async function sourceNow() {
      const source = await readSavedWorkspaceFile(localRoot, local);
      if (source.sha256 !== sourceHash) throw Error('The saved local source changed after review.');
      approved();
      return source.bytes;
    }
    const bytes = action === 'upload' ? await sourceNow() : undefined;
    return withFtps(route, credential, signal, async peer => {
      if (action === 'mkdir') {
        if (await peer.inspect(relative)) throw Error('The reviewed FTPS folder appeared after review.');
        approved();
        try {
          await peer.mkdir(relative);
          if ((await peer.inspect(relative))?.kind !== 'directory') throw Error('Missing directory after MKD.');
        } catch (error) { throw uncertain(relative, error); }
        return { state: 'verified', action, remote: relative };
      }
      if ((await peer.file(relative)).sha256 !== targetHash) throw Error('The compared remote file changed after review.');
      approved();
      const parent = path.posix.dirname(relative);
      let generated;
      try {
        await peer.publishUnique(parent === '.' ? '' : parent, prefix, bytes, {
          beforeCommand: approved, beforeData: sourceNow, onGenerated: name => { generated = name; },
        });
        const persisted = await peer.file(generated);
        if (persisted.sha256 !== sourceHash) throw Error('FTPS readback failed.');
        return { state: 'verified', action, remote: generated, sha256: persisted.sha256, bytes: persisted.bytes.length,
          publication: 'stou' };
      } catch (error) {
        if (typeof error.code === 'number' && error.code >= 500 && !generated) throw error;
        throw uncertain(generated ?? (parent === '.' ? route.root : path.posix.join(route.root, parent)), error);
      }
    }, binding);
  }

  function uncertain(target, error) {
    return Object.assign(Error('The FTPS publication was not confirmed. Inspect ' + target + ' before retrying.'), {
      code: 'ROCKETBRAIN_FTPS_UNCONFIRMED', target, causeCode: error?.code,
    });
  }

  return { browse, prepare, apply, invalidate() { generation++; reviews.clear(); },
    dispose() { disposed = true; generation++; reviews.clear(); } };
}

module.exports = { createFtpsDeployment };
