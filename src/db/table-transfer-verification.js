'use strict';

const { createHash } = require('node:crypto');
const { SchemaRenamer, identifier } = require('./schema-rename');
const { canonicalValue } = require('./schema-conversion');
const { boundedProjection } = require('./table-transfer-snapshot');
const { newSession } = require('./import-stream');
const { typedCell } = require('./grid');

const legacySampleLimit = 32;
const sampleLimit = 128;
const keyBytes = 256;
const verificationTimeoutMs = 60000;
const fullVerificationTimeoutMs = 600000;
const fullPageSize = 16;
const fail = message => Object.assign(new Error(message), { code: 'ROCKETBRAIN_TABLE_TRANSFER' });
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const quote = (name, table = false) => '`' + identifier(name, { table }).replaceAll('`', '``') + '`';
const exactUnsignedParameter = 'CAST(? AS DECIMAL(20,0))';
const exactBitParameter = 'CAST(' + exactUnsignedParameter + ' AS UNSIGNED)';
const guardedFailures = new Set(['retained-snapshot-metadata-changed', 'retained-snapshot-authentication-failed',
  'retained-evidence-changed', 'destination-verification-interrupted']);

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
  const base = { version: 3, destination, rowCount, sourceHash: capture.sourceHash, keys, columns,
    sourceColumns: selected.map(item => item.index) };
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

function evidenceLimit(evidence) {
  if (evidence?.version === 1) return legacySampleLimit;
  if (evidence?.version === 2 || evidence?.version === 3) return sampleLimit;
  return 0;
}

function evidenceShape(evidence) {
  const limit = evidenceLimit(evidence);
  return limit && destinationSummary(evidence) &&
    Number.isSafeInteger(evidence.rowCount) && evidence.rowCount > 0 && Array.isArray(evidence.columns) &&
    evidence.columns.length >= 1 && evidence.columns.length <= 64 && new Set(evidence.columns).size === evidence.columns.length &&
    evidence.columns.every(name => typeof name === 'string') && Array.isArray(evidence.keys) && evidence.keys.length <= 64 &&
    evidence.keys.every(index => Number.isInteger(index) && index < evidence.columns.length && index >= -1) &&
    Array.isArray(evidence.samples) && evidence.samples.length <= Math.min(limit, evidence.rowCount) &&
    evidence.samples.every(sample => typeof sample?.hash === 'string' && /^[a-f0-9]{64}$/.test(sample.hash) &&
      Array.isArray(sample.key) && sample.key.length === evidence.keys.length && sample.key.every(value => typeof value === 'string') &&
      Buffer.byteLength(JSON.stringify(sample.key)) <= keyBytes);
}

function observation(evidence, { status = 'inconclusive', reason, counts = { matching: 0, missing: 0, mismatch: 0 } } = {}) {
  const rows = evidence?.rowCount || 0, samples = evidence?.samples.length || 0;
  const checkedKeys = counts.matching + counts.missing + counts.mismatch;
  return { status, reason, destination: destinationSummary(evidence), rows, sampledKeys: samples, checkedKeys, keyLimit: evidenceLimit(evidence), ...counts,
    coverage: checkedKeys ? checkedKeys === rows ? 'all-reviewed-keys' : 'sampled-reviewed-keys' : 'none',
    comparedMappedColumns: evidence?.columns.length || 0, historicalCommitConfirmed: false, replayBlocked: true };
}

function placeholder(type) {
  if (type.kind === 'bit') return exactBitParameter;
  // MySQL can truncate a prepared string converted directly to UNSIGNED to the signed BIGINT range.
  if (type.kind === 'integer' && type.unsigned) return exactUnsignedParameter;
  if (type.kind === 'integer') return 'CAST(? AS SIGNED)';
  if (type.kind === 'decimal') return 'CAST(? AS DECIMAL(' + type.precision + ',' + type.scale + '))';
  return '?';
}

