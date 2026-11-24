'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { SchemaRenamer, identifier } = require('./schema-rename');
const { canonicalValue, describeType } = require('./schema-conversion');
const { StreamImporter, newSession, LIMITS: IMPORT_LIMITS } = require('./import-stream');

const limits = Object.freeze({ rows: 500, columns: 64, bytes: 1024 * 1024, entries: 4, durationMs: 10 * 60 * 1000 });
const fail = message => Object.assign(new Error(message), { code: 'ROCKETBRAIN_TABLE_TRANSFER' });
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const quote = name => '`' + identifier(name, { table: true }).replaceAll('`', '``') + '`';
const publicColumn = ({ name, type, nullable, primaryKey, insertable, required }) => ({ name, type, nullable, primaryKey, insertable, required });
const cancelled = token => token?.isCancellationRequested || token?.aborted;

function targetDefinition(definition) {
  if (definition.kind !== 'BASE TABLE' || String(definition.engine).toUpperCase() !== 'INNODB' || /^__rb_/i.test(definition.name)) {
    throw fail('Choose an ordinary InnoDB base table.');
  }
  if (!definition.triggerVisibility || definition.triggers.length) throw fail('The destination requires verified absence of triggers.');
  return definition;
}

function transferable(column) {
  let type;
  try {
    const normalized = column.kind === 'json' && / \(JSON_VALID\)$/.test(column.type)
      ? { ...column, type: column.type.replace(/ \(JSON_VALID\)$/, ''), json: true } : column;
    type = describeType(normalized);
  } catch { return null; }
  // TIMESTAMP depends on session time zones; normalize neither time zones nor
  // floating, CHAR-padding or fixed binary representations during a copy.
  if (['integer', 'decimal', 'date', 'datetime', 'time', 'json'].includes(type.kind)) return type;
  if (type.category === 'binary' && type.kind !== 'binary') return type;
  if (type.category === 'text' && type.charset === 'utf8mb4' && /^(?:varchar|(?:tiny|medium|long)?text)$/.test(type.kind)) return type;
  return null;
}

function useValue(value, column) {
  const type = transferable(column);
  if (!type) throw fail('Unsupported transfer column ' + column.name + '.');
  return canonicalValue(value, type);
}

function assertMappedValues(source, selected) {
  for (const { source: index, column } of selected) {
    const origin = source.columns[index], from = transferable(origin), into = transferable(column);
    if (!from || !into || from.kind !== into.kind && !(from.category === into.category && ['text', 'binary'].includes(from.category))) {
      throw fail('Map compatible exact types for ' + origin.name + ' and ' + column.name + '.');
    }
    for (const [rowIndex, row] of source.rows.entries()) {
      const value = row[index];
      let fromValue, toValue;
      try { fromValue = canonicalValue(value, from); toValue = canonicalValue(value, into); }
      catch { throw fail('Captured row ' + (rowIndex + 1) + ' cannot enter ' + column.name + ' without conversion.'); }
      if (fromValue !== toValue) throw fail('Captured row ' + (rowIndex + 1) + ' would change value in ' + column.name + '.');
    }
  }
}

function tableIdentity(identity, table) {
  const fold = value => identity.tableNameCaseSensitive ? value : value.toLowerCase();
  return digest([identity.dialect, identity.serverUniqueId, fold(identity.database), fold(table)]);
}

function bounded(map) {
  for (const [id, entry] of map) if (entry.expiresAt <= Date.now()) map.delete(id);
  while (map.size >= limits.entries) map.delete(map.keys().next().value);
}

function leaseGuard(lease, cancellation) {
  if (lease.guard() !== true) throw fail('The database or workspace changed. Inspect the current connection again.');
  if (cancelled(cancellation)) throw fail('Table copy cancelled.');
}

async function inspectIdentity(db) {
  const reader = new SchemaRenamer(db, { createSession: (id, _, database) => newSession(id, true, database) });
  try { return await reader._withSession(session => reader._identity(session)); }
  finally { reader.dispose(); }
}

