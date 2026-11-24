'use strict';

const { createHash } = require('node:crypto');
const { SchemaRenamer, identifier } = require('./schema-rename');
const { canonicalValue } = require('./schema-conversion');
const { boundedProjection } = require('./table-transfer-snapshot');
const { newSession } = require('./import-stream');
const { typedCell } = require('./grid');

const sampleLimit = 32;
const keyBytes = 256;
const verificationTimeoutMs = 30000;
const fail = message => Object.assign(new Error(message), { code: 'ROCKETBRAIN_TABLE_TRANSFER' });
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const quote = (name, table = false) => '`' + identifier(name, { table }).replaceAll('`', '``') + '`';

function destinationSummary(evidence) {
  const { destination } = evidence || {};
  if (!destination || typeof destination.database !== 'string' || typeof destination.table !== 'string' ||
      !['mysql', 'mariadb'].includes(destination.engine)) return undefined;
  return { engine: destination.engine, database: destination.database, table: destination.table };
}

function createCommitEvidence({ destination, capture, definition, selected }) {
  const keys = definition.columns.filter(column => column.primaryKey).map(column => selected.findIndex(item => item.column.name === column.name));
  const rowCount = capture.rowCount;
  const columns = selected.map(item => item.column.name);
  const base = { version: 1, destination, rowCount, sourceHash: capture.sourceHash, keys, columns };
  const samples = [], indices = new Set(), distinct = new Set();
  const size = Math.min(rowCount, sampleLimit);
  const canSample = keys.length && keys.every(index => index >= 0);
  if (canSample) for (let index = 0; index < size; index++) indices.add(size === 1 ? 0 : Math.floor(index * (rowCount - 1) / (size - 1)));
  return {
    observe(row, index) {
      if (!indices.delete(index)) return;
      const values = selected.map(({ index: sourceIndex, into }) => canonicalValue(row[sourceIndex], into));
      const key = keys.map(at => values[at]), text = JSON.stringify(key);
      if (key.includes(null) || Buffer.byteLength(text) > keyBytes || distinct.has(text)) return;
      distinct.add(text);
      samples.push({ key, hash: digest(values) });
    },
    evidence() {
      return { ...base, samples: [...samples], reason: canSample ? 'no-bounded-keys' : 'primary-key-not-mapped' };
    }
  };
}

function evidenceShape(evidence) {
  return evidence?.version === 1 && destinationSummary(evidence) &&
    Number.isSafeInteger(evidence.rowCount) && evidence.rowCount > 0 && Array.isArray(evidence.columns) &&
    evidence.columns.length >= 1 && evidence.columns.length <= 64 && new Set(evidence.columns).size === evidence.columns.length &&
    evidence.columns.every(name => typeof name === 'string') && Array.isArray(evidence.keys) && evidence.keys.length <= 64 &&
    evidence.keys.every(index => Number.isInteger(index) && index < evidence.columns.length && index >= -1) &&
    Array.isArray(evidence.samples) && evidence.samples.length <= Math.min(sampleLimit, evidence.rowCount) &&
    evidence.samples.every(sample => typeof sample?.hash === 'string' && /^[a-f0-9]{64}$/.test(sample.hash) &&
      Array.isArray(sample.key) && sample.key.length === evidence.keys.length && sample.key.every(value => typeof value === 'string') &&
      Buffer.byteLength(JSON.stringify(sample.key)) <= keyBytes);
}

function observation(evidence, { status = 'inconclusive', reason, counts = { matching: 0, missing: 0, mismatch: 0 } } = {}) {
  const rows = evidence?.rowCount || 0, samples = evidence?.samples.length || 0;
  return { status, reason, destination: destinationSummary(evidence), rows, sampledKeys: samples, ...counts,
    coverage: samples ? samples === rows ? 'all-reviewed-keys' : 'sampled-reviewed-keys' : 'none',
    comparedMappedColumns: evidence?.columns.length || 0, historicalCommitConfirmed: false, replayBlocked: true };
}

function sampleQuery(evidence, columns, types) {
  const field = name => 'rb_destination.' + quote(name);
  const { fields, headers } = boundedProjection(columns, field);
  const where = evidence.keys.map(at => field(columns[at].name) + ' = ' + (types[at].kind === 'bit' ? 'CAST(? AS UNSIGNED)' : '?'));
  const { database, table } = evidence.destination;
  const from = ' FROM ' + quote(database, true) + '.' + quote(table, true) + ' AS rb_destination';
  const sql = 'SELECT ' + fields + from + ' WHERE ' + where.join(' AND ') + ' LIMIT 2';
  const metadataLockSql = 'SELECT ' + field(columns[evidence.keys[0]].name) + from + ' LIMIT 0';
  const parameters = sample => sample.key.map((value, index) => {
    const at = evidence.keys[index], type = types[at];
    if (type.kind === 'bit') return canonicalValue(value, type);
    if (type.kind === 'year' && value === '0000') return 0;
    return typedCell(value, columns[at]).parameter;
  });
  return { headers, sql, metadataLockSql, parameters };
}

