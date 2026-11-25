'use strict';

const { createHash } = require('node:crypto');
const { compileGridSort } = require('./grid-sort');

const storageKey = 'rocketbrain.database.tableSorts.v1';
const maxEntries = 64;
const maxBytes = 256 * 1024;

function sortPresetName(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 80 || /[\x00-\x1f\x7f]/.test(value)) {
    throw Error('Give the saved sort a name of 1 to 80 characters without control characters.');
  }
  return value.trim();
}

function normalize(sort, columns, sortOptions) {
  if (!Array.isArray(sort) || !sort.length) throw Error('Apply a nonempty set of table sort rules before saving it.');
  const plan = compileGridSort(columns, sort, sortOptions?.collations);
  const signature = createHash('sha256').update(JSON.stringify(plan.references.map(column => [
    column.name, column.type, column.kind, column.nullable, column.charset, column.collation, column.primaryKey
  ]))).digest('hex');
  return { sort: plan.sort, signature };
}

function createResultSorts(memento) {
  const value = memento?.get?.(storageKey);
  let items = value?.version === 1 && Array.isArray(value.items) && value.items.length <= maxEntries &&
    Buffer.byteLength(JSON.stringify(value)) <= maxBytes ? value.items.filter(item =>
      item && typeof item.key === 'string' && typeof item.name === 'string' &&
      typeof item.signature === 'string' && Array.isArray(item.sort)) : [];
  let pending = Promise.resolve();
  const identity = (item, key, name) => item.key === key && item.name.toLowerCase() === name.toLowerCase();
  function write(transform) {
    const operation = pending.then(async () => {
      const next = transform(items);
      const data = { version: 1, items: next };
      if (next.length > maxEntries || Buffer.byteLength(JSON.stringify(data)) > maxBytes) {
        throw Error('The workspace saved sort limit is reached. Remove an unused sort first.');
      }
      await memento.update(storageKey, data);
      items = next;
    });
    pending = operation.catch(() => {});
    return operation;
  }
  return {
    list(key, columns, sortOptions) {
      return items.filter(item => item.key === key).map(item => {
        let sort;
        try {
          const reviewed = normalize(item.sort, columns, sortOptions);
          if (reviewed.signature === item.signature) sort = reviewed.sort;
        } catch { /* Keep a stale preset visible so it can be removed. */ }
        return { name: item.name, sort, applicable: Boolean(sort) };
      });
    },
    save(key, value, sort, columns, sortOptions) {
      const name = sortPresetName(value), reviewed = normalize(sort, columns, sortOptions);
      return write(existing => [...existing.filter(item => !identity(item, key, name)), { key, name, ...reviewed }]);
    },
    remove(key, value) {
      const name = sortPresetName(value);
      return write(existing => existing.filter(item => !identity(item, key, name)));
    }
  };
}

module.exports = { createResultSorts, sortPresetName };
