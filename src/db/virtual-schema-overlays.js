'use strict';

const { randomUUID } = require('node:crypto');
const { applyDdl } = require('./ddl-model');
const { statementRanges } = require('./sql-analysis');
const { endpointKey, maxSources, validName } = require('./join-catalog');

const storageKey = 'rocketbrain.sql.virtualSchemas.v1';
const idPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const digestPattern = /^[0-9a-f]{64}$/u;
const maxDefinitions = 32;
const maxSourceBytes = 32 * 1024;
const maxSaved = 24;

function overlayScope(identity, catalog) {
  if (!digestPattern.test(identity?.connection ?? '') || !validName(identity?.database) ||
      catalog?.database !== identity.database || !['mysql', 'mariadb'].includes(catalog?.dialect) ||
      catalog.cachedMetadata || !catalog.semanticContextObserved ||
      ['tables', 'columns'].some(area => catalog.coverage?.[area] !== 'loaded')) {
    throw Error('Connect to MySQL or MariaDB with a complete visible catalog before using a saved virtual schema.');
  }
  return JSON.stringify([identity.connection, catalog.database, catalog.dialect]);
}

function definition(value) {
  const label = typeof value?.label === 'string' ? value.label.trim() : '';
  if (!label || label.length > 80 || /[\x00-\x1f\x7f]/u.test(label)) throw Error('Enter a single-line overlay name up to 80 characters.');
  const source = typeof value.source === 'string' ? value.source.trim() : '';
  if (!source || source.includes('\0') || Buffer.byteLength(source) > maxSourceBytes) {
    throw Error('Select SQL definitions up to 32 KiB for the virtual schema.');
  }
  return { label, source };
}

function load(storage) {
  const value = storage.get(storageKey);
  if (value?.version !== 1 || !Array.isArray(value.records) || value.records.length > maxSaved) return [];
  return value.records.flatMap(record => {
    try {
      const [connection, database, dialect, extra] = JSON.parse(record.scope);
      if (!digestPattern.test(connection) || !validName(database) || !['mysql', 'mariadb'].includes(dialect) ||
          extra !== undefined || record.scope !== JSON.stringify([connection, database, dialect]) ||
          !idPattern.test(record.id) || !Number.isSafeInteger(record.revision) || record.revision < 1) return [];
      return [{ id: record.id, revision: record.revision, scope: record.scope, ...definition(record) }];
    } catch {
      return [];
    }
  });
}

function createOverlayStore(storage, isTrusted) {
  let records = load(storage), pending = Promise.resolve();
  const allowed = () => {
    if (!isTrusted()) throw Error('Trust the workspace before opening or changing its virtual schemas.');
  };
  const find = (scope, id) => records.find(record => record.scope === scope && record.id === id);
  const publicRecord = ({ id, label, revision }) => ({ id, label, revision });
  const transact = action => {
    const next = pending.then(async () => {
      allowed();
      const { saved, result } = action();
      await storage.update(storageKey, { version: 1, records: saved });
      records = saved;
      return result;
    });
    pending = next.catch(() => {});
    return next;
  };
  function current(scope, id, revision) {
    const record = find(scope, id);
    if (!record || revision !== undefined && record.revision !== revision) {
      throw Error('The virtual schema changed or is unavailable for this database. Choose it again.');
    }
    return record;
  }
  return {
    list(scope) {
      allowed();
      return records.filter(record => record.scope === scope).map(publicRecord);
    },
    read(scope, id) {
      allowed();
      const record = current(scope, id);
      return { ...publicRecord(record), source: record.source };
    },
    save(scope, value, guard) {
      const input = definition(value), { id, revision } = value;
      if (id !== undefined && (!Number.isSafeInteger(revision) || revision < 1)) throw Error('Choose the current saved virtual schema before replacing it.');
      return transact(() => {
        guard();
        const previous = id === undefined ? undefined : current(scope, id, revision);
        if (!previous && records.length >= maxSaved) throw Error('Remove a saved virtual schema before saving another.');
        if (records.some(record => record.scope === scope && record !== previous &&
          record.label.toLowerCase() === input.label.toLowerCase())) throw Error('A saved virtual schema already uses that name.');
        const record = { ...input, scope, id: previous?.id ?? randomUUID(), revision: (previous?.revision ?? 0) + 1 };
        return { saved: [...records.filter(item => item !== previous), record], result: publicRecord(record) };
      });
    },
    remove(scope, id, revision, guard) {
      if (!Number.isSafeInteger(revision) || revision < 1) throw Error('Choose the current saved virtual schema before removing it.');
      return transact(() => {
        guard();
        const record = current(scope, id, revision);
        return { saved: records.filter(item => item !== record), result: true };
      });
    }
  };
}

async function buildOverlay(value, catalog, { loadForeign, assertCurrent = () => {} } = {}) {
  const { source } = definition(value);
  const parts = statementRanges(source, { dialect: catalog.dialect, sqlMode: catalog.sqlMode });
  if (parts.unknown.length || !parts.statements.length || parts.statements.length > maxDefinitions) {
    throw Error('Use up to 32 complete additive SQL definitions for an overlay.');
  }
  let model = catalog;
  const foreign = new Map(), changes = [];
  for (const part of parts.statements) {
    assertCurrent();
    const text = source.slice(part.start, part.end);
    const apply = () => applyDdl(text, model, { dialect: model.dialect, joinTables: [...foreign.values()] });
    let added;
    try {
      added = apply();
    } catch (error) {
      if (!error.endpoints || !loadForeign) throw error;
      const endpoints = [...new Map(error.endpoints.map(item => [endpointKey(item), item])).values()];
      const missing = endpoints.filter(item => !foreign.has(endpointKey(item)));
      if (!missing.length || foreign.size + missing.length > maxSources) {
        throw Error('A virtual schema can observe up to eight distinct external view inputs.');
      }
      const observed = await loadForeign({ endpoints: missing, includeEdges: false });
      assertCurrent();
      for (const item of missing) {
        const matches = observed?.tables?.filter(table => table.schema === item.schema &&
          table.name === item.table && ['table', 'view'].includes(table.kind) && table.columns?.length);
        if (matches?.length !== 1) throw Error('External view input ' + item.schema + '.' + item.table + ' is unavailable.');
        foreign.set(endpointKey(item), matches[0]);
      }
      added = apply();
    }
    if (!added) throw Error('A saved virtual schema contains only CREATE VIEW and ALTER TABLE ADD COLUMN definitions.');
    model = added.model;
    changes.push(added.change);
  }
  assertCurrent();
  return { model: { ...model, visibility: 'saved-virtual-schema', overlayExternalTables: [...foreign.values()] },
    changes, externalInputs: [...foreign.values()].map(({ schema, name, kind }) => ({ schema, name, kind })) };
}

module.exports = { createOverlayStore, overlayScope, buildOverlay };
