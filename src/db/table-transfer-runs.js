'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const limits = Object.freeze({ entries: 64, days: 7, bytes: 512, checkpointMs: 1000 });
const ageMs = limits.days * 86400000;
const id = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const fileName = /^(\d{13})-([0-9a-f-]{36})\.json$/;
const terminal = new Set(['complete', 'cancelled', 'inconclusive', 'failed']);
const missing = error => { if (error.code !== 'ENOENT') throw error; };

function progressFields(value) {
  const { rows, checkedKeys, pages } = value;
  if (![rows, checkedKeys, pages].every(count => Number.isSafeInteger(count) && count >= 0) ||
      checkedKeys > rows || pages > checkedKeys || (checkedKeys > 0) !== (pages > 0)) return;
  return { rows, checkedKeys, pages };
}

function createTransferRuns({ storagePath, isTrusted }) {
  const root = path.join(path.resolve(storagePath), 'table-copy-verification-runs');
  const active = new Set();
  const trusted = () => {
    if (!isTrusted()) throw Error('Open the trusted workspace that recorded the table copy run.');
  };

  async function directory() {
    const stat = await fs.lstat(root).catch(missing);
    if (stat && !stat.isDirectory()) throw Error('The table copy run directory is unavailable.');
    return Boolean(stat);
  }

  async function retained() {
    trusted();
    if (!await directory()) return [];
    const now = Date.now();
    const ordered = (await fs.readdir(root, { withFileTypes: true })).flatMap(entry => {
      const staged = entry.name.endsWith('.tmp');
      const filename = staged ? entry.name.slice(0, -4) : entry.name;
      const match = entry.isFile() && fileName.exec(filename);
      if (!match || !id.test(match[2])) return [];
      return [{ name: entry.name, file: path.join(root, entry.name), startedAt: Number(match[1]), runId: match[2], staged }];
    }).sort((a, b) => b.name.localeCompare(a.name));
    const keep = ordered.filter(entry => !entry.staged && entry.startedAt + ageMs > now).slice(0, limits.entries);
    const kept = new Set(keep.map(entry => entry.name));
    for (const entry of ordered) {
      // Temporary files can belong to another host that is publishing a fresh checkpoint.
      if (kept.has(entry.name) || active.has(entry.runId) || entry.staged && entry.startedAt + ageMs > now) continue;
      trusted();
      await fs.unlink(entry.file).catch(missing);
    }
    return keep;
  }

  async function list(captureId) {
    trusted();
    if (captureId !== undefined && (typeof captureId !== 'string' || !id.test(captureId))) {
      throw Error('Choose a saved table snapshot.');
    }
    const entries = [];
    for (const entry of await retained()) {
      const stat = await fs.lstat(entry.file).catch(missing);
      if (!stat?.isFile() || stat.size > limits.bytes) continue;
      const contents = await fs.readFile(entry.file, 'utf8').catch(missing);
      trusted();
      if (!contents) continue;
      let record;
      try { record = JSON.parse(contents); } catch { continue; }
      if (!record || record.version !== 1 || record.runId !== entry.runId || record.startedAt !== entry.startedAt ||
          typeof record.captureId !== 'string' || !id.test(record.captureId) ||
          captureId !== undefined && record.captureId !== captureId ||
          !Number.isSafeInteger(record.checkpointAt) || record.checkpointAt < entry.startedAt ||
          record.checkpointAt > Date.now() ||
          record.state !== 'running' && !terminal.has(record.state)) continue;
      const progress = progressFields(record);
      if (!progress || record.state === 'complete' && (progress.checkedKeys !== progress.rows || progress.pages === 0)) continue;
      entries.push({
        runId: entry.runId, captureId: record.captureId, startedAt: new Date(entry.startedAt).toISOString(),
        checkpointAt: new Date(record.checkpointAt).toISOString(),
        state: record.state === 'running' && !active.has(entry.runId) ? 'last-checkpoint' : record.state,
        ...progress
      });
    }
    trusted();
    return entries;
  }

  async function begin(captureId, rows) {
    trusted();
    if (typeof captureId !== 'string' || !id.test(captureId) || !Number.isSafeInteger(rows) || rows <= 0) return;
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    await directory();
    const runId = randomUUID(), startedAt = Date.now();
    const file = path.join(root, startedAt + '-' + runId + '.json');
    let progress = { rows, checkedKeys: 0, pages: 0 }, checkpointAt = startedAt, savedPages = 0;
    async function publish(state) {
      trusted();
      await directory();
      const staged = file + '.tmp';
      const now = Math.max(checkpointAt, Date.now());
      try {
        await fs.writeFile(staged, JSON.stringify({ version: 1, runId, captureId, startedAt,
          checkpointAt: now, state, ...progress }) + '\n', { flag: 'wx', mode: 0o600, flush: true });
        trusted();
        await fs.rename(staged, file);
        checkpointAt = now;
        savedPages = progress.pages;
      } finally {
        await fs.unlink(staged).catch(() => {});
      }
    }

    active.add(runId);
    try { await publish('running'); }
    catch (error) { active.delete(runId); throw error; }
    await retained().catch(() => {});
    return {
      async checkpoint(value) {
        const next = progressFields(value);
        if (!next || next.rows !== rows || next.checkedKeys < progress.checkedKeys || next.pages < progress.pages) return;
        progress = next;
        if (next.pages > savedPages && (savedPages === 0 || Date.now() - checkpointAt >= limits.checkpointMs)) {
          await publish('running');
        }
      },
      async finish(state) {
        try {
          if (terminal.has(state)) await publish(state);
        } finally { active.delete(runId); }
      }
    };
  }

  return { list, begin };
}

module.exports = { createTransferRuns, transferRunLimits: limits };
