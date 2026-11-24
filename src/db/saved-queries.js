'use strict';

const { randomUUID } = require('node:crypto');

const key = 'rocketbrain.savedQueries';
const capacity = 64;
const maxQueryBytes = 128 * 1024;
const maxStoreBytes = 1024 * 1024;
const uuid = /^[0-9a-f-]{36}$/i;

function queryName(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('Give the query a name of 1–80 characters without line breaks or control characters.');
  }
  return value.trim();
}

function queryText(value) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || Buffer.byteLength(value) > maxQueryBytes) {
    throw new Error('Choose SQL without NUL bytes and no larger than 128 KiB.');
  }
  return value;
}

const nameKey = value => value.normalize('NFKC').toLowerCase();
const summary = ({ id, name, favorite, revision }) => ({ id, name, favorite, revision });

function createSavedQueries(state, checkAccess) {
  let queue = Promise.resolve();

  function read() {
    checkAccess();
    const collection = state.get(key, { version: 1, queries: [] });
    if (collection?.version !== 1 || !Array.isArray(collection.queries) || collection.queries.length > capacity) {
      throw new Error('The saved query collection is unavailable or has an unsupported format.');
    }
    const ids = new Set();
    const names = new Set();
    for (const query of collection.queries) {
      if (!query || typeof query.id !== 'string' || !uuid.test(query.id) || typeof query.revision !== 'string' || !uuid.test(query.revision)
          || typeof query.favorite !== 'boolean' || ids.has(query.id) || query.name !== queryName(query.name) || names.has(nameKey(query.name))) {
        throw new Error('The saved query collection has an invalid entry.');
      }
      queryText(query.sql);
      ids.add(query.id);
      names.add(nameKey(query.name));
    }
    return collection.queries;
  }

  function checkRevision(queries, id, revision) {
    const query = queries.find(entry => entry.id === id);
    if (!query || query.revision !== revision) throw new Error('The saved query changed. Open the list again.');
    return query;
  }

  function mutate(operation) {
    const result = queue.then(async () => {
      const { queries, entry } = operation(read());
      const next = { version: 1, queries };
      if (Buffer.byteLength(JSON.stringify(next)) > maxStoreBytes) throw new Error('The saved query collection exceeds 1 MiB. Remove an entry to continue.');
      await state.update(key, next);
      return summary(entry);
    });
    queue = result.catch(() => {});
    return result;
  }

  function ensureUnique(queries, name, id) {
    if (queries.some(entry => entry.id !== id && nameKey(entry.name) === nameKey(name))) {
      throw new Error('A saved query already uses that name.');
    }
  }

  return {
    list() {
      return read().map(summary).sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name));
    },
    source(id, revision) {
      return checkRevision(read(), id, revision).sql;
    },
    save(name, sql) {
      return mutate(queries => {
        if (queries.length >= capacity) throw new Error('Store at most 64 workspace queries.');
        const entry = { id: randomUUID(), revision: randomUUID(), name: queryName(name), sql: queryText(sql), favorite: false };
        ensureUnique(queries, entry.name);
        return { queries: [...queries, entry], entry };
      });
    },
    update(id, revision, { name, sql, favorite } = {}) {
      return mutate(queries => {
        const previous = checkRevision(queries, id, revision);
        if (favorite !== undefined && typeof favorite !== 'boolean') throw new Error('Choose whether to mark the query as a favorite.');
        const entry = { ...previous, revision: randomUUID(),
          name: name === undefined ? previous.name : queryName(name),
          sql: sql === undefined ? previous.sql : queryText(sql),
          favorite: favorite === undefined ? previous.favorite : favorite };
        ensureUnique(queries, entry.name, id);
        return { queries: queries.map(query => query.id === id ? entry : query), entry };
      });
    },
    remove(id, revision) {
      return mutate(queries => ({ entry: checkRevision(queries, id, revision), queries: queries.filter(query => query.id !== id) }));
    },
    drain: () => queue
  };
}

module.exports = { createSavedQueries, queryName, queryText };
