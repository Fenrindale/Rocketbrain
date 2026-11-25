'use strict';

const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');

const MAX_ENTRIES = 400;
const MAX_BACKGROUND = 100;
const categories = Object.freeze({ query: 'SQL console', script: 'SQL script', procedure: 'Stored procedure', metadata: 'Metadata',
  schema: 'Schema DDL', authorization: 'Accounts and privileges', session: 'Session controls', transfer: 'Table transfer', driver: 'Driver requests' });
const statuses = Object.freeze({ running: 'Running', succeeded: 'Succeeded', failed: 'Failed',
  cancelled: 'Cancelled', timeout: 'Timed out', limited: 'Result limit', interrupted: 'Outcome unavailable after restart' });
const operations = new Set(['SELECT', 'WITH', 'EXPLAIN', 'ANALYZE', 'SHOW', 'DESCRIBE', 'DESC', 'INSERT', 'UPDATE', 'DELETE',
  'REPLACE', 'CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'RENAME', 'SET', 'CALL', 'GRANT', 'REVOKE', 'START', 'BEGIN',
  'COMMIT', 'ROLLBACK', 'LOCK', 'UNLOCK', 'SAVEPOINT', 'RELEASE', 'USE', 'DO', 'KILL', 'XA']);
const controls = new Set(['SET', 'START', 'BEGIN', 'COMMIT', 'ROLLBACK', 'LOCK', 'UNLOCK', 'SAVEPOINT', 'RELEASE', 'USE', 'DO', 'KILL', 'XA']);
const ddl = new Set(['CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'RENAME']);
const metadata = new Set(['SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'ANALYZE']);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

function operationOf(sql) {
  const first = typeof sql === 'string' ? /^\s*([A-Za-z]+)\b/.exec(sql)?.[1]?.toUpperCase() : undefined;
  return operations.has(first) ? first : 'SQL';
}

function driverActivity(sql) {
  const operation = operationOf(sql);
  if (['GRANT', 'REVOKE'].includes(operation) ||
      /^\s*(?:(?:CREATE|ALTER|DROP|RENAME)\s+(?:OR\s+REPLACE\s+)?(?:USER|ROLE)\b|SET\s+(?:DEFAULT\s+)?ROLE\b)/iu.test(sql)) {
    return { category: 'authorization', operation };
  }
  const category = ddl.has(operation) ? 'schema' : controls.has(operation) ? 'session'
    : metadata.has(operation) || /^\s*SELECT\b[\s\S]*?\bFROM\s+information_schema\./iu.test(sql) ? 'metadata'
    : operation === 'CALL' ? 'procedure' : 'driver';
  return { category, operation };
}

function outcomeOf(code, truncated = false) {
  if (truncated || ['ROCKETBRAIN_RESULT_LIMIT', 'ROCKETBRAIN_ROUTINE_RESULT_LIMIT'].includes(code)) return 'limited';
  if (['ROCKETBRAIN_CANCELLED', 'ROCKETBRAIN_ROUTINE_CANCELLED'].includes(code)) return 'cancelled';
  if (['ROCKETBRAIN_TIMEOUT', 'ROCKETBRAIN_ROUTINE_TIMEOUT', 'ER_QUERY_TIMEOUT', 'ER_STATEMENT_TIMEOUT'].includes(code)) return 'timeout';
  return code ? 'failed' : 'succeeded';
}

function storedHistory(value) {
  const entries = [];
  const keys = new Set();
  if (value?.version !== 1 || !Array.isArray(value.entries) || value.entries.length > MAX_ENTRIES) return { entries, dropped: 0 };
  for (const row of value.entries) {
    if (!row || ![row.id, row.connection, row.session].every(id => typeof id === 'string' && uuid.test(id)) || keys.has(row.id) ||
        !Object.hasOwn(categories, row.category) || !(operations.has(row.operation) || row.operation === 'SQL') ||
        !Object.hasOwn(statuses, row.status) || typeof row.startedAt !== 'string' ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(row.startedAt) || !Number.isFinite(Date.parse(row.startedAt)) ||
        (['running', 'interrupted'].includes(row.status) ? row.durationMs !== null :
          !Number.isFinite(row.durationMs) || row.durationMs < 0 || row.durationMs > Number.MAX_SAFE_INTEGER)) continue;
    keys.add(row.id);
    entries.push({ id: row.id, connection: row.connection, session: row.session, category: row.category, operation: row.operation,
      status: row.status === 'running' ? 'interrupted' : row.status, startedAt: row.startedAt, durationMs: row.durationMs });
  }
  return { entries: entries.reverse(), dropped: Number.isSafeInteger(value.dropped) && value.dropped >= 0 ? value.dropped : 0 };
}

const background = row => row.category === 'metadata' || row.category === 'driver' && row.operation === 'SELECT' ||
  row.category === 'session' && row.operation === 'DO';

function createActivityLog({ enabled = false, canRecord = () => true, onChange = () => {}, history } = {}) {
  const activeAtStart = enabled === true;
  const known = storedHistory(activeAtStart ? history : undefined);
  const entries = known.entries;
  let dropped = known.dropped, disposed = false, generation = 0, active = activeAtStart;
  let backgroundCount = entries.filter(background).length;
  function reset() { generation++; entries.length = 0; dropped = 0; backgroundCount = 0; }
  function append(entry) {
    const incidental = background(entry);
    if (entries.length >= MAX_ENTRIES || incidental && backgroundCount >= MAX_BACKGROUND) {
      const oldestBackground = entries.findIndex(background);
      dropped = Math.min(dropped + 1, Number.MAX_SAFE_INTEGER);
      if (incidental && oldestBackground < 0) return false;
      if (oldestBackground >= 0) backgroundCount--;
      entries.splice(Math.max(0, oldestBackground), 1);
    }
    if (incidental) backgroundCount++;
    entries.push(entry);
    return true;
  }
  function changed() { try { onChange(); } catch { /* SQL dispatch is independent from the log view. */ } }
  function setEnabled(value) {
    if (disposed || active === value) return;
    active = value === true;
    if (!active) reset();
    changed();
  }
  function snapshot() {
    const available = !disposed && canRecord();
    return { enabled: available && active, available, limit: MAX_ENTRIES, dropped: available ? dropped : 0,
      entries: available ? entries.map(entry => ({ ...entry })).reverse() : [] };
  }
  function createReporter() {
    const connection = randomUUID(), sessions = new WeakMap();
    return (session, hint) => {
      if (disposed || !active || !canRecord() || !Object.hasOwn(categories, hint?.category)) return undefined;
      let sessionId = sessions.get(session);
      if (!sessionId) { sessionId = randomUUID(); sessions.set(session, sessionId); }
      const ticket = generation, started = performance.now();
      const entry = { id: randomUUID(), connection, session: sessionId, category: hint.category,
        operation: operations.has(hint.operation) ? hint.operation : 'SQL', status: 'running', startedAt: new Date().toISOString(), durationMs: null };
      const retained = append(entry);
      changed();
      if (!retained) return undefined;
      return status => {
        if (!active || !canRecord() || disposed || ticket !== generation || entry.status !== 'running' ||
            !Object.hasOwn(statuses, status) || ['running', 'interrupted'].includes(status)) return;
        entry.status = status;
        entry.durationMs = Math.round((performance.now() - started) * 100) / 100;
        changed();
      };
    };
  }
  return { createReporter, snapshot, setEnabled, clear() { reset(); changed(); }, dispose() { disposed = true; reset(); } };
}

module.exports = { createActivityLog, operationOf, outcomeOf, driverActivity, categories, statuses };
