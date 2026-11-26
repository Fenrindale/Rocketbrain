'use strict';

const { randomUUID } = require('node:crypto');
const { platformSupported, errorWith, selectSqliteEditRuntime, runSqliteCellOperation } = require('./sqlite-edit-runtime');
const { integer, normalizeCell, acceptsCell, cellUpdateSql } = require('./sqlite-edit-values');

const reviewLifetime = 120000;
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const reviewChanged = () => errorWith('REVIEW', 'Review the exact current SQLite file and explicitly approve its one-cell edit.');
const asUserValue = callback => {
  try { return callback(); }
  catch (error) { if (error.code === 'VALUE') throw errorWith('VALUE', error.message); throw error; }
};

function createSqliteCellEditor({ isTrusted, currentSnapshot }) {
  let runtime, active, disposed = false;
  const drafts = new Map(), reviews = new Map();
  const trusted = () => { if (disposed || !isTrusted()) throw errorWith('TRUST', 'Trust the workspace before opening SQLite cell editing.'); };

  function remember(records, value) {
    while (records.size >= 4) records.delete(records.keys().next().value);
    records.set(value.id, value);
  }

  async function invoke(signal, action) {
    trusted();
    if (active) throw errorWith('BUSY', 'Wait for the current SQLite cell operation to finish.');
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    active = controller;
    try { return await action(controller.signal); }
    finally { active = undefined; signal?.removeEventListener('abort', abort); }
  }

  function guard(point, pin) {
    if (disposed || !isTrusted() || runtime !== pin) return false;
    try { return currentSnapshot().session === point.session; }
    catch { return false; }
  }

  return {
    platformSupported,
    runtime: () => runtime && isTrusted() ? { node: runtime.node, sqlite: runtime.sqlite, sha256: runtime.sha256 } : null,
    selectRuntime(file, { signal } = {}) {
      return invoke(signal, async cancellation => {
        const verified = await selectSqliteEditRuntime(file, { signal: cancellation });
        trusted();
        runtime = verified;
        drafts.clear();
        reviews.clear();
        return this.runtime();
      });
    },
    inspect({ table, key }, { signal } = {}) {
      return invoke(signal, async cancellation => {
        const point = currentSnapshot(), pin = runtime;
        if (!pin) throw errorWith('RUNTIME', 'Choose the pinned official Node.js runtime for SQLite cell editing first.');
        if (typeof table !== 'string' || !table.length || table.length > 128 || /[\x00-\x1f\x7f]/u.test(table)) {
          throw errorWith('SCOPE', 'Choose one exact ordinary SQLite table.');
        }
        const { file, fileIdentity } = point;
        const numericKey = asUserValue(() => integer(key));
        const request = { file, fileIdentity, table, key: numericKey };
        const observed = await runSqliteCellOperation(pin, { ...request, operation: 'observe' },
          { signal: cancellation, guard: () => guard(point, pin) });
        trusted();
        if (!guard(point, pin)) throw reviewChanged();
        const id = randomUUID();
        const model = { id, ...observed, fileName: point.name, fileIdentity };
        remember(drafts, { id, point, pin, request, model, expires: Date.now() + reviewLifetime });
        return structuredClone(model);
      });
    },
    review(draftId, columnName, input) {
      trusted();
      const saved = drafts.get(draftId);
      if (!saved || saved.expires < Date.now() || !guard(saved.point, saved.pin)) throw reviewChanged();
      const { model, point } = saved;
      const index = model.columns.findIndex(column => column.name === columnName);
      const column = model.columns[index], replacement = asUserValue(() => normalizeCell(input));
      if (!acceptsCell(column, replacement)) {
        throw errorWith('VALUE', 'Choose one supported non-key column and a value of its declared storage type or an allowed SQL NULL.');
      }
      const previous = model.cells[index];
      if (same(previous, replacement)) throw errorWith('VALUE', 'Enter a changed SQLite cell value.');
      const id = randomUUID(), expires = Date.now() + reviewLifetime;
      const review = { id, fileName: point.name, fileIdentity: point.fileIdentity, schemaFingerprint: model.schemaFingerprint,
        rowFingerprint: model.rowFingerprint, table: model.table, keyColumn: model.keyColumn, key: model.key, column: column.name,
        previous, replacement, expiresAt: expires,
        sql: cellUpdateSql(model.table, column.name, model.keyColumn) };
      drafts.delete(draftId);
      remember(reviews, { ...saved, id, expires, review });
      return structuredClone(review);
    },
    discard(id) { drafts.delete(id); reviews.delete(id); },
    apply(id, approved, { signal } = {}) {
      return invoke(signal, async cancellation => {
        const saved = reviews.get(id);
        if (approved !== true || !saved || saved.expires < Date.now() || !guard(saved.point, saved.pin)) throw reviewChanged();
        const { schemaFingerprint, rowFingerprint, column, replacement } = saved.review;
        reviews.delete(id);
        return runSqliteCellOperation(saved.pin, { ...saved.request, operation: 'apply', approved: true, schemaFingerprint,
          rowFingerprint, column, replacement }, { signal: cancellation, guard: () => guard(saved.point, saved.pin) });
      });
    },
    dispose() {
      disposed = true;
      active?.abort();
      runtime = undefined;
      drafts.clear();
      reviews.clear();
    }
  };
}

module.exports = { createSqliteCellEditor };
