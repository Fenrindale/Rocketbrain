'use strict';

const { createHash } = require('node:crypto');
const { parseAllDocuments } = require('yaml');

const scope = new Map([
  ['apps/v1', new Set(['Deployment', 'StatefulSet', 'DaemonSet'])],
  ['v1', new Set(['ConfigMap', 'Service'])],
  ['networking.k8s.io/v1', new Set(['Ingress'])]
]);
const safeName = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/u;
const revisionLimit = 100;
const resourceLimit = 24;
const responseLimit = 256 * 1024;
const hash = value => createHash('sha256').update(value).digest('hex');

function manifest(bytes, namespace) {
  const documents = parseAllDocuments(bytes, { strict: true, uniqueKeys: true });
  const items = new Map();
  for (const document of documents) {
    if (document.errors.length || document.warnings.length) throw Error('Helm returned a manifest that could not be safely reviewed.');
    let data;
    try { data = document.toJS({ maxAliasCount: 0 }); }
    catch { throw Error('Helm returned a manifest that could not be safely reviewed.'); }
    if (data === null) continue;
    const { apiVersion, kind, metadata } = data;
    if (!scope.get(apiVersion)?.has(kind) || typeof metadata?.name !== 'string' || !safeName.test(metadata.name) ||
        (metadata.namespace !== undefined && metadata.namespace !== namespace) ||
        metadata.generateName !== undefined || metadata.annotations?.['helm.sh/hook'] || items.size >= resourceLimit) {
      throw Error('Use a release with a bounded set of supported resources in the selected namespace.');
    }
    const key = apiVersion + '/' + kind + '/' + metadata.name;
    if (items.has(key)) throw Error('Helm returned duplicate release resources.');
    items.set(key, { kind, name: metadata.name, digest: hash(JSON.stringify(data)) });
  }
  if (!items.size) throw Error('Helm returned no resources to review.');
  return { hash: hash(bytes), items };
}

function createHelmReleaseActions(request) {
  const reviews = new WeakMap();
  const running = new Set();

  async function history(namespace, release, signal) {
    if (typeof release !== 'string' || release.length > 53 || !safeName.test(release) || release.includes('.')) {
      throw Error('Choose a listed Helm release.');
    }
    let data;
    const raw = await request(namespace, ['history', release, '--max=' + revisionLimit, '--output=json'],
      'Helm release history', responseLimit, signal);
    try { data = JSON.parse(raw); }
    catch { throw Error('Helm returned invalid revision history.'); }
    if (!Array.isArray(data) || !data.length || data.length > revisionLimit) throw Error('Helm returned invalid revision history.');
    const rows = data.map(item => ({
      revision: Number(item?.revision),
      status: typeof item?.status === 'string' && /^[a-z-]{1,32}$/u.test(item.status) ? item.status : 'unknown',
      chart: typeof item?.chart === 'string' && /^[a-zA-Z0-9._+-]{1,125}$/u.test(item.chart) ? item.chart : ''
    })).sort((first, second) => second.revision - first.revision);
    if (!rows.every(row => Number.isSafeInteger(row.revision) && row.revision > 0) ||
        rows.length !== new Set(rows.map(row => row.revision)).size) throw Error('Helm returned invalid revision history.');
    return rows;
  }

  async function readManifest(namespace, release, revision, signal) {
    const raw = await request(namespace, ['get', 'manifest', release, '--revision=' + revision],
      'Helm revision manifest', responseLimit, signal);
    return manifest(raw, namespace);
  }

  async function inspect(namespace, release, target, signal) {
    const rows = await history(namespace, release, signal);
    const [current] = rows;
    const previous = rows.find(row => row.revision === target && row.status === 'superseded');
    if (current.status !== 'deployed' || current.revision >= Number.MAX_SAFE_INTEGER || !previous || target >= current.revision) {
      throw Error('Choose a superseded Helm revision for the current deployed release.');
    }
    const [from, to] = await Promise.all([
      readManifest(namespace, release, current.revision, signal), readManifest(namespace, release, target, signal)
    ]);
    if (from.items.size !== to.items.size || [...from.items.keys()].some(key => !to.items.has(key))) {
      throw Error('Rollback may change the listed resources. This workbench requires the same resource set on both revisions.');
    }
    const resources = [...from.items].map(([key, item]) => ({ kind: item.kind, name: item.name, changed: item.digest !== to.items.get(key).digest }));
    return { from: current, to: previous, hashes: [from.hash, to.hash], resources };
  }

  const rollbackArgs = (release, target) => ['rollback', release, String(target), '--no-hooks', '--timeout=8s'];
  return {
    history,
    async review(namespace, release, target, signal) {
      if (!Number.isSafeInteger(target) || target < 1) throw Error('Choose a listed Helm revision.');
      const observed = await inspect(namespace, release, target, signal);
      await request(namespace, [...rollbackArgs(release, target), '--dry-run=server'],
        'Helm rollback preview', responseLimit, signal);
      const review = Object.freeze({ namespace, release, from: observed.from.revision, to: target,
        resources: Object.freeze(observed.resources.map(item => Object.freeze(item))) });
      reviews.set(review, { ...observed, expires: Date.now() + 120000 });
      return review;
    },
    async apply(review, { approved, signal } = {}) {
      const previous = reviews.get(review);
      if (!previous || Date.now() >= previous.expires || approved !== true) throw Error('Approve a current Helm rollback review.');
      reviews.delete(review);
      const { namespace, release, from, to } = review;
      const key = namespace + '/' + release;
      if (running.has(key)) throw Error('A reviewed Helm rollback is already running for this release.');
      running.add(key);
      try {
        const latest = await inspect(namespace, release, to, signal);
        if (latest.from.revision !== from || latest.hashes.some((value, index) => value !== previous.hashes[index])) {
          throw Error('The Helm release changed. Inspect its current revisions before retrying.');
        }
        await request(namespace, rollbackArgs(release, to), 'Helm rollback', responseLimit, signal);
        let recordedRevision = null;
        try {
          const [recorded] = await history(namespace, release, signal);
          if (recorded.status === 'deployed' && recorded.revision === from + 1 &&
              (await readManifest(namespace, release, recorded.revision, signal)).hash === previous.hashes[1]) {
            recordedRevision = recorded.revision;
          }
        } catch {}
        return { namespace, release, previousRevision: from, restoredFrom: to, recordedRevision };
      } finally { running.delete(key); }
    }
  };
}

module.exports = { createHelmReleaseActions };
