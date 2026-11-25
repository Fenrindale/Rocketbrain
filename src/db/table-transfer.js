'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { SchemaRenamer, identifier } = require('./schema-rename');
const { canonicalValue, describeType } = require('./schema-conversion');
const { StreamImporter, newSession, LIMITS: IMPORT_LIMITS } = require('./import-stream');
const { readSnapshot, streamLimits } = require('./table-transfer-snapshot');
const { recoveryLifetimeMs } = require('./table-transfer-recovery');
const { createCommitEvidence, verifyCommitEvidence, verifyAllCommitKeys, prepareRecoveryStatements,
  exactBitParameter } = require('./table-transfer-verification');

const limits = Object.freeze({ rows: 500, columns: 64, bytes: 1024 * 1024, entries: 4, durationMs: 10 * 60 * 1000 });
const fail = message => Object.assign(new Error(message), { code: 'ROCKETBRAIN_TABLE_TRANSFER' });
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const quote = name => '`' + identifier(name, { table: true }).replaceAll('`', '``') + '`';
const publicColumn = ({ name, type, nullable, primaryKey, insertable, required }) => ({ name, type, nullable, primaryKey, insertable, required });
const cancelled = token => token?.isCancellationRequested || token?.aborted;
const exactDeclaration = type => ['enum', 'set', 'binary'].includes(type.kind);

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
  // TIMESTAMP, floating values and CHAR padding require separate transfer rules.
  if (['integer', 'decimal', 'date', 'datetime', 'time', 'json', 'year', 'bit'].includes(type.kind) || type.category === 'binary') return type;
  if (['enum', 'set'].includes(type.kind)) return type.charset === 'utf8mb4' && !type.members.includes('') ? type : null;
  if (type.category === 'text' && type.charset === 'utf8mb4' && /^(?:varchar|(?:tiny|medium|long)?text)$/.test(type.kind)) return type;
  return null;
}

function useValue(value, column) {
  const type = transferable(column);
  if (!type) throw fail('Unsupported transfer column ' + column.name + '.');
  return canonicalValue(value, type);
}

function mappedTypes(columns, selected) {
  return selected.map(({ source: index, column }) => {
    const origin = columns[index], from = transferable(origin), into = transferable(column);
    if (!from || !into || (exactDeclaration(from) || exactDeclaration(into)) && (from.kind !== into.kind || from.type !== into.type) ||
        from.kind !== into.kind && !(from.category === into.category && ['text', 'binary'].includes(from.category))) {
      throw fail('Map compatible exact types for ' + origin.name + ' and ' + column.name + '.');
    }
    return { index, column, from, into };
  });
}

function assertMappedRow(row, rowIndex, types) {
  for (const { index, column, from, into } of types) {
    const value = row[index];
    let fromValue, toValue;
    try { fromValue = canonicalValue(value, from); toValue = canonicalValue(value, into); }
    catch { throw fail('Captured row ' + (rowIndex + 1) + ' cannot enter ' + column.name + ' without conversion.'); }
    if (fromValue !== toValue) throw fail('Captured row ' + (rowIndex + 1) + ' would change value in ' + column.name + '.');
  }
}

function assertMappedValues(source, selected) {
  const types = mappedTypes(source.columns, selected);
  for (const [rowIndex, row] of source.rows.entries()) assertMappedRow(row, rowIndex, types);
}

function tableIdentity(identity, table) {
  const fold = value => identity.tableNameCaseSensitive ? value : value.toLowerCase();
  return digest([identity.dialect, identity.serverUniqueId, fold(identity.database), fold(table)]);
}

