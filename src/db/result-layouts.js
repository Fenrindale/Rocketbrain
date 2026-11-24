'use strict';

const { createHash } = require('node:crypto');

const storageKey = 'rocketbrain.database.resultLayouts.v1';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const isKey = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const limit = { tables: 128, columns: 4096, bytes: 1024 * 1024 };

function tableLayoutConnectionKey(config, profile) {
  const route = profile || config;
  if (!route || typeof route.host !== 'string' || typeof route.user !== 'string' || typeof route.database !== 'string') return undefined;
  const ssh = profile?.ssh;
  const tlsName = profile?.tls?.mode === 'verify' ? profile.tls.serverName : config?.ssl ? config.ssl.serverName || route.host : '';
  return digest([profile?.id || '', route.host.toLowerCase(), route.port ?? 3306, route.user, route.database,
    tlsName ? tlsName.toLowerCase() : '', ssh ? [ssh.host.toLowerCase(), ssh.port ?? 22, ssh.user] : null]);
}

function resultTableKey(connection, table) {
  if (!isKey(connection) || typeof table !== 'string' || !table || table.length > 64) return undefined;
  return digest([connection, table]);
}

function normalizeColumns(values) {
  if (!Array.isArray(values) || values.length > limit.columns) throw Error('This table has too many columns to remember its layout.');
  const seen = new Set();
  return values.map(column => {
    if (!column || typeof column.name !== 'string' || !column.name || column.name.length > 64 || seen.has(column.name) ||
        typeof column.hidden !== 'boolean' || typeof column.pinned !== 'boolean' ||
        column.width !== undefined && (!Number.isInteger(column.width) || column.width < 96 || column.width > 600)) {
      throw Error('Column layout contains an invalid name, width or display option.');
    }
    seen.add(column.name);
    return { name: column.name, hidden: column.hidden, pinned: column.pinned, ...(column.width === undefined ? {} : { width: column.width }) };
  });
}

function readSaved(memento) {
  const saved = memento?.get?.(storageKey);
  const records = new Map();
  if (saved?.version !== 1 || !Array.isArray(saved.tables) || saved.tables.length > limit.tables ||
      Buffer.byteLength(JSON.stringify(saved)) > limit.bytes) return records;
  for (const [key, columns] of saved.tables.filter(entry => Array.isArray(entry) && entry.length === 2)) {
    if (!isKey(key)) continue;
    try { records.set(key, normalizeColumns(columns)); }
    catch { /* Ignore an invalid stored entry independently of the remaining tables. */ }
  }
  return records;
}

function createResultLayouts(memento) {
  let records = readSaved(memento), pending = Promise.resolve();
  return {
    available: typeof memento?.update === 'function',
    read: key => records.get(key),
    write(key, columns, expected) {
      if (!isKey(key)) throw Error('Open the table preview before saving columns.');
      const clean = normalizeColumns(columns);
      const current = new Set(expected);
      if (clean.length && (clean.length !== current.size || clean.some(column => !current.has(column.name)) ||
          clean.every(column => column.hidden))) throw Error('The table columns changed. Open the column controls again.');
      const result = pending.then(async () => {
        const next = new Map(records);
        next.delete(key);
        if (clean.length) next.set(key, clean);
        const data = { version: 1, tables: [...next] };
        while (data.tables.length > limit.tables || Buffer.byteLength(JSON.stringify(data)) > limit.bytes) data.tables.shift();
        await memento.update(storageKey, data);
        records = new Map(data.tables);
      });
      pending = result.catch(() => {});
      return result;
    }
  };
}

module.exports = { createResultLayouts, resultTableKey, tableLayoutConnectionKey };