async function captureTable(lease, table, cancellation) {
  identifier(table, { table: true });
  if (/^__rb_/i.test(table)) throw fail('Choose a user table.');
  const { db } = lease;
  leaseGuard(lease, cancellation);
  const definition = await db._editor.definition(table);
  if (definition.kind !== 'BASE TABLE' || String(definition.engine).toUpperCase() !== 'INNODB') {
    throw fail('Select an ordinary InnoDB source table.');
  }
  const keys = definition.columns.filter(column => column.primaryKey);
  if (!keys.length) throw fail('A visible primary key is required for a stable capture order.');
  const columns = definition.columns.filter(column => !column.generated && transferable(column));
  if (!columns.length || columns.length > limits.columns) throw fail('Use a source table with 1–64 supported columns.');
  const reader = new SchemaRenamer(db, { createSession: (id, _, database) => newSession(id, true, database) });
  try {
    return await reader._withSession(async session => {
      leaseGuard(lease, cancellation);
      const identity = await reader._identity(session);
      const sql = 'SELECT ' + columns.map(column => quote(column.name)).join(',') + ' FROM ' +
        quote(identity.database) + '.' + quote(table) + ' ORDER BY ' + keys.map(column => quote(column.name)).join(',') +
        ' LIMIT ' + (limits.rows + 1);
      const result = await db._stream(session, sql, [], { maxRows: limits.rows + 1, timeoutMs: IMPORT_LIMITS.statementTimeoutMs }, false);
      leaseGuard(lease, cancellation);
      if (result.truncated || result.rows.length > limits.rows) throw fail('Capture at most 500 source rows or the 1 MiB transfer limit.');
      if (!result.rows.length) throw fail('The selected source has no rows.');
      if (JSON.stringify(result.columns) !== JSON.stringify(columns.map(column => column.name))) throw fail('The source projection changed during capture.');
      const rows = result.rows.map(row => row.map((value, index) => {
        if (value === null) return null;
        useValue(value, columns[index]);
        return String(value);
      }));
      if (Buffer.byteLength(JSON.stringify(rows)) > limits.bytes) throw fail('The captured rows exceed 1 MiB.');
      const after = await db._editor.definition(table);
      if (digest(definition) !== digest(after) || digest(identity) !== digest(await reader._identity(session))) {
        throw fail('The source definition or server context changed during capture.');
      }
      leaseGuard(lease, cancellation);
      return { id: randomUUID(), expiresAt: Date.now() + limits.durationMs, database: identity.database, table,
        scope: tableIdentity(identity, table), engine: identity.dialect, columns, rows, rowCount: rows.length,
        omittedColumns: definition.columns.length - columns.length, sourceHash: digest({ columns, rows }) };
    });
  } finally { reader.dispose(); }
}

function returnCapture(capture) {
  const { id, expiresAt, database, table, scope, engine, rowCount, omittedColumns, sourceHash } = capture;
  return { id, expiresAt, database, table, scope, engine, rowCount, omittedColumns, sourceHash, columns: capture.columns.map(publicColumn) };
}

function retainedSource(capture, target) {
  return {
    options: () => ({ file: capture.table, format: 'retained-table' }),
    async scan(options, callbacks) {
      if (capture.expiresAt <= Date.now()) throw fail('The source snapshot expired. Capture the source table again.');
      const metadata = { width: capture.columns.length, headers: capture.columns.map(column => column.name) };
      const identity = { snapshotId: capture.id, scope: capture.scope };
      const state = { ...metadata, fileIdentity: identity, fileHash: capture.sourceHash, dataHash: capture.sourceHash,
        rowCount: capture.rowCount, format: options.format, preview: [] };
      await callbacks.onStart?.(state);
      await callbacks.onMetadata?.(metadata);
      for (const row of capture.rows) {
        if (cancelled(callbacks.cancellation)) throw fail('Table copy cancelled.');
        await callbacks.onRow?.({ values: row, nulls: row.map(value => value === null) });
      }
      return state;
    },
    validateSelection({ selected, definition }) {
      if (digest(definition) !== target.definitionHash) throw fail('The destination definition changed. Choose the destination again.');
      assertMappedValues(capture, selected);
    },
    validateTarget({ identity, definition }) {
      const scope = tableIdentity(identity, definition.name);
      if (scope === capture.scope) throw fail('Choose a different destination table.');
      if (scope !== target.scope || digest(identity) !== target.identityHash) throw fail('The destination connection changed. Inspect it again.');
    }
  };
}