function bounded(map, remove = id => map.delete(id)) {
  for (const [id, entry] of map) if (entry.expiresAt <= Date.now()) remove(id);
  while (map.size >= limits.entries) remove(map.keys().next().value);
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

async function captureTable(lease, table, { id, mode, cancellation, onProgress, directory }) {
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
      const verify = async () => {
        const after = await db._editor.definition(table);
        if (digest(definition) !== digest(after) || digest(identity) !== digest(await reader._identity(session))) {
          throw fail('The source definition or server context changed during capture.');
        }
      };
      const types = columns.map(transferable);
      const serializeRow = row => row.map((value, index) => {
        if (value === null) return null;
        if (types[index].kind === 'bit') {
          const hex = BigInt(canonicalValue(value, types[index])).toString(16);
          return '0x' + hex.padStart(hex.length + hex.length % 2, '0');
        }
        const serialized = Buffer.isBuffer(value) ? '0x' + value.toString('hex') : String(value);
        useValue(serialized, columns[index]);
        return serialized;
      });
      const metadata = { id, database: identity.database, table, scope: tableIdentity(identity, table),
        engine: identity.dialect, columns, omittedColumns: definition.columns.length - columns.length };
      if (mode === 'stream') {
        const snapshot = await readSnapshot({ db, session, schema: identity.database, table, columns, keys, cancellation, onProgress,
          check: () => leaseGuard(lease, cancellation), serializeRow, verify, directory });
        return { ...metadata, expiresAt: Date.now() + (directory ? recoveryLifetimeMs : streamLimits.lifetimeMs), ...snapshot,
          ...(directory && { recoveryState: 'ready' }) };
      }
      const sql = 'SELECT ' + columns.map(column => quote(column.name)).join(',') + ' FROM ' +
        quote(identity.database) + '.' + quote(table) + ' ORDER BY ' + keys.map(column => quote(column.name)).join(',') +
        ' LIMIT ' + (limits.rows + 1);
      const result = await db._stream(session, sql, [], { maxRows: limits.rows + 1, timeoutMs: IMPORT_LIMITS.statementTimeoutMs }, false);
      leaseGuard(lease, cancellation);
      if (result.truncated || result.rows.length > limits.rows) throw fail('Capture at most 500 source rows or the 1 MiB transfer limit.');
      if (!result.rows.length) throw fail('The selected source has no rows.');
      if (JSON.stringify(result.columns) !== JSON.stringify(columns.map(column => column.name))) throw fail('The source projection changed during capture.');
      const rows = result.rows.map(serializeRow);
      if (Buffer.byteLength(JSON.stringify(rows)) > limits.bytes) throw fail('The captured rows exceed 1 MiB.');
      await verify();
      leaseGuard(lease, cancellation);
      return { ...metadata, expiresAt: Date.now() + limits.durationMs, rows, rowCount: rows.length, sourceHash: digest({ columns, rows }) };
    });
  } finally { reader.dispose(); }
}

function returnCapture(capture) {
  const { id, expiresAt, database, table, scope, engine, rowCount, omittedColumns, sourceHash, recoveryState,
    verificationTarget, fullVerificationAvailable } = capture;
  return { id, expiresAt, database, table, scope, engine, rowCount, omittedColumns, sourceHash, columns: capture.columns.map(publicColumn),
    ...((capture.spool || recoveryState) && { mode: 'stream', encryptedBytes: capture.bytes, maxFrameBytes: capture.maxFrameBytes, maxBufferedRows: capture.maxBufferedRows }),
    ...(recoveryState && { recoveryState }), ...(verificationTarget && { verificationTarget }),
    ...(fullVerificationAvailable && { fullVerificationAvailable }) };
}

