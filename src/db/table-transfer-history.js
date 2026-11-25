'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const idPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const entryPattern = /^(\d{13})-[0-9a-f-]{36}\.json$/;
const reviewPrefix = 'review-';
const limits = Object.freeze({ entries: 64, ageMs: 7 * 24 * 60 * 60 * 1000, bytes: 1024 });
const statuses = new Set(['matching', 'missing', 'mismatch', 'inconclusive']);
const reasons = new Set(['missing-review-evidence', 'primary-key-not-mapped', 'no-bounded-keys', 'destination-identity-changed',
  'destination-definition-changed', 'destination-unavailable', 'sample-unreadable']);
const coverage = new Set(['all-reviewed-keys', 'sampled-reviewed-keys', 'none']);
const counts = ['rows', 'sampledKeys', 'checkedKeys', 'keyLimit', 'matching', 'missing', 'mismatch', 'comparedMappedColumns'];
const decisions = Object.freeze({
  acknowledged: 'Acknowledge Inspection',
  'follow-up-required': 'Mark for Follow-up',
  'external-resolution-recorded': 'Record External Resolution'
});
const missing = error => { if (error.code !== 'ENOENT') throw error; };
const fingerprint = entries => createHash('sha256').update(JSON.stringify(entries)).digest('hex');

function reviewRecord(decision, reviewedAt) {
  return { decision, reviewedAt, historicalCommitConfirmed: false, replayBlocked: true };
}

async function readRecord(file) {
  const stat = await fs.lstat(file).catch(missing);
  if (!stat?.isFile() || stat.size > limits.bytes) return;
  const text = await fs.readFile(file, 'utf8').catch(missing);
  if (text === undefined) return;
  try { return JSON.parse(text); } catch { /* Ignore incomplete or invalid records. */ }
}

async function publishNewJson(file, contents, beforePublish) {
  const staged = path.join(path.dirname(file), '.rocketbrain-verification-' + randomUUID() + '.tmp');
  try {
    await fs.writeFile(staged, JSON.stringify(contents, null, 2) + '\n', { flag: 'wx', mode: 0o600, flush: true });
    await beforePublish();
    // The complete file is installed atomically without replacing an existing review or export.
    await fs.link(staged, file);
  } finally {
    await fs.unlink(staged).catch(() => {});
  }
}

function recordFields(captureId, observation, recordedAt) {
  if (typeof captureId !== 'string' || !idPattern.test(captureId) || !statuses.has(observation?.status) || !coverage.has(observation.coverage) ||
      !counts.every(name => Number.isSafeInteger(observation[name]) && observation[name] >= 0) ||
      observation.reason && !reasons.has(observation.reason)) return undefined;
  const { checkedKeys, sampledKeys, rows, keyLimit, matching, missing, mismatch } = observation;
  if (checkedKeys !== matching + missing + mismatch || checkedKeys > sampledKeys || sampledKeys > rows || sampledKeys > keyLimit) return undefined;
  return {
    version: 1, captureId, recordedAt, status: observation.status,
    ...(observation.reason && { reason: observation.reason }),
    coverage: observation.coverage,
    ...Object.fromEntries(counts.map(name => [name, observation[name]])),
    historicalCommitConfirmed: false, replayBlocked: true
  };
}