function createTableTransfer(database) {
  const captures = new Map(), targets = new Map(), reviews = new Map(), operations = new Set();
  let pending, closed = false;
  const tracked = action => (...args) => {
    if (closed) return Promise.reject(fail('Table copy is closed.'));
    const work = action(...args);
    operations.add(work);
    void work.finally(() => operations.delete(work)).catch(() => {});
    return work;
  };
  const retained = (entries, id, name) => {
    const value = entries.get(id);
    if (!value || value.expiresAt <= Date.now()) throw fail('The ' + name + ' expired. Prepare it again.');
    return value;
  };
  const live = (lease, observed) => {
    if (lease.db !== observed.db || lease.epoch !== observed.epoch) throw fail('The destination connection changed. Prepare it again.');
    leaseGuard(lease);
  };

  const api = {
    capture: tracked(async ({ table, cancellation } = {}) => database.withTableTransfer(async lease => {
      const capture = await captureTable(lease, table, cancellation);
      bounded(captures);
      captures.set(capture.id, capture);
      return returnCapture(capture);
    })),
    listSources: () => [...captures.values()].filter(capture => capture.expiresAt > Date.now()).map(returnCapture),
    discardSource: id => captures.delete(id),
    inspectDestination: tracked(async ({ captureId, table } = {}) => database.withTableTransfer(async lease => {
      const capture = retained(captures, captureId, 'source snapshot');
      identifier(table, { table: true });
      const definition = targetDefinition(await lease.db._editor.definition(table)), identity = await inspectIdentity(lease.db);
      leaseGuard(lease);
      const scope = tableIdentity(identity, table);
      if (scope === capture.scope) throw fail('Choose a different destination table.');
      const destination = { id: randomUUID(), captureId, db: lease.db, epoch: lease.epoch, scope, table,
        definitionHash: digest(definition), identityHash: digest(identity), expiresAt: Date.now() + limits.durationMs };
      bounded(targets);
      targets.set(destination.id, destination);
      return { id: destination.id, scope, table, database: identity.database, engine: identity.dialect,
        columns: definition.columns.map(column => ({
          ...publicColumn(column), insertable: column.insertable && Boolean(transferable(column))
        })) };
    })),
    preview: tracked(async ({ captureId, destinationId, mapping } = {}) => database.withTableTransfer(async lease => {
      const capture = retained(captures, captureId, 'source snapshot');
      const target = retained(targets, destinationId, 'destination inspection');
      live(lease, target);
      if (target.captureId !== captureId) throw fail('The destination inspection belongs to another source snapshot.');
      if (!Array.isArray(mapping) || mapping.length !== capture.columns.length) throw fail('Map or explicitly ignore each source column.');
      const numeric = mapping.map(item => ({ source: capture.columns.findIndex(col => col.name === item?.source), target: item?.target }));
      const manager = new StreamImporter(lease.db, { source: retainedSource(capture, target), onStateChange: value => {
        if (!value && pending?.manager === manager) {
          const { releasePending } = pending;
          pending = undefined;
          releasePending();
        }
      } });
      try {
        const plan = await manager.prepare({ table: target.table, mapping: numeric, guard: lease.guard });
        const entry = { id: plan.reviewId, expiresAt: Math.min(plan.expiresAt, target.expiresAt, capture.expiresAt),
          db: lease.db, epoch: lease.epoch, manager, captureId };
        for (const [id, review] of reviews) if (review.expiresAt <= Date.now() || reviews.size >= limits.entries) {
          reviews.delete(id); await review.manager.dispose();
        }
        reviews.set(entry.id, entry);
        return { reviewId: plan.reviewId, expiresAt: entry.expiresAt, source: returnCapture(capture), destination: { table: plan.table, database: plan.database, scope: target.scope },
          rowCount: plan.rowCount, mapping: structuredClone(mapping), sql: plan.sql, rowsIncluded: false,
          automaticCommit: false, automaticRetry: false };
      } catch (error) { await manager.dispose(); throw error; }
    })),
    async discardReview(id) {
      const review = reviews.get(id);
      if (!review) return false;
      reviews.delete(id);
      await review.manager.dispose();
      return true;
    },
    run: tracked(async ({ reviewId, cancellation, onProgress } = {}) => database.withTableTransfer(async lease => {
      const review = retained(reviews, reviewId, 'table copy review');
      live(lease, review);
      retained(captures, review.captureId, 'source snapshot');
      reviews.delete(reviewId);
      let wait = false;
      try {
        const report = await review.manager.run({ reviewId, guard: lease.guard, cancellation, onProgress });
        if (report.state === 'awaiting-commit') {
          pending = { db: lease.db, epoch: lease.epoch, manager: review.manager, releasePending: lease.releasePending, report };
          wait = true;
        }
        return structuredClone(report);
      } finally { if (!wait) await review.manager.dispose(); }
    })),
    pending: () => pending ? structuredClone(pending.report) : null,
    settle: tracked(async ({ transactionId, commit } = {}) => {
      if (typeof commit !== 'boolean') throw fail('Choose Commit or Roll Back.');
      const selected = pending;
      if (!selected || selected.report.transactionId !== transactionId) throw fail('No matching pending table copy remains.');
      return database.withTableTransfer(async lease => {
        if (commit) live(lease, selected);
        try { return await (commit ? selected.manager.commit({ transactionId, guard: lease.guard }) : selected.manager.rollback({ transactionId })); }
        finally { if (!selected.manager.hasPendingTransaction(transactionId)) await selected.manager.dispose(); }
      }, { settling: true });
    }),
    async dispose() {
      if (closed) return;
      closed = true;
      await Promise.allSettled([...operations]);
      if (pending) await pending.manager.dispose();
      await Promise.allSettled([...reviews.values()].map(review => review.manager.dispose()));
      captures.clear(); targets.clear(); reviews.clear();
    }
  };
  return api;
}

module.exports = { createTableTransfer, transferable, assertMappedValues, tableIdentity, limits };
