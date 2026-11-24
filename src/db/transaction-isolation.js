'use strict';

const levels = Object.freeze(['READ UNCOMMITTED', 'READ COMMITTED', 'REPEATABLE READ', 'SERIALIZABLE']);

function isolationLevel(value) {
  if (!levels.includes(value)) throw new Error('Choose a supported transaction isolation level.');
  return value;
}

function serverIsolationLevel(result) {
  const allowed = new Set(['transaction_isolation', 'tx_isolation']);
  const observed = new Map();
  if (!result.truncated) for (const row of result.rows) {
    const [key, value] = row;
    const name = String(key).toLowerCase();
    if (row.length !== 2 || !allowed.has(name) || observed.has(name)) break;
    const normalized = typeof value === 'string' && value.toUpperCase().replaceAll('-', ' ');
    if (!levels.includes(normalized)) break;
    observed.set(name, normalized);
  }
  if (observed.size !== result.rows.length || !observed.size || new Set(observed.values()).size !== 1) {
    throw Object.assign(new Error('The server did not confirm a supported isolation level for this console.'), {
      code: 'ROCKETBRAIN_ISOLATION_NOT_OBSERVED'
    });
  }
  return observed.values().next().value;
}

module.exports = { levels, isolationLevel, serverIsolationLevel };
