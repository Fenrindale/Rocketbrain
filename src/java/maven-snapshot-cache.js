'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { SaxesParser } = require('saxes');
const { cancelled, fail, inside, local } = require('./workbench-model');

const maxReportBytes = 2 * 1024 * 1024;
const maxArtifactBytes = 64 * 1024 * 1024;
const maxCacheBytes = 128 * 1024 * 1024;
const maxSnapshotNodes = 16;
const maxMetadataBytes = 256 * 1024;
const groupPattern = /^[A-Za-z0-9_][\w-]*(?:\.[A-Za-z0-9_][\w-]*)*$/u;
const componentPattern = /^[A-Za-z0-9_][\w.-]{0,179}$/u;
const stampPattern = /^\d{8}\.\d{6}-[1-9][0-9]{0,8}$/u;
const coordinatePattern = /^([A-Za-z0-9_.$+-]+(?::[A-Za-z0-9_.$+-]+){3,4}:(?:compile|provided|runtime|test|system|import)):(.*)$/u;

const coordinate = node => [node.group, node.artifact, node.type, node.classifier, node.version, node.scope].filter(Boolean).join(':');
const sameFile = (left, right) => left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
  left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
const claim = reason => ({ state: 'unavailable', reason });

function snapshotNode(node) {
  return node.state === 'selected' && /-SNAPSHOT$/u.test(node.version);
}

function eligible(node) {
  return node.type === 'jar' && node.scope !== 'system' && groupPattern.test(node.group) &&
    [node.artifact, node.version, node.classifier || 'jar'].every(value => componentPattern.test(value));
}

async function cacheDirectory(value) {
  const directory = path.resolve(local(value));
  if (process.platform === 'win32' && directory.startsWith('\\\\')) throw fail('Choose a physical local Maven repository.');
  const metadata = await fs.lstat(directory, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || path.relative(directory, await fs.realpath(directory))) {
    throw fail('Choose a physical local Maven repository.');
  }
  return { directory, dev: metadata.dev, ino: metadata.ino };
}

async function verifyDirectory(expected) {
  const current = await cacheDirectory(expected.directory);
  if (current.dev !== expected.dev || current.ino !== expected.ino) {
    throw fail('The selected Maven repository changed. Inspect cached snapshot evidence again.');
  }
}

async function cacheFile(cache, file, limit, data = false) {
  try {
    if (cancelled(cache.cancellation) || !inside(cache.root, file)) return undefined;
    const before = await fs.lstat(file, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.size === 0n || before.size > BigInt(limit) ||
        before.size > BigInt(cache.remaining) || path.relative(file, await fs.realpath(file))) return undefined;
    const handle = await fs.open(file, 'r');
    const digest = createHash('sha256'), chunks = [];
    let length = 0;
    try {
      if (!sameFile(before, await handle.stat({ bigint: true }))) return undefined;
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        length += chunk.length;
        cache.remaining -= chunk.length;
        if (length > limit || cache.remaining < 0 || cancelled(cache.cancellation)) return undefined;
        digest.update(chunk);
        if (data) chunks.push(chunk);
      }
      if (length !== Number(before.size) || !sameFile(before, await handle.stat({ bigint: true })) ||
          !sameFile(before, await fs.lstat(file, { bigint: true }))) return undefined;
      return { sha256: digest.digest('hex'), size: length, ...(data && { text: Buffer.concat(chunks).toString('utf8') }) };
    } finally { await handle.close(); }
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EBUSY'].includes(error.code)) return undefined;
    throw error;
  }
}

function parseArtifactList(text, requested) {
  const locations = new Map();
  if (typeof text !== 'string' || Buffer.byteLength(text) > maxReportBytes) return locations;
  for (const line of text.split(/\r?\n/u)) {
    const values = coordinatePattern.exec(line.trim());
    if (!values || !requested.has(values[1])) continue;
    const file = values[2].replace(/ -- module [^\r\n]+$/u, '');
    if (!path.isAbsolute(file) || file.length > 4096 || /[\u0000-\u001f\u007f]/u.test(file)) continue;
    if (locations.has(values[1])) locations.set(values[1], null);
    else locations.set(values[1], path.resolve(file));
  }
  return locations;
}

function trackingEntries(text, validName) {
  const tracking = new Map();
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || /^[#!]/u.test(line)) continue;
    const entry = /^([\w.+-]+)>([\w.-]*)=$/u.exec(line);
    if (!entry) return undefined;
    if (!validName(entry[1])) continue;
    if (!tracking.has(entry[1])) tracking.set(entry[1], new Set());
    tracking.get(entry[1]).add(entry[2]);
  }
  return tracking;
}