async function verifyCommitEvidence(evidence, { withTableTransfer, cancellation, transferable, targetDefinition, tableIdentity }) {
  if (cancellation?.aborted) throw fail('Destination verification cancelled.');
  if (!evidenceShape(evidence)) return observation(undefined, { reason: 'missing-review-evidence' });
  if (!evidence.samples.length) return observation(evidence, { reason: evidence.reason === 'primary-key-not-mapped' ? evidence.reason : 'no-bounded-keys' });
  const { destination } = evidence;
  let inconclusiveReason = 'destination-unavailable';
  try {
    return await withTableTransfer(({ db, guard }) => {
      const reader = new SchemaRenamer(db, { createSession: (id, _, schema) => newSession(id, true, schema) });
      return reader._withSession(async session => {
        const check = () => {
          if (cancellation?.aborted) throw fail('Destination verification cancelled.');
          if (guard() !== true || !session.connected) throw fail('The destination changed during verification.');
        };
        const stop = () => { if (session.connected) db._lose(session, fail('The owned destination verification closed.')); };
        const timeout = setTimeout(stop, verificationTimeoutMs);
        timeout.unref?.();
        cancellation?.addEventListener('abort', stop, { once: true });
        try {
          check();
          const identity = await reader._identity(session);
          if (digest(identity) !== destination.identityHash || tableIdentity(identity, destination.table) !== destination.scope) {
            return observation(evidence, { reason: 'destination-identity-changed' });
          }
          await db._control(session, 'SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');
          await db._control(session, 'START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
          await db._refreshState(session);
          if (!session.inTransaction) return observation(evidence, { reason: 'destination-unavailable' });
          inconclusiveReason = 'destination-definition-changed';
          const definition = targetDefinition(await db._editor.definition(destination.table));
          if (digest(definition) !== destination.definitionHash) return observation(evidence, { reason: inconclusiveReason });
          const columns = evidence.columns.map(name => definition.columns.find(column => column.name === name));
          const primary = definition.columns.filter(column => column.primaryKey).map(column => columns.indexOf(column));
          if (!columns.every(Boolean) || !primary.length || primary.includes(-1) || JSON.stringify(primary) !== JSON.stringify(evidence.keys)) {
            return observation(evidence, { reason: inconclusiveReason });
          }
          const types = columns.map(transferable);
          if (types.some(type => !type)) return observation(evidence, { reason: inconclusiveReason });
          const { headers, sql, metadataLockSql, parameters } = sampleQuery(evidence, columns, types);
          await db._stream(session, metadataLockSql, [], { maxRows: 1, timeoutMs: 5000 }, false);
          if (digest(targetDefinition(await db._editor.definition(destination.table))) !== destination.definitionHash) {
            return observation(evidence, { reason: inconclusiveReason });
          }
          inconclusiveReason = 'sample-unreadable';
          const counts = { matching: 0, missing: 0, mismatch: 0 };
          for (const sample of evidence.samples) {
            check();
            const result = await db._stream(session, sql, parameters(sample), { maxRows: 2, timeoutMs: 5000 }, false);
            const row = result.rows[0];
            if (result.truncated || result.rows.length > 1 || JSON.stringify(result.columns) !== JSON.stringify(headers) ||
                row && (row.length !== headers.length || String(row.at(-1)) !== '0')) return observation(evidence, { reason: inconclusiveReason });
            if (!row) counts.missing++;
            else if (digest(types.map((type, at) => canonicalValue(row[at], type))) === sample.hash) counts.matching++;
            else counts.mismatch++;
          }
          check();
          await db._refreshState(session);
          if (!session.inTransaction) return observation(evidence, { reason: 'destination-unavailable' });
          await db._control(session, 'ROLLBACK');
          check();
          return observation(evidence, { status: counts.mismatch ? 'mismatch' : counts.missing ? 'missing' : 'matching', counts });
        } finally {
          clearTimeout(timeout);
          cancellation?.removeEventListener('abort', stop);
        }
      }).finally(() => reader.dispose());
    });
  } catch {
    if (cancellation?.aborted) throw fail('Destination verification cancelled.');
    return observation(evidence, { reason: inconclusiveReason });
  }
}

module.exports = { createCommitEvidence, destinationSummary, sampleLimit, verifyCommitEvidence };
