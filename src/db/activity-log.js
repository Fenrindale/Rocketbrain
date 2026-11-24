'use strict';

const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');

const MAX_ENTRIES = 400;
const categories = Object.freeze({ query: 'SQL console', script: 'SQL script', metadata: 'Metadata' });
const statuses = Object.freeze({ running: 'Running', succeeded: 'Succeeded', failed: 'Failed',
  cancelled: 'Cancelled', timeout: 'Timed out', limited: 'Result limit' });
const operations = new Set(['SELECT', 'WITH', 'EXPLAIN', 'ANALYZE', 'SHOW', 'DESCRIBE', 'DESC', 'INSERT', 'UPDATE', 'DELETE',
  'REPLACE', 'CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'SET']);

function operationOf(sql) {
  const first = typeof sql === 'string' ? /^\s*([A-Za-z]+)\b/.exec(sql)?.[1]?.toUpperCase() : undefined;
  return operations.has(first) ? first : 'SQL';
}

function outcomeOf(code, truncated = false) {
  if (truncated || code === 'ROCKETBRAIN_RESULT_LIMIT') return 'limited';
  if (code === 'ROCKETBRAIN_CANCELLED') return 'cancelled';
  if (['ROCKETBRAIN_TIMEOUT', 'ER_QUERY_TIMEOUT', 'ER_STATEMENT_TIMEOUT'].includes(code)) return 'timeout';
  return code ? 'failed' : 'succeeded';
}

function createActivityLog({ enabled = false, canRecord = () => true, onChange = () => {} } = {}) {
  const entries = [];
  let dropped = 0, disposed = false, generation = 0, active = enabled === true;
  function reset() { generation++; entries.length = 0; dropped = 0; }
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
      if (entries.length === MAX_ENTRIES) { entries.shift(); dropped++; }
      entries.push(entry);
      changed();
      return status => {
        if (!active || !canRecord() || disposed || ticket !== generation || entry.status !== 'running' ||
            !Object.hasOwn(statuses, status) || status === 'running') return;
        entry.status = status;
        entry.durationMs = Math.round((performance.now() - started) * 100) / 100;
        changed();
      };
    };
  }
  return { createReporter, snapshot, setEnabled, clear() { reset(); changed(); }, dispose() { disposed = true; reset(); } };
}

module.exports = { createActivityLog, operationOf, outcomeOf, categories, statuses };
