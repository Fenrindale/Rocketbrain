'use strict';

const { browseQuery } = require('./grid');

const storageKey = 'rocketbrain.database.tableFilters.v1';
const maxBytes = 1024 * 1024;
const maxEntries = 64;

function filterName(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 80 || /[\x00-\x1f\x7f]/.test(value)) {
    throw Error('Give the saved filter a name of 1 to 80 characters without control characters.');
  }
  return value.trim();
}

function normalize(filters, columns) {
  if (!Array.isArray(filters) || !filters.length) throw Error('Apply a nonempty set of table filters before saving it.');
  return browseQuery({ name: 'table', columns }, { filters }, 'schema').query.filters;
}

function createResultFilters(memento) {
  const value = memento?.get?.(storageKey);
  let items = value?.version === 1 && Array.isArray(value.items) && value.items.length <= maxEntries &&
    Buffer.byteLength(JSON.stringify(value)) <= maxBytes ? value.items.filter(item => item && typeof item.key === 'string' &&
    typeof item.name === 'string' && Array.isArray(item.filters)) : [];
  let pending = Promise.resolve();
  const identity = (item, key, name) => item.key === key && item.name.toLowerCase() === name.toLowerCase();
  function write(transform) {
    const operation = pending.then(async () => {
      const next = transform(items);
      const data = { version: 1, items: next };
      if (next.length > maxEntries || Buffer.byteLength(JSON.stringify(data)) > maxBytes) throw Error('The workspace saved filter limit is reached. Remove an unused filter first.');
      await memento.update(storageKey, data);
      items = next;
    });
    pending = operation.catch(() => {});
    return operation;
  }
  return {
    list(key, columns) {
      return items.filter(item => item.key === key).map(item => {
        let filters;
        try { filters = normalize(item.filters, columns); } catch { /* Keep a stale preset visible so it can be removed. */ }
        return { name: item.name, filters, applicable: Boolean(filters) };
      });
    },
    save(key, value, filters, columns) {
      const name = filterName(value), reviewed = normalize(filters, columns);
      return write(existing => [...existing.filter(item => !identity(item, key, name)), { key, name, filters: reviewed }]);
    },
    remove(key, value) {
      const name = filterName(value);
      return write(existing => existing.filter(item => !identity(item, key, name)));
    }
  };
}

module.exports = { createResultFilters, filterName };