function retainedSource(capture, target) {
  let compatibility, sampler;
  const metadata = { width: capture.columns.length, headers: capture.columns.map(column => column.name) };
  return {
    options: () => ({ file: capture.table, format: capture.spool ? 'streamed-table' : 'retained-table' }),
    takeCommitEvidence() {
      const evidence = sampler?.evidence();
      sampler = undefined;
      return evidence;
    },
    placeholder(column) {
      return transferable(column)?.kind === 'bit' ? exactBitParameter : '?';
    },
    bindParameters(values) {
      return values.map((value, index) => {
        const kind = compatibility[index].into.kind;
        if (value === '0' && kind === 'year') return 0;
        if (value !== null && kind === 'bit') return canonicalValue(value, compatibility[index].into);
        return value;
      });
    },
    async scan(options, callbacks) {
      if (capture.expiresAt <= Date.now()) throw fail('The source snapshot expired. Capture the source table again.');
      const identity = { snapshotId: capture.id, scope: capture.scope, ...(capture.spool && { encrypted: capture.identity }) };
      const state = { ...metadata, fileIdentity: identity, fileHash: capture.sourceHash, dataHash: capture.sourceHash,
        rowCount: capture.rowCount, format: options.format, preview: [] };
      const start = async () => {
        await callbacks.onStart?.(state);
        await callbacks.onMetadata?.(metadata);
      };
      const rowData = values => ({ values, nulls: values.map(value => value === null) });
      if (capture.spool) {
        await capture.spool.scan({ cancellation: callbacks.cancellation, onStart: start, async onRow(row, index) {
          assertMappedRow(row, index, compatibility);
          sampler?.observe(row, index);
          await callbacks.onRow?.(rowData(row));
        } });
        return state;
      }
      await start();
      for (const row of capture.rows) {
        if (cancelled(callbacks.cancellation)) throw fail('Table copy cancelled.');
        await callbacks.onRow?.(rowData(row));
      }
      return state;
    },
    validateSelection({ selected, definition }) {
      if (digest(definition) !== target.definitionHash) throw fail('The destination definition changed. Choose the destination again.');
      compatibility = mappedTypes(capture.columns, selected);
      if (capture.recoveryState) {
        const { identityHash, definitionHash, scope, database, table, engine } = target;
        sampler = createCommitEvidence({ destination: { identityHash, definitionHash, scope, database, table, engine },
          capture, definition, selected: compatibility });
      }
      if (!capture.spool) for (const [index, row] of capture.rows.entries()) assertMappedRow(row, index, compatibility);
    },
    validateTarget({ identity, definition }) {
      const scope = tableIdentity(identity, definition.name);
      if (scope === capture.scope) throw fail('Choose a different destination table.');
      if (scope !== target.scope || digest(identity) !== target.identityHash) throw fail('The destination connection changed. Inspect it again.');
    }
  };
}

