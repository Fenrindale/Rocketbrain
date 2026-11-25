'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const idPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const entryPattern = /^(\d{13})-[0-9a-f-]{36}\.json$/;
const limits = Object.freeze({ entries: 64, ageMs: 7 * 24 * 60 * 60 * 1000, bytes: 1024 });
const statuses = new Set(['matching', 'missing', 'mismatch', 'inconclusive']);
const reasons = new Set(['missing-review-evidence', 'primary-key-not-mapped', 'no-bounded-keys', 'destination-identity-changed',
  'destination-definition-changed', 'destination-unavailable', 'sample-unreadable']);
const coverage = new Set(['all-reviewed-keys', 'sampled-reviewed-keys', 'none']);
const counts = ['rows', 'sampledKeys', 'checkedKeys', 'keyLimit', 'matching', 'missing', 'mismatch', 'comparedMappedColumns'];
const missing = error => { if (error.code !== 'ENOENT') throw error; };

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
    const ordered = (await fs.readdir(root, { withFileTypes: true })).flatMap(entry => {
      const matched = entry.isFile() && entryPattern.exec(entry.name);
      return matched ? [{ file: path.join(root, entry.name), time: Number(matched[1]), name: entry.name }] : [];
    }).sort((a, b) => b.name.localeCompare(a.name));
    const current = ordered.filter(entry => entry.time + limits.ageMs > now).slice(0, limits.entries);
    const kept = new Set(current.map(entry => entry.file));
    for (const entry of ordered) if (!kept.has(entry.file)) {
      trusted();
      await fs.unlink(entry.file).catch(missing);
    }
    return current;
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
    async list(captureId) {
      trusted();
      if (captureId !== undefined && (typeof captureId !== 'string' || !idPattern.test(captureId))) throw Error('Choose a saved table snapshot.');
      const records = [];
      for (const entry of await retain(Date.now())) {
        trusted();
        const stat = await fs.lstat(entry.file).catch(missing);
        if (!stat?.isFile() || stat.size > limits.bytes) continue;
        const text = await fs.readFile(entry.file, 'utf8').catch(missing);
        if (text === undefined) continue;
        let item;
        try { item = JSON.parse(text); } catch { continue; }
        if (item?.version !== 1 || captureId !== undefined && item.captureId !== captureId) continue;
        const record = recordFields(item.captureId, item, new Date(entry.time).toISOString());
        if (record && record.recordedAt === item.recordedAt) records.push(record);
      }
      return records;
    }
  };
}

module.exports = { createTransferHistory, historyLimits: limits };