function createTransferHistory({ storagePath, isTrusted }) {
  const root = path.join(path.resolve(storagePath), 'table-copy-verification-history');

  function trusted() {
    if (!isTrusted()) throw Error('Open the trusted workspace that recorded the table copy check.');
  }

  async function exists() {
    const stat = await fs.lstat(root).catch(missing);
    if (stat && !stat.isDirectory()) throw Error('The table copy verification history directory is unavailable.');
    return Boolean(stat);
  }

  async function retain(now) {
    if (!await exists()) return [];
    const files = await fs.readdir(root, { withFileTypes: true });
    const ordered = files.flatMap(entry => {
      const matched = entry.isFile() && entryPattern.exec(entry.name);
      return matched ? [{ file: path.join(root, entry.name), time: Number(matched[1]), name: entry.name }] : [];
    }).sort((a, b) => b.name.localeCompare(a.name));
    const current = ordered.filter(entry => entry.time + limits.ageMs > now).slice(0, limits.entries);
    const kept = new Set(current.map(entry => entry.name));
    for (const entry of ordered) if (!kept.has(entry.name)) {
      trusted();
      await fs.unlink(entry.file).catch(missing);
    }
    for (const entry of files) {
      if (!entry.isFile() || !entry.name.startsWith(reviewPrefix)) continue;
      const observation = entry.name.slice(reviewPrefix.length);
      if (!entryPattern.test(observation) || kept.has(observation)) continue;
      // Concurrent observations may arrive after the directory listing above.
      if (await fs.lstat(path.join(root, observation)).catch(missing)) continue;
      trusted();
      await fs.unlink(path.join(root, entry.name)).catch(missing);
    }
    return current;
  }

  async function observations(captureId) {
    trusted();
    if (captureId !== undefined && (typeof captureId !== 'string' || !idPattern.test(captureId))) throw Error('Choose a saved table snapshot.');
    const records = [];
    for (const entry of await retain(Date.now())) {
      trusted();
      const item = await readRecord(entry.file);
      if (item?.version !== 1 || captureId !== undefined && item.captureId !== captureId) continue;
      const record = recordFields(item.captureId, item, new Date(entry.time).toISOString());
      if (record && record.recordedAt === item.recordedAt) records.push({ name: entry.name, record });
    }
    return records;
  }

  function reviewFile(name) { return path.join(root, reviewPrefix + name); }

  async function evidence(captureId) {
    const items = [];
    for (const { name, record } of await observations(captureId)) {
      trusted();
      const observationId = name.slice(14, -5);
      const stored = await readRecord(reviewFile(name));
      const review = stored?.version === 1 && stored.observationId === observationId && stored.captureId === record.captureId &&
        stored.observationHash === fingerprint([record]) &&
        typeof stored.decision === 'string' && Object.hasOwn(decisions, stored.decision) && typeof stored.reviewedAt === 'string' &&
        Number.isFinite(Date.parse(stored.reviewedAt)) && new Date(stored.reviewedAt).toISOString() === stored.reviewedAt &&
        stored.reviewedAt >= record.recordedAt ? reviewRecord(stored.decision, stored.reviewedAt) : undefined;
      items.push({ ...record, observationId, ...(review && { review }) });
    }
    return items;
  }

  async function currentReview(captureId) {
    if (typeof captureId !== 'string') throw Error('Choose a saved table snapshot.');
    const entries = await evidence(captureId);
    if (!entries.length) throw Error('No retained verification observation is available.');
    if (entries[0].review) throw Error('The latest verification observation already has a review.');
    return { observation: entries[0], revision: fingerprint(entries) };
  }

  return {
    async append(captureId, observation) {
      trusted();
      const now = Date.now(), recordedAt = new Date(now).toISOString();
      const record = recordFields(captureId, observation, recordedAt);
      if (!record) throw Error('The table copy verification result was not available to record.');
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
      await exists();
      trusted();
      const file = path.join(root, String(now) + '-' + randomUUID() + '.json');
      // A complete record is published under its own name, so concurrent hosts cannot lose an observation.
      const temporary = file + '.tmp';
      try {
        await fs.writeFile(temporary, JSON.stringify(record) + '\n', { flag: 'wx', mode: 0o600, flush: true });
        await fs.rename(temporary, file);
      } finally {
        await fs.unlink(temporary).catch(() => {});
      }
      await retain(now).catch(() => {});
      return record;
    },
    async list(captureId) { return (await observations(captureId)).map(item => item.record); },
    evidence,
    currentReview,
    async recordReview(captureId, revision, decision) {
      trusted();
      if (typeof decision !== 'string' || !Object.hasOwn(decisions, decision)) throw Error('Choose a verification review decision.');
      const assertCurrent = async () => {
        const entries = await evidence(captureId);
        trusted();
        if (fingerprint(entries) !== revision || !entries.length || entries[0].review) {
          throw Error('Verification evidence or its review changed. Open a new review.');
        }
        return entries[0];
      };
      const observed = await assertCurrent();
      const review = reviewRecord(decision, new Date(Math.max(Date.now(), Date.parse(observed.recordedAt))).toISOString());
      const name = Date.parse(observed.recordedAt) + '-' + observed.observationId + '.json';
      const { observationId, ...record } = observed;
      try {
        await publishNewJson(reviewFile(name), {
          version: 1, captureId, observationId, observationHash: fingerprint([record]), ...review
        }, assertCurrent);
      } catch (error) {
        if (error.code === 'EEXIST') throw Error('Verification evidence or its review changed. Open a new review.');
        throw error;
      }
      return { ...observed, review };
    }
  };
}

module.exports = { createTransferHistory, historyLimits: limits, verificationReviewDecisions: decisions, publishNewJson };