function createTableTransfer(database, { recovery, history, runs } = {}) {
  const captures = new Map(), targets = new Map(), reviews = new Map(), operations = new Set(), controllers = new Set(), removals = new Set();
  const verificationReviews = new Map(), recoveryPlans = new Map(), recoverySqlReviews = new Map();
  let pending, writingCapture, closed = false;
  const tracked = (action, abortable = false) => (...args) => {
    if (closed) return Promise.reject(fail('Table copy is closed.'));
    let controller, subscription;
    if (abortable) {
      const input = args[0] || {}, token = input.cancellation;
      controller = new AbortController();
      controllers.add(controller);
      const cancel = () => controller.abort();
      if (cancelled(token)) cancel();
      if (token?.onCancellationRequested) subscription = token.onCancellationRequested(cancel);
      else if (token?.addEventListener) {
        token.addEventListener('abort', cancel, { once: true });
        subscription = { dispose: () => token.removeEventListener('abort', cancel) };
      }
      args[0] = { ...input, cancellation: controller.signal };
    }
    const work = action(...args);
    operations.add(work);
    void work.finally(() => {
      subscription?.dispose();
      if (controller) controllers.delete(controller);
      operations.delete(work);
    }).catch(() => {});
    return work;
  };
  const discardSource = id => {
    const capture = captures.get(id);
    if (!capture) return false;
    captures.delete(id);
    clearTimeout(capture.expiryTimer);
    if (capture.spool) {
      const cleanup = capture.spool.dispose();
      removals.add(cleanup);
      void cleanup.finally(() => removals.delete(cleanup)).catch(() => {});
    }
    return true;
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

  const getRecovery = () => {
    if (!recovery) throw fail('Saved snapshots require storage in a trusted workspace.');
    return recovery;
  };
  const remember = capture => {
    discardSource(capture.id);
    bounded(captures, discardSource);
    capture.expiryTimer = setTimeout(() => discardSource(capture.id), Math.max(0, capture.expiresAt - Date.now()));
    capture.expiryTimer.unref?.();
    captures.set(capture.id, capture);
    return returnCapture(capture);
  };
  const confirmReady = capture => capture.recoveryState ? getRecovery().assertReady(capture.id) : undefined;

  async function recordVerification(captureId, result) {
    let entry;
    try { entry = await history?.append(captureId, result); }
    catch { /* A completed read-only result stays available even when history cannot be written. */ }
    return { ...result, historyRecorded: Boolean(entry) };
  }

  function verificationContext(cancellation) {
    return { withTableTransfer: database.withTableTransfer, cancellation, transferable, targetDefinition, tableIdentity };
  }

  async function recoveryPlanEvidence(captureId) {
    if (!history) throw fail('Recovery previews require a trusted workspace with verification history.');
    const observed = await history.latestEvidence(captureId);
    const snapshot = await recovery?.describeUncertainSource(captureId);
    const snapshotState = snapshot ? { retained: true, fullVerificationAvailable: Boolean(snapshot.fullVerificationAvailable),
      expiresAt: snapshot.expiresAt } : { retained: false, fullVerificationAvailable: false };
    const { observation } = observed;
    const steps = [];
    if (observation.coverage !== 'all-reviewed-keys' && snapshotState.fullVerificationAvailable) steps.push('verify-all-keys');
    if (observation.status === 'inconclusive') steps.push('recheck-destination');
    if (observation.missing > 0) steps.push('investigate-missing-keys');
    if (observation.mismatch > 0) steps.push('investigate-different-values');
    if (!observation.review) steps.push('review-observation');
    steps.push('confirm-transaction-externally', 'retain-replay-fence');
    return { revision: digest([observed.revision, snapshotState]), preview: {
      captureId, observation, snapshot: snapshotState, steps, replayBlocked: true,
      historicalCommitConfirmed: false, executable: false
    } };
  }

  async function recoverySqlEvidence(captureId, cancellation, expectedRevision) {
    if (!history) throw fail('Recovery SQL review requires a trusted workspace with verification history.');
    const { revision, observation } = await history.latestEvidence(captureId);
    if (expectedRevision && revision !== expectedRevision) {
      throw fail('Verification evidence changed. Open a new recovery SQL review.');
    }
    if (observation.method !== 'full-mapped-keys' || observation.coverage !== 'all-reviewed-keys' ||
        observation.review?.decision !== 'follow-up-required' || !(observation.missing || observation.mismatch)) {
      throw fail('Verify all destination keys and mark the latest discrepancy for follow-up.');
    }
    const source = await getRecovery().inspectUncertainSource(captureId);
    const preview = await prepareRecoveryStatements(source, verificationContext(cancellation), observation);
    if ((await history.latestEvidence(captureId)).revision !== revision) {
      throw fail('Verification evidence changed. Open a new recovery SQL review.');
    }
    await source.assertCurrent();
    if (cancelled(cancellation)) throw fail('Recovery SQL review cancelled.');
    return { revision, sourceExpiresAt: source.expiresAt, preview: { captureId, observation, ...preview,
      replayBlocked: true, historicalCommitConfirmed: false, executable: false } };
  }

  const api = {
    capture: tracked(async ({ table, mode = 'captured', recoverable = false, cancellation, onProgress } = {}) => database.withTableTransfer(async lease => {
      if (!['captured', 'stream'].includes(mode)) throw fail('Choose a captured or streamed source snapshot.');
      if (typeof recoverable !== 'boolean' || recoverable && mode !== 'stream') throw fail('Only streamed snapshots can be saved across restarts.');
      const id = randomUUID();
      const directory = recoverable ? await getRecovery().reserve(id) : undefined;
      let capture;
      try {
        capture = await captureTable(lease, table, { id, mode, cancellation, onProgress, directory });
        leaseGuard(lease, cancellation);
        if (recoverable) await recovery.save(capture);
        leaseGuard(lease, cancellation);
        return remember(capture);
      } catch (error) {
        await capture?.spool?.dispose();
        if (directory) await recovery.discard(id, { skipTrust: true }).catch(() => {});
        throw error;
      }
    }), true),
    listSources: () => [...captures.values()].filter(capture => capture.expiresAt > Date.now()).map(returnCapture),
    discardSource,
    canRecover: Boolean(recovery),
    listRecoverableSources: tracked(async () => (await getRecovery().list()).map(returnCapture)),
    resumeSource: tracked(async ({ captureId, cancellation } = {}) => {
      if (writingCapture === captureId || pending?.captureId === captureId) throw fail('Finish the pending table copy before reopening its source.');
      const capture = await getRecovery().resume(captureId);
      try {
        await capture.spool.scan({ cancellation });
        await confirmReady(capture);
        if (writingCapture === captureId || pending?.captureId === captureId) throw fail('Finish the pending table copy before reopening its source.');
        if (captures.has(captureId)) {
          await capture.spool.dispose();
          return returnCapture(retained(captures, captureId, 'source snapshot'));
        }
        return remember(capture);
      } catch (error) { await capture.spool.dispose(); throw error; }
    }, true),
    discardRecoverableSource: tracked(async ({ captureId } = {}) => {
      if (writingCapture === captureId || pending?.captureId === captureId) throw fail('Finish the pending table copy before discarding its source.');
      discardSource(captureId);
      return getRecovery().discard(captureId);
    }),
    verifyUncertainCommit: tracked(async ({ captureId, cancellation } = {}) => {
      const evidence = await getRecovery().uncertainCommit(captureId);
      const result = await verifyCommitEvidence(evidence, verificationContext(cancellation));
      return recordVerification(captureId, result);
    }, true),
    verifyAllTransferKeys: tracked(async ({ captureId, cancellation, onProgress } = {}) => {
      const source = await getRecovery().inspectUncertainSource(captureId);
      const run = await runs?.begin(captureId, source.evidence?.rowCount).catch(() => undefined);
      try {
        const result = await verifyAllCommitKeys(source, verificationContext(cancellation), async progress => {
          await run?.checkpoint(progress).catch(() => {});
          await onProgress?.(progress);
        });
        const report = await recordVerification(captureId, result);
        const runRecorded = Boolean(await run?.finish(result.coverage === 'all-reviewed-keys' ? 'complete' : 'inconclusive')
          .then(() => true, () => false));
        return { ...report, runRecorded };
      } catch (error) {
        await run?.finish(cancelled(cancellation) ? 'cancelled' : 'failed').catch(() => {});
        throw error;
      }
    }, true),
    listTransferVerificationRuns: tracked(async ({ captureId } = {}) => runs ? runs.list(captureId) : []),
    listTransferVerificationHistory: tracked(async ({ captureId } = {}) => history ? history.list(captureId) : []),
    listTransferVerificationEvidence: tracked(async ({ captureId } = {}) => history ? history.evidence(captureId) : []),
    prepareTransferVerificationReview: tracked(async ({ captureId } = {}) => {
      if (!history) throw fail('Verification reviews require storage in a trusted workspace.');
      const { observation, revision } = await history.currentReview(captureId);
      const reviewId = randomUUID(), expiresAt = Date.now() + limits.durationMs;
      bounded(verificationReviews);
      verificationReviews.set(reviewId, { captureId, revision, expiresAt });
      return { reviewId, expiresAt, observation };
    }),
    recordTransferVerificationReview: tracked(async ({ reviewId, decision } = {}) => {
      const review = retained(verificationReviews, reviewId, 'verification review');
      verificationReviews.delete(reviewId);
      return history.recordReview(review.captureId, review.revision, decision);
    }),
    prepareTransferRecoveryPlan: tracked(async ({ captureId } = {}) => {
      const { revision, preview } = await recoveryPlanEvidence(captureId);
      const planId = randomUUID(), expiresAt = Date.now() + limits.durationMs;
      bounded(recoveryPlans);
      recoveryPlans.set(planId, { captureId, revision, expiresAt });
      return { planId, expiresAt, ...preview };
    }),
    validateTransferRecoveryPlan: tracked(async ({ planId } = {}) => {
      const existing = retained(recoveryPlans, planId, 'recovery preview');
      const { revision, preview } = await recoveryPlanEvidence(existing.captureId);
      if (revision !== existing.revision) {
        recoveryPlans.delete(planId);
        throw fail('Verification evidence or the retained snapshot changed. Open a new recovery preview.');
      }
      return { planId, expiresAt: existing.expiresAt, ...preview };
    }),
    prepareTransferRecoverySql: tracked(async ({ captureId, cancellation } = {}) => {
      const { revision, preview, sourceExpiresAt } = await recoverySqlEvidence(captureId, cancellation);
      const reviewId = randomUUID(), expiresAt = Math.min(Date.now() + limits.durationMs, sourceExpiresAt);
      bounded(recoverySqlReviews);
      recoverySqlReviews.set(reviewId, { captureId, revision, expiresAt });
      return { reviewId, expiresAt, ...preview };
    }, true),
    validateTransferRecoverySql: tracked(async ({ reviewId, cancellation } = {}) => {
      const existing = retained(recoverySqlReviews, reviewId, 'recovery SQL review');
      const { preview } = await recoverySqlEvidence(existing.captureId, cancellation, existing.revision);
      retained(recoverySqlReviews, reviewId, 'recovery SQL review');
      return { reviewId, expiresAt: existing.expiresAt, ...preview };
    }, true),
    inspectDestination: tracked(async ({ captureId, table } = {}) => database.withTableTransfer(async lease => {
      const capture = retained(captures, captureId, 'source snapshot');
      await confirmReady(capture);
      identifier(table, { table: true });
      const definition = targetDefinition(await lease.db._editor.definition(table)), identity = await inspectIdentity(lease.db);
      leaseGuard(lease);
      const scope = tableIdentity(identity, table);
      if (scope === capture.scope) throw fail('Choose a different destination table.');
      const destination = { id: randomUUID(), captureId, db: lease.db, epoch: lease.epoch, scope, table,
        database: identity.database, engine: identity.dialect, definitionHash: digest(definition), identityHash: digest(identity),
        expiresAt: Date.now() + limits.durationMs };
      bounded(targets);
      targets.set(destination.id, destination);
      return { id: destination.id, scope, table, database: identity.database, engine: identity.dialect,
        columns: definition.columns.map(column => ({
          ...publicColumn(column), insertable: column.insertable && Boolean(transferable(column))
        })) };
    })),
    preview: tracked(async ({ captureId, destinationId, mapping, cancellation } = {}) => database.withTableTransfer(async lease => {
      const capture = retained(captures, captureId, 'source snapshot');
      await confirmReady(capture);
      const target = retained(targets, destinationId, 'destination inspection');
      live(lease, target);
      if (target.captureId !== captureId) throw fail('The destination inspection belongs to another source snapshot.');
      if (!Array.isArray(mapping) || mapping.length !== capture.columns.length) throw fail('Map or explicitly ignore each source column.');
      const numeric = mapping.map(item => ({ source: capture.columns.findIndex(col => col.name === item?.source), target: item?.target }));
      const source = retainedSource(capture, target);
      const manager = new StreamImporter(lease.db, { source, onStateChange: value => {
        if (!value && pending?.manager === manager) {
          const { releasePending } = pending;
          pending = undefined;
          releasePending();
        }
      } });
      try {
        const plan = await manager.prepare({ table: target.table, mapping: numeric, guard: lease.guard, cancellation });
        retained(captures, captureId, 'source snapshot');
        const entry = { id: plan.reviewId, expiresAt: Math.min(plan.expiresAt, target.expiresAt, capture.expiresAt),
          db: lease.db, epoch: lease.epoch, manager, captureId, commitEvidence: source.takeCommitEvidence() };
        for (const [id, review] of reviews) if (review.expiresAt <= Date.now() || reviews.size >= limits.entries) {
          reviews.delete(id); await review.manager.dispose();
        }
        reviews.set(entry.id, entry);
        return { reviewId: plan.reviewId, expiresAt: entry.expiresAt, source: returnCapture(capture), destination: { table: plan.table, database: plan.database, scope: target.scope },
          rowCount: plan.rowCount, mapping: structuredClone(mapping), sql: plan.sql, rowsIncluded: false,
          automaticCommit: false, automaticRetry: false };
      } catch (error) { await manager.dispose(); throw error; }
    }), true),
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
      const capture = retained(captures, review.captureId, 'source snapshot');
      await confirmReady(capture);
      reviews.delete(reviewId);
      let wait = false;
      writingCapture = capture.id;
      try {
        const report = await review.manager.run({ reviewId, guard: lease.guard, cancellation, onProgress });
        if (report.state === 'awaiting-commit') {
          pending = { db: lease.db, epoch: lease.epoch, manager: review.manager, releasePending: lease.releasePending, report,
            captureId: capture.id, recoverable: Boolean(capture.recoveryState), commitEvidence: review.commitEvidence };
          wait = true;
        }
        return structuredClone(report);
      } finally { writingCapture = undefined; if (!wait) await review.manager.dispose(); }
    }), true),
    pending: () => pending ? structuredClone(pending.report) : null,
    settle: tracked(async ({ transactionId, commit } = {}) => {
      if (typeof commit !== 'boolean') throw fail('Choose Commit or Roll Back.');
      const selected = pending;
      if (!selected || selected.report.transactionId !== transactionId) throw fail('No matching pending table copy remains.');
      return database.withTableTransfer(async lease => {
        if (commit) live(lease, selected);
        try {
          const beforeCommit = selected.recoverable ? () => recovery.beginCommit(selected.captureId, selected.commitEvidence) : undefined;
          const report = await (commit ? selected.manager.commit({ transactionId, guard: lease.guard, beforeCommit }) : selected.manager.rollback({ transactionId }));
          if (selected.recoverable && report.committed) {
            discardSource(selected.captureId);
            try { await recovery.discard(selected.captureId); }
            catch { report.recoveryCleanupPending = true; }
          } else if (selected.recoverable && commit && report.outcomeUnknown) {
            discardSource(selected.captureId);
            report.recoveryState = 'settlement-unconfirmed';
            report.captureId = selected.captureId;
          }
          return report;
        }
        finally { if (!selected.manager.hasPendingTransaction(transactionId)) await selected.manager.dispose(); }
      }, { settling: true });
    }),
    async dispose() {
      if (closed) return;
      closed = true;
      for (const controller of controllers) controller.abort();
      await Promise.allSettled([...operations]);
      if (pending) await pending.manager.dispose();
      await Promise.allSettled([...reviews.values()].map(review => review.manager.dispose()));
      for (const id of captures.keys()) discardSource(id);
      await Promise.allSettled(removals);
      targets.clear(); reviews.clear(); verificationReviews.clear(); recoveryPlans.clear(); recoverySqlReviews.clear();
    }
  };
  return api;
}

module.exports = { createTableTransfer, transferable, assertMappedValues, tableIdentity, limits };
