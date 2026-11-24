'use strict';

const { randomUUID } = require('node:crypto');
const { queryText } = require('./saved-queries');

const key = 'rocketbrain.queryHistory.v1';
const retentionMs = 30 * 24 * 60 * 60 * 1000;
const maxEntries = 100;
const maxBytes = 1024 * 1024;
const uuid = /^[0-9a-f-]{36}$/i;
const targetKey = /^[0-9a-f]{64}$/;
const exposed = ({ id, revision, recordedAt, target, sql }) => ({
  id, revision, recordedAt, target, preview: sql.replace(/\s+/g, ' ').trim().slice(0, 140)
});

function createQueryHistory(state, checkAccess, { now = Date.now } = {}) {
  let queue = Promise.resolve();

  function read() {
    checkAccess();
    const value = state.get(key, { version: 1, enabled: false, entries: [] });
    if (value?.version !== 1 || typeof value.enabled !== 'boolean' || !Array.isArray(value.entries) || value.entries.length > maxEntries) {
      throw new Error('The stored query history has an unsupported format.');
    }
    const ids = new Set();
    for (const entry of value.entries) {
      if (!entry || Object.keys(entry).length !== 5 || !uuid.test(entry.id || '') || !uuid.test(entry.revision || '') || !Number.isSafeInteger(entry.recordedAt) ||
          !targetKey.test(entry.target || '') || ids.has(entry.id)) throw new Error('The stored query history contains an invalid entry.');
      queryText(entry.sql);
      ids.add(entry.id);
    }
    return value;
  }

  function recent(entries) {
    const cutoff = now() - retentionMs;
    return entries.filter(entry => entry.recordedAt > cutoff);
  }

  function mutate(action) {
    const result = queue.then(async () => {
      const before = read();
      const entries = recent(before.entries);
      const { enabled = before.enabled, next = entries, response } = action({ ...before, entries });
      if (enabled !== before.enabled || next.length !== before.entries.length ||
          next.some((entry, index) => entry !== before.entries[index])) {
        await state.update(key, { version: 1, enabled, entries: next });
      }
      return response;
    });
    queue = result.catch(() => {});
    return result;
  }

  function find(entries, id, revision) {
    const entry = entries.find(item => item.id === id);
    if (!entry || entry.revision !== revision) throw new Error('The history entry was removed, expired or changed. Open the history again.');
    return entry;
  }

  return {
    enabled: () => read().enabled,
    setEnabled(enabled) {
      if (typeof enabled !== 'boolean') throw new Error('Choose whether to record editor query history.');
      return mutate(() => ({ enabled, response: enabled }));
    },
    list({ search = '', target, since } = {}) {
      const match = search.normalize('NFKC').toLowerCase();
      return recent(read().entries).filter(entry => (!target || target === entry.target) &&
        (since === undefined || entry.recordedAt >= since) && entry.sql.normalize('NFKC').toLowerCase().includes(match))
        .map(exposed).reverse();
    },
    resolve(id, revision) { return { ...find(recent(read().entries), id, revision) }; },
    async record({ sql, target }) {
      if (!read().enabled || !targetKey.test(target?.key || '')) return false;
      queryText(sql);
      const entry = { id: randomUUID(), revision: randomUUID(), recordedAt: now(), target: target.key, sql };
      return mutate(({ enabled, entries }) => {
        if (!enabled) return { response: false };
        const next = [...entries, entry].slice(-maxEntries);
        while (Buffer.byteLength(JSON.stringify({ version: 1, enabled: true, entries: next })) > maxBytes) next.shift();
        return { next, response: true };
      });
    },
    remove(id, revision) {
      return mutate(({ entries }) => {
        const entry = find(entries, id, revision);
        return { next: entries.filter(value => value !== entry), response: true };
      });
    },
    clear: () => mutate(() => ({ next: [] })),
    prune: () => mutate(() => ({})),
    drain: () => queue
  };
}

module.exports = { createQueryHistory, retentionMs };
