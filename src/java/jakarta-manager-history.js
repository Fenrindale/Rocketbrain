'use strict';

const { fail } = require('./workbench-model');

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

function createManagerHistory() {
  const histories = new Map(), retained = new Set();
  let retainedBytes = 0;

  function verifyCapacity(size) {
    if (retainedBytes + size > MAX_RETAINED_BYTES || retained.size >= MAX_CONTEXTS * MAX_VERSIONS) {
      throw fail('This Tomcat Manager session reached its retained WAR archive capacity.');
    }
  }

  function inspect({ action, origin, context, username, certificateSha256, caSha256, virtualHost }, applications) {
    const key = JSON.stringify([origin, context]), before = histories.get(key);
    const owner = JSON.stringify([username, certificateSha256, caSha256, virtualHost]);
    if (action === 'track-deploy') {
      if (before || contextRows(applications, context).length) throw fail('Start tracked deployment in an empty Tomcat context.');
      if (histories.size >= MAX_CONTEXTS) throw fail('This Tomcat Manager session is already tracking sixteen contexts.');
    } else if (!before || before.owner !== owner) {
      throw fail('Choose a context tracked by this Tomcat Manager session under the same endpoint, account and certificate.');
    }

    const revisions = before?.revisions ?? [];
    if (!exactRows(applications, context, revisions)) {
      throw fail('The live Tomcat versions no longer match this session’s confirmed deployments. Review the server state.');
    }
    if (revisions.length >= MAX_VERSIONS) throw fail('This tracked Tomcat context already has eight versions.');
    const current = before?.revisions.at(-1), previous = before?.revisions.at(-2);
    if (action === 'restore' && !previous) throw fail('Publish a second tracked WAR before restoring a previous version.');
    return { key, before, owner, context, virtualHost, revisions, current, nextRevision: revisions.length + 1,
      previous: action === 'restore' ? previous : undefined };
  }

  function beforeUpload(tracked, observed) {
    if (histories.get(tracked.key) !== tracked.before || observed.virtualHost !== tracked.virtualHost ||
        !exactRows(observed.applications, tracked.context, tracked.revisions)) {
      throw fail('The reviewed live Tomcat versions changed. Review the server state again.');
    }
    if (!tracked.before && histories.size >= MAX_CONTEXTS) {
      throw fail('This Tomcat Manager session is already tracking sixteen contexts.');
    }
  }

  function confirm(tracked, version, observed, uploadedSha256, retainedArchive) {
    if (observed.virtualHost !== tracked.virtualHost ||
        !exactRows(observed.applications, tracked.context, [...tracked.revisions, { version }])) return undefined;
    const found = observed.applications.find(item => item.context === tracked.context && publicVersion(item) === version);
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

  return { inspect, beforeUpload, confirm, verifyCapacity,
    invalidate(tracked) { histories.delete(tracked.key); },
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
