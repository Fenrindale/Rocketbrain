'use strict';

const { fail } = require('./workbench-model');
const { createManagerJournal, digest } = require('./jakarta-manager-journal');

const MAX_CONTEXTS = 16;
const MAX_VERSIONS = 8;
const MAX_RETAINED_BYTES = 512 * 1024 * 1024;
const managedActions = new Set(['track-deploy', 'track-update', 'restore']);
const managedVersion = /^rb[0-9]{3}-[a-f0-9]{32}$/u;

function contextRows(applications, context) {
  return applications.filter(item => item.context === context || item.context.startsWith(context + '##'));
}

function listedVersion(item) {
  const name = item.location.split(/[\\/]/u).at(-1);
  return name.includes('##') ? name.slice(name.indexOf('##') + 2).replace(/\.war$/u, '') : undefined;
}

function publicVersion(item) {
  const version = listedVersion(item);
  return managedVersion.test(version || '') ? version : undefined;
}

function exactRows(applications, context, revisions) {
  const rows = contextRows(applications, context), names = new Set();
  if (rows.length !== revisions.length) return false;
  for (const row of rows) {
    const version = publicVersion(row), base = context.slice(1) + '##' + version;
    const revision = revisions.find(item => item.version === version);
    if (!revision || row.context !== context || row.state !== 'running' || names.has(version) ||
        (revision.location ? revision.location !== row.location : row.location !== base && row.location !== base + '.war')) return false;
    names.add(version);
  }
  return true;
}

function createManagerHistory({ storagePath } = {}) {
  const histories = new Map(), retained = new Set();
  const journal = storagePath && createManagerJournal(storagePath, { maxContexts: MAX_CONTEXTS,
    maxVersions: MAX_VERSIONS, maxBytes: MAX_RETAINED_BYTES });
  const load = (key, context) => journal ? journal.read(key, context) : histories.get(key);
  let retainedBytes = 0;

  function verifyCapacity(tracked, size) {
    const existing = journal ? tracked.before?.bytes || 0 : retainedBytes;
    if (existing + size > MAX_RETAINED_BYTES || !journal && retained.size >= MAX_CONTEXTS * MAX_VERSIONS) {
      throw fail('This tracked Tomcat history reached its retained WAR archive capacity.');
    }
  }

  async function inspect({ action, origin, context, username, certificateSha256, caSha256, virtualHost }, applications) {
    const key = digest(JSON.stringify([origin, context])), before = await load(key, context);
    const owner = digest(JSON.stringify([key, username, certificateSha256, caSha256, virtualHost]));
    if (action === 'track-deploy') {
      if (before || contextRows(applications, context).length) throw fail('Start tracked deployment in an empty Tomcat context.');
      if (!journal && histories.size >= MAX_CONTEXTS) throw fail('This Tomcat Manager session is already tracking sixteen contexts.');
    } else if (!before || before.owner !== owner) {
      throw fail('Choose a context tracked by this Tomcat Manager under the same endpoint, account and certificate.');
    }

    const revisions = before?.revisions ?? [];
    if (!exactRows(applications, context, revisions)) {
      throw fail('The live Tomcat versions no longer match the confirmed deployments. Review the server state.');
    }
    if (revisions.length >= MAX_VERSIONS) throw fail('This tracked Tomcat context already has eight versions.');
    const current = before?.revisions.at(-1), previous = before?.revisions.at(-2);
    if (action === 'restore' && !previous) throw fail('Publish a second tracked WAR before restoring a previous version.');
    return { key, before, owner, context, virtualHost, revisions, current, nextRevision: revisions.length + 1,
      previous: action === 'restore' ? previous : undefined };
  }

  function verifyRemote(tracked, observed) {
    if (observed.virtualHost !== tracked.virtualHost || !exactRows(observed.applications, tracked.context, tracked.revisions)) {
      throw fail('The reviewed live Tomcat versions changed. Review the server state again.');
    }
  }

  async function beforeUpload(tracked, observed) {
    verifyRemote(tracked, observed);
    const current = await load(tracked.key, tracked.context);
    if (journal ? current?.head !== tracked.before?.head : current !== tracked.before) {
      throw fail('The saved Tomcat history changed. Review it again.');
    }
    if (!journal && !tracked.before && histories.size >= MAX_CONTEXTS) {
      throw fail('This Tomcat Manager session is already tracking sixteen contexts.');
    }
  }

  async function confirm(tracked, version, observed, uploadedSha256, retainedArchive, reservation) {
    if (observed.virtualHost !== tracked.virtualHost ||
        !exactRows(observed.applications, tracked.context, [...tracked.revisions, { version }])) return undefined;
    const found = observed.applications.find(item => item.context === tracked.context && publicVersion(item) === version);
    if (reservation) {
      await reservation.confirm(version, found.location);
      return found;
    }
    let artifact = tracked.previous?.artifact;
    if (retainedArchive) {
      const lease = retainedArchive();
      artifact = lease.artifact;
      retained.add(lease);
      retainedBytes += artifact.size;
    }
    histories.set(tracked.key, { owner: tracked.owner,
      revisions: [...tracked.revisions, { version, location: found.location, artifact, sha256: uploadedSha256 }] });
    return found;
  }

  return { inspect, beforeUpload, verifyRemote, confirm, verifyCapacity, persistent: !!journal,
    reserve: (tracked, archive, sha256) => journal?.reserve(tracked, archive, sha256),
    invalidate(tracked) { if (!journal) histories.delete(tracked.key); },
    async dispose() {
      histories.clear();
      const removed = await Promise.allSettled([...retained].map(lease => lease.release()));
      retained.clear();
      retainedBytes = 0;
      const failure = removed.find(result => result.status === 'rejected');
      if (failure) throw failure.reason;
    }
  };
}

module.exports = { createManagerHistory, contextRows, listedVersion, publicVersion, managedActions };