function sampleQuery(evidence, columns, types) {
  const field = name => 'rb_destination.' + quote(name);
  const { fields, headers } = boundedProjection(columns, field);
  const where = evidence.keys.map(at => field(columns[at].name) + ' = ' + placeholder(types[at]));
  const { database, table } = evidence.destination;
  const from = ' FROM ' + quote(database, true) + '.' + quote(table, true) + ' AS rb_destination';
  const sql = 'SELECT ' + fields + from + ' WHERE ' + where.join(' AND ') + ' LIMIT 2';
  const metadataLockSql = 'SELECT ' + field(columns[evidence.keys[0]].name) + from + ' LIMIT 0';
  return { headers, sql, metadataLockSql };
}

function keyParameters(evidence, columns, types, key) {
  return key.map((value, index) => {
    const at = evidence.keys[index], type = types[at];
    if (type.kind === 'bit') return canonicalValue(value, type);
    if (type.kind === 'year' && value === '0000') return 0;
    return typedCell(value, columns[at]).parameter;
  });
}

async function readReviewedDestination(evidence, { withTableTransfer, cancellation, transferable, targetDefinition, tableIdentity },
  inspect, inconclusive, timeoutMs = verificationTimeoutMs) {
  const { destination } = evidence;
  let inconclusiveReason = 'destination-unavailable';
  try {
    return await withTableTransfer(({ db, guard }) => {
      const reader = new SchemaRenamer(db, { createSession: (id, _, schema) => newSession(id, true, schema) });
      return reader._withSession(async session => {
        const check = () => {
          if (cancellation?.aborted) throw fail('Destination verification cancelled.');
          if (guard() !== true || !session.connected) throw Object.assign(fail('The destination changed during verification.'),
            { verificationReason: 'destination-verification-interrupted' });
        };
        const stop = () => { if (session.connected) db._lose(session, fail('The owned destination verification closed.')); };
        const timeout = setTimeout(stop, timeoutMs);
        timeout.unref?.();
        cancellation?.addEventListener('abort', stop, { once: true });
        try {
          check();
          const identity = await reader._identity(session);
          if (digest(identity) !== destination.identityHash || tableIdentity(identity, destination.table) !== destination.scope) {
            return inconclusive('destination-identity-changed');
          }
          await db._control(session, 'SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');
          await db._control(session, 'START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
          await db._refreshState(session);
          if (!session.inTransaction) return inconclusive('destination-unavailable');
          inconclusiveReason = 'destination-definition-changed';
          const definition = targetDefinition(await db._editor.definition(destination.table));
          if (digest(definition) !== destination.definitionHash) return inconclusive(inconclusiveReason);
          const columns = evidence.columns.map(name => definition.columns.find(column => column.name === name));
          const primary = definition.columns.filter(column => column.primaryKey).map(column => columns.indexOf(column));
          if (!columns.every(Boolean) || !primary.length || primary.includes(-1) || JSON.stringify(primary) !== JSON.stringify(evidence.keys)) {
            return inconclusive(inconclusiveReason);
          }
          const types = columns.map(transferable);
          if (types.some(type => !type)) return inconclusive(inconclusiveReason);
          const { metadataLockSql } = sampleQuery(evidence, columns, types);
          await db._stream(session, metadataLockSql, [], { maxRows: 1, timeoutMs: 5000 }, false);
          if (digest(targetDefinition(await db._editor.definition(destination.table))) !== destination.definitionHash) {
            return inconclusive(inconclusiveReason);
          }
          const result = await inspect({ db, session, columns, types, check, explainFailure(reason) { inconclusiveReason = reason; } });
          check();
          await db._refreshState(session);
          if (!session.inTransaction) return inconclusive('destination-unavailable');
          await db._control(session, 'ROLLBACK');
          check();
          return result;
        } finally {
          clearTimeout(timeout);
          cancellation?.removeEventListener('abort', stop);
        }
      }).finally(() => reader.dispose());
    });
  } catch (error) {
    if (cancellation?.aborted) throw fail('Destination verification cancelled.');
    if (guardedFailures.has(error?.verificationReason)) return inconclusive(error.verificationReason, error.snapshotCheck);
    return inconclusive(inconclusiveReason);
  }
}

function statusOf(counts) {
  return counts.mismatch ? 'mismatch' : counts.missing ? 'missing' : 'matching';
}

async function verifyCommitEvidence(evidence, config) {
  if (config.cancellation?.aborted) throw fail('Destination verification cancelled.');
  if (!evidenceShape(evidence)) return observation(undefined, { reason: 'missing-review-evidence' });
  if (!evidence.samples.length) return observation(evidence, { reason: evidence.reason === 'primary-key-not-mapped' ? evidence.reason : 'no-bounded-keys' });
  const inconclusive = reason => observation(evidence, { reason });
  return readReviewedDestination(evidence, config, async ({ db, session, columns, types, check, explainFailure }) => {
    explainFailure('sample-unreadable');
    const { headers, sql } = sampleQuery(evidence, columns, types);
    const counts = { matching: 0, missing: 0, mismatch: 0 };
    for (const sample of evidence.samples) {
      check();
      const result = await db._stream(session, sql, keyParameters(evidence, columns, types, sample.key), { maxRows: 2, timeoutMs: 5000 }, false);
      const row = result.rows[0];
      if (result.truncated || result.rows.length > 1 || JSON.stringify(result.columns) !== JSON.stringify(headers) ||
          row && (row.length !== headers.length || String(row.at(-1)) !== '0')) return inconclusive('sample-unreadable');
      if (!row) counts.missing++;
      else if (digest(types.map((type, at) => canonicalValue(row[at], type))) === sample.hash) counts.matching++;
      else counts.mismatch++;
    }
    return observation(evidence, { status: statusOf(counts), counts });
  }, inconclusive);
}

function fullObservation(evidence, { status = 'inconclusive', reason, counts, pages = 0 } = {}) {
  const result = observation(evidence, { status, reason, counts });
  return { ...result, method: 'full-mapped-keys', sampledKeys: 0, keyLimit: result.rows, pages };
}

function fullPageQuery(evidence, columns, types) {
  const field = name => 'rb_destination.' + quote(name);
  const { fields, headers } = boundedProjection(columns, field);
  let ordinal = '__rb_verified_ordinal';
  while (headers.some(name => name.toLowerCase() === ordinal)) ordinal += '_';
  const where = evidence.keys.map(i => 'rb_lookup.' + quote(columns[i].name) + ' = ' + placeholder(types[i])).join(' AND ');
  const table = quote(evidence.destination.database, true) + '.' + quote(evidence.destination.table, true);
  const projection = columns.map(column => 'rb_lookup.' + quote(column.name)).join(', ');
  const branch = index => 'SELECT ' + index + ' AS ' + quote(ordinal) + ', ' + projection +
    ' FROM ' + table + ' AS rb_lookup WHERE ' + where + ' LIMIT 2';
  return {
    columns: [ordinal, ...headers],
    sql: count => 'SELECT ' + quote(ordinal) + ', ' + fields + ' FROM (' + (count === 1 ? branch(0) :
      Array.from({ length: count }, (_, index) => '(' + branch(index) + ')').join(' UNION ALL ')) + ') AS rb_destination'
  };
}

async function inspectPage(db, session, query, values, page, types, check) {
  const stream = session.connection.execute({ sql: query.sql(page.length), values, rowsAsArray: true }).stream({ highWaterMark: 1 });
  const active = { mayWrite: false, abort: error => stream.destroy(error) };
  session.active = active;
  const timer = setTimeout(() => {
    if (session.connected) db._lose(session, fail('The destination page exceeded its read time.'));
  }, 15000);
  timer.unref?.();
  let fieldsValid = false, fieldsSeen = false;
  const seen = new Set(), counts = { matching: 0, missing: page.length, mismatch: 0 };
  stream.on('fields', fields => {
    fieldsValid = !fieldsSeen && fields.length === query.columns.length &&
      fields.every((field, index) => field.name === query.columns[index]);
    fieldsSeen = true;
  });
  try {
    for await (const row of stream) {
      check();
      const ordinal = Number(row?.[0]);
      if (!fieldsValid || !Array.isArray(row) || row[0] == null || row.length !== query.columns.length ||
          !Number.isInteger(ordinal) || ordinal < 0 || ordinal >= page.length || seen.has(ordinal) ||
          String(row.at(-1)) !== '0') throw fail('A destination page did not match the exact reviewed keys.');
      seen.add(ordinal);
      counts.missing--;
      const actual = digest(types.map((type, at) => canonicalValue(row[at + 1], type)));
      counts[actual === page[ordinal].hash ? 'matching' : 'mismatch']++;
    }
    check();
    if (!fieldsValid) throw fail('The destination page changed during comparison.');
  } finally {
    clearTimeout(timer);
    if (session.active === active) session.active = null;
    stream.destroy();
  }
  const warnings = await db._stream(session, 'SHOW WARNINGS', [], { maxRows: 1, timeoutMs: 5000 }, false);
  if (warnings.truncated || warnings.rows.length) throw fail('The destination page returned server warnings.');
  return counts;
}

async function verifyAllCommitKeys(source, config, onProgress) {
  if (config.cancellation?.aborted) throw fail('Destination verification cancelled.');
  const { evidence } = source;
  const known = evidenceShape(evidence) ? evidence : undefined;
  const inconclusive = (reason, check) => ({ ...fullObservation(known, { reason }), ...(check && { snapshotCheck: check }) });
  if (known?.version !== 3) return inconclusive('full-evidence-unavailable');
  if (!known.keys.length || known.keys.includes(-1)) return inconclusive('primary-key-not-mapped');
  const mapped = known.sourceColumns;
  if (!Array.isArray(mapped) || mapped.length !== known.columns.length || mapped.length !== new Set(mapped).size ||
      mapped.some(index => !Number.isInteger(index) || index < 0 || index >= source.columns.length)) {
    return inconclusive('full-evidence-unavailable');
  }
  await onProgress?.({ stage: 'inspect-destination', rows: known.rowCount, checkedKeys: 0, pages: 0 });
  if (config.cancellation?.aborted) throw fail('Destination verification cancelled.');
  const result = await readReviewedDestination(known, config, async ({ db, session, columns, types, check, explainFailure }) => {
    const query = fullPageQuery(known, columns, types);
    const counts = { matching: 0, missing: 0, mismatch: 0 };
    let pages = 0, checkedKeys = 0, page = [];
    const inspect = async () => {
      check();
      if (Date.now() >= source.expiresAt) throw fail('The saved source snapshot expired.');
      explainFailure('full-page-unreadable');
      const values = page.flatMap(item => keyParameters(known, columns, types, item.key));
      const observed = await inspectPage(db, session, query, values, page, types, check);
      for (const key of Object.keys(counts)) counts[key] += observed[key];
      checkedKeys += page.length;
      pages++;
      page = [];
      await onProgress?.({ stage: 'compare-page', rows: known.rowCount, checkedKeys, pages });
      explainFailure('retained-snapshot-unavailable');
      check();
    };
    explainFailure('retained-snapshot-unavailable');
    const sealed = await source.scan({ cancellation: config.cancellation, async onRow(row) {
      check();
      const values = mapped.map((index, at) => canonicalValue(row[index], types[at]));
      const key = known.keys.map(at => values[at]);
      if (key.includes(null)) throw fail('A mapped primary key was unavailable.');
      page.push({ key, hash: digest(values) });
      if (page.length === fullPageSize) await inspect();
    } });
    if (page.length) await inspect();
    if (sealed.rowCount !== known.rowCount || sealed.sourceHash !== known.sourceHash || checkedKeys !== known.rowCount) {
      return inconclusive('retained-snapshot-authentication-failed', { phase: 'row-digest' });
    }
    explainFailure('retained-evidence-changed');
    await source.assertCurrent();
    return fullObservation(known, { status: statusOf(counts), counts, pages });
  }, inconclusive, fullVerificationTimeoutMs);
  if (result.coverage === 'all-reviewed-keys') await onProgress?.({
    stage: 'complete', rows: result.rows, checkedKeys: result.checkedKeys, pages: result.pages
  });
  return result;
}

async function prepareRecoveryStatements(source, config, observation) {
  const { evidence } = source;
  if (!evidenceShape(evidence) || evidence.version !== 3 || evidence.keys.includes(-1) ||
      evidence.rowCount !== observation.rows || evidence.columns.length !== observation.comparedMappedColumns) {
    throw fail('The retained source does not match the complete verification observation.');
  }
  const review = await readReviewedDestination(evidence, config, async ({ columns, types, check }) => {
    await source.assertCurrent();
    check();
    const mapped = columns.map((_, index) => index);
    const { keys } = evidence;
    const updates = mapped.filter(index => !keys.includes(index));
    const field = index => quote(columns[index].name);
    const bind = (index, value) => ({ column: columns[index].name, type: columns[index].type, value });
    const binds = (indices, value) => indices.map(index => bind(index, value));
    const keyMatch = keys.map(index => field(index) + ' = ' + placeholder(types[index])).join(' AND ');
    const table = quote(evidence.destination.database, true) + '.' + quote(evidence.destination.table, true);
    const { sql, headers } = sampleQuery(evidence, columns, types);
    const statements = [{
      kind: 'audit-key',
      sql: sql + ';',
      parameters: binds(keys, 'reviewed-key'),
      overflowFlag: headers.at(-1)
    }];
    if (observation.missing > 0) {
      const existing = index => 'rb_existing.' + field(index);
      const join = keys.map(index => existing(index) + ' = ' + placeholder(types[index])).join(' AND ');
      statements.push({
        kind: 'insert-missing-key',
        sql: 'INSERT INTO ' + table + ' (' + mapped.map(field).join(', ') + ') SELECT ' + types.map(placeholder).join(', ') +
          ' FROM (SELECT 1 AS marker) AS rb_single LEFT JOIN ' + table + ' AS rb_existing ON ' + join +
          ' WHERE ' + existing(keys[0]) + ' IS NULL;',
        parameters: [...mapped.map(index => bind(index, keys.includes(index) ? 'reviewed-key' : 'desired-value')),
          ...binds(keys, 'reviewed-key')]
      });
    }
    if (observation.mismatch > 0 && updates.length) {
      const exactBytes = index => ['text', 'binary'].includes(types[index].category) || types[index].kind === 'json';
      const guarded = mapped.filter(index => !keys.includes(index) || exactBytes(index));
      const guards = guarded.map(index => exactBytes(index)
        ? 'CAST(' + field(index) + ' AS BINARY) <=> CAST(? AS BINARY)'
        : field(index) + ' <=> ' + placeholder(types[index]));
      statements.push({
        kind: 'update-unchanged-key',
        sql: 'UPDATE ' + table + ' SET ' + updates.map(index => field(index) + ' = ' + placeholder(types[index])).join(', ') +
          ' WHERE ' + [keyMatch, ...guards].join(' AND ') + ' LIMIT 1;',
        parameters: [...binds(updates, 'desired-value'), ...binds(keys, 'reviewed-key'), ...binds(guarded, 'observed-value')]
      });
    }
    return { destination: destinationSummary(evidence), statements };
  }, reason => ({ failure: reason }));
  if (review.failure) throw fail('The reviewed destination or retained source could not be revalidated (' + review.failure + ').');
  return review;
}

module.exports = {
  createCommitEvidence, destinationSummary, sampleLimit, verifyCommitEvidence, verifyAllCommitKeys, prepareRecoveryStatements,
  exactBitParameter
};