function metadataVersion(text, node, extension = 'jar') {
  if (/<!DOCTYPE|<!ENTITY/iu.test(text)) return undefined;
  const fields = Object.create(null), versions = [], stack = [], singletons = new Set();
  let entry;
  const parser = new SaxesParser({ xmlns: true });
  parser.on('opentag', tag => {
    stack.push(tag.local);
    if (stack.length <= 3) {
      const location = stack.join('/');
      if (['metadata/groupId', 'metadata/artifactId', 'metadata/version', 'metadata/versioning',
        'metadata/versioning/snapshotVersions'].includes(location)) {
        if (singletons.has(location)) throw Error('Duplicate Maven snapshot identity or versioning element.');
        singletons.add(location);
      }
    }
    if (stack.length === 4 && stack.join('/') === 'metadata/versioning/snapshotVersions/snapshotVersion') {
      entry = Object.create(null);
    } else if (entry && stack.length === 5) {
      if (Object.hasOwn(entry, tag.local)) throw Error('Duplicate Maven snapshot version field.');
      entry[tag.local] = '';
    }
  });
  parser.on('text', value => {
    const name = stack.at(-1);
    if (stack.length === 2 && stack[0] === 'metadata') fields[name] = (fields[name] || '') + value;
    if (entry && stack.length === 5) entry[name] = (entry[name] || '') + value;
  });
  parser.on('closetag', () => {
    if (entry && stack.length === 4) { versions.push(entry); entry = undefined; }
    stack.pop();
  });
  try { parser.write(text).close(); }
  catch { return undefined; }
  const { groupId, artifactId, version } = fields;
  if (groupId?.trim() !== node.group || artifactId?.trim() !== node.artifact || version?.trim() !== node.version) return undefined;
  const candidates = versions.filter(item => item.extension?.trim() === extension &&
    (item.classifier?.trim() || '') === node.classifier);
  if (candidates.length !== 1) return undefined;
  const resolved = candidates[0].value?.trim(), prefix = node.version.slice(0, -'SNAPSHOT'.length);
  return resolved?.startsWith(prefix) && stampPattern.test(resolved.slice(prefix.length)) ? resolved : undefined;
}

async function evidence(cache, node, location) {
  if (!eligible(node)) return claim('This snapshot type or coordinate is outside the standard cached JAR layout.');
  const directory = path.join(cache.root, ...node.group.split('.'), node.artifact, node.version);
  if (!location || path.relative(directory, path.dirname(location))) return claim('Maven did not report one artifact in the selected repository.');
  const suffix = (node.classifier ? '-' + node.classifier : '') + '.jar';
  const basename = filename => node.artifact + '-' + filename + suffix;
  const aliasName = basename(node.version), marker = node.artifact + '-' + node.version.slice(0, -'SNAPSHOT'.length);
  const timestampFile = name => name.startsWith(marker) && name.endsWith(suffix) &&
    stampPattern.test(name.slice(marker.length, -suffix.length));
  const selected = path.basename(location);
  if (selected !== aliasName && !timestampFile(selected)) return claim('Maven reported a nonstandard snapshot archive name.');
  const observed = await cacheFile(cache, location, maxArtifactBytes);
  if (!observed) return claim('The reported artifact is missing, changed, linked or over the cache read limit.');
  const result = { state: 'selected-cache-file', fileName: selected, ...observed };
  const tracking = await cacheFile(cache, path.join(directory, '_remote.repositories'), maxMetadataBytes, true);
  const assigned = tracking && trackingEntries(tracking.text, name => name === aliasName || timestampFile(name));
  if (!assigned) return { ...result, origin: 'unavailable' };
  if (assigned.get(selected)?.has('')) return { ...result, origin: 'local-marker', trackingSha256: tracking.sha256 };
  const repositoryIds = new Set([...assigned.values()].flatMap(ids => [...ids].filter(Boolean)));
  if (repositoryIds.size > 8) return { ...result, origin: 'unavailable' };
  const matches = [];
  for (const repositoryId of repositoryIds) {
    const metadata = await cacheFile(cache, path.join(directory, 'maven-metadata-' + repositoryId + '.xml'), maxMetadataBytes, true);
    const resolvedVersion = metadata && metadataVersion(metadata.text, node);
    const timedName = resolvedVersion && basename(resolvedVersion);
    if (!timedName || !assigned.get(timedName)?.has(repositoryId) || selected !== aliasName && selected !== timedName) continue;
    const original = selected === timedName ? observed : await cacheFile(cache, path.join(directory, timedName), maxArtifactBytes);
    if (original?.sha256 === observed.sha256) matches.push({ repositoryId, resolvedVersion, metadataSha256: metadata.sha256 });
  }
  if (matches.length !== 1) return { ...result, origin: matches.length ? 'ambiguous' : 'unavailable', trackingSha256: tracking.sha256 };
  return { ...result, origin: 'timestamped-cache-match', trackingSha256: tracking.sha256, ...matches[0] };
}

async function observeSnapshotCache(nodes, text, selectedRoot, cancellation) {
  await verifyDirectory(selectedRoot);
  const snapshots = nodes.filter(snapshotNode);
  const root = selectedRoot.directory;
  const examined = snapshots.slice(0, maxSnapshotNodes);
  const locations = parseArtifactList(text, new Set(examined.map(coordinate)));
  const budget = { root, remaining: maxCacheBytes, cancellation };
  const sealed = new Map();
  for (const node of examined) {
    const location = locations.get(coordinate(node));
    const observed = await evidence(budget, node, location);
    sealed.set(node.id, { node, location, observed });
    node.snapshotCache = observed;
  }
  for (const node of snapshots.slice(maxSnapshotNodes)) node.snapshotCache = claim('The report reached its 16-snapshot inspection limit.');
  await verifyDirectory(selectedRoot);
  const summary = { observedAt: new Date().toISOString(), selected: snapshots.length, examined: examined.length };
  async function validate(nodeId) {
    const value = sealed.get(nodeId);
    if (!value || value.observed.state !== 'selected-cache-file') throw fail('No verifiable cached artifact was recorded for this dependency.');
    await verifyDirectory(selectedRoot);
    const next = await evidence({ root, remaining: maxCacheBytes, cancellation }, value.node, value.location);
    await verifyDirectory(selectedRoot);
    if (JSON.stringify(next) !== JSON.stringify(value.observed)) {
      throw fail('Maven snapshot cache evidence changed. Inspect dependency resolution again.');
    }
    return { ...next };
  }
  return { summary, validate };
}

module.exports = { cacheDirectory, snapshotNode, observeSnapshotCache, metadataVersion, trackingEntries };
