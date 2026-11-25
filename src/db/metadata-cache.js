'use strict';

const { createHash } = require('node:crypto');

const storageKey = 'rocketbrain.database.metadataCache.v1';
const limits = Object.freeze({ entries: 8, totalBytes: 2 * 1024 * 1024, snapshotBytes: 512 * 1024, objects: 512, columns: 8192 });
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const isHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fail = message => Object.assign(Error(message), { code: 'ROCKETBRAIN_METADATA_CACHE' });
const isTimestamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const byName = (a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

function identifier(value) {
  if (typeof value !== 'string' || !value.length || value.length > 64 || /[\x00-\x1f\x7f\ud800-\udfff]/u.test(value)) {
    throw fail('The metadata includes an identifier that cannot be saved in an offline catalog.');
  }
  return value;
}

function typeName(value) {
  const text = typeof value === 'string' && value.length <= 65535 ? value.toLowerCase() : '';
  if (/^(?:enum|set)\(/.test(text)) return text.slice(0, text.indexOf('('));
  return /^[a-z][a-z0-9]*(?:\(\d{1,6}(?:,\d{1,6})?\))?(?: unsigned| zerofill){0,2}$/.test(text) &&
    text.length <= 64 ? text : 'unknown';
}

function projectCatalog(source) {
  const { database, dialect, serverVersion, tableNameCaseSensitive, sqlMode, tables, views } = source;
  if (!['mysql', 'mariadb'].includes(dialect) || typeof tableNameCaseSensitive !== 'boolean' ||
      !Array.isArray(sqlMode) || sqlMode.length > 32 || sqlMode.some(mode => typeof mode !== 'string' || !/^[A-Z0-9_]{1,80}$/.test(mode)) ||
      !Array.isArray(tables) || !Array.isArray(views) || tables.length + views.length > limits.objects) {
    throw fail('A complete supported table and column catalog is needed to save offline metadata.');
  }
  const version = typeof serverVersion === 'string' && /^\d{1,3}\.\d{1,3}(?:\.\d{1,3})?/.exec(serverVersion)?.[0];
  if (!version) throw fail('The database server version could not be observed.');
  let totalColumns = 0;
  const names = new Set();
  function objects(items, kind) {
    return items.map(item => {
      const name = identifier(item.name);
      const key = tableNameCaseSensitive ? name : name.toLowerCase();
      if (names.has(key) || !Array.isArray(item.columns) || item.kind !== kind) throw fail('The observed object catalog changed. Refresh it and try again.');
      names.add(key);
      totalColumns += item.columns.length;
      if (totalColumns > limits.columns) throw fail('This schema exceeds the offline catalog column limit.');
      const used = new Set();
      const columns = item.columns.map(column => {
        const name = identifier(column.name), key = name.toLowerCase();
        if (used.has(key) || typeof column.nullable !== 'boolean' || typeof column.primaryKey !== 'boolean') {
          throw fail('The observed column catalog changed. Refresh it and try again.');
        }
        used.add(key);
        return { name, type: typeName(column.type), nullable: column.nullable === true, primaryKey: column.primaryKey === true };
      });
      return { name, kind, columns };
    }).sort(byName);
  }
  return { database: identifier(database), dialect, serverVersion: version, tableNameCaseSensitive,
    sqlMode: [...new Set(sqlMode)].sort(), tables: objects(tables, 'table'), views: objects(views, 'view') };
}

function liveCatalog(source) {
  if (source?.scope !== 'database' || source.visibility !== 'current-account' || source.semanticContextObserved !== true ||
      source.coverage?.tables !== 'loaded' || source.coverage.columns !== 'loaded') {
    throw fail('Refresh visible database tables, columns and SQL context before saving offline metadata.');
  }
  return projectCatalog(source);
}

async function observeCatalogIdentity(db, catalog) {
  const read = async sql => {
    const result = await db._metadataQuery(sql, []);
    if (result.truncated || result.rows.length !== 1) throw fail('The database metadata identity could not be observed.');
    return result.rows[0];
  };
  const [account, database] = await read('SELECT CURRENT_USER(), DATABASE()');
  const [server] = await read(catalog.dialect === 'mysql' ? 'SELECT @@server_uuid' : 'SELECT @@server_uid');
  if (database !== catalog.database || typeof account !== 'string' || !account || account.length > 1024 ||
      typeof server !== 'string' || !server || server.length > 256) throw fail('The server, account or schema changed during catalog capture.');
  return hash([catalog.dialect, server, account, database]);
}

function createMetadataCache(state, { isTrusted, now = () => new Date().toISOString() } = {}) {
  let tail = Promise.resolve();
  const guard = () => { if (!isTrusted()) throw fail('Trust this workspace before opening saved database metadata.'); };
  function read() {
    guard();
    const raw = state.get(storageKey);
    if (raw?.version !== 1 || !Array.isArray(raw.entries) || raw.entries.length > limits.entries) return [];
    const entries = [];
    let bytes = 0;
    for (const item of raw.entries) {
      try {
        const size = Buffer.byteLength(JSON.stringify(item));
        if (size > limits.snapshotBytes || bytes + size > limits.totalBytes ||
            !isHash(item.id) || !isHash(item.identity) || !isHash(item.fingerprint) || !isTimestamp(item.capturedAt) ||
            !isTimestamp(item.checkedAt) || item.capturedAt > item.checkedAt || entries.some(entry => entry.id === item.id)) continue;
        const catalog = projectCatalog(item.catalog);
        if (hash([item.identity, catalog]) !== item.fingerprint || JSON.stringify(catalog) !== JSON.stringify(item.catalog)) continue;
        entries.push({ id: item.id, identity: item.identity, fingerprint: item.fingerprint, capturedAt: item.capturedAt,
          checkedAt: item.checkedAt, catalog });
        bytes += size;
      } catch { /* A malformed entry cannot supply SQL metadata. */ }
    }
    return entries;
  }
  function mutate(task) {
    const run = tail.then(task);
    tail = run.catch(() => {});
    return run;
  }
  async function save(entries) {
    guard();
    await state.update(storageKey, { version: 1, entries });
  }
  const summary = ({ id, fingerprint, capturedAt, checkedAt, catalog }) => ({
    id, fingerprint, capturedAt, checkedAt, database: catalog.database, dialect: catalog.dialect,
    serverVersion: catalog.serverVersion, tables: catalog.tables.length, views: catalog.views.length
  });
  return {
    list: () => read().map(summary),
    has: id => read().some(item => item.id === id),
    open(id, fingerprint) {
      const item = read().find(entry => entry.id === id);
      if (!item || fingerprint !== undefined && fingerprint !== item.fingerprint) throw fail('Choose the current saved metadata snapshot again.');
      const provenance = summary(item);
      return { provenance, catalog: { ...item.catalog, loadedAt: item.capturedAt, scope: 'database',
        coverage: {}, visibility: 'cached-current-account', complete: false, cachedMetadata: provenance } };
    },
    capture(id, identity, source, current) {
      return mutate(async () => {
        guard();
        if (!isHash(id) || !isHash(identity) || !current()) throw fail('The database changed. Capture its metadata again.');
        const observed = now(), catalog = liveCatalog(source);
        if (!isTimestamp(observed)) throw fail('The capture time was invalid.');
        const item = { id, identity, fingerprint: hash([identity, catalog]), capturedAt: observed, checkedAt: observed, catalog };
        const bytes = Buffer.byteLength(JSON.stringify(item));
        if (bytes > limits.snapshotBytes) throw fail('The metadata snapshot exceeds 512 KiB.');
        let total = bytes;
        const entries = [item];
        for (const other of read()) {
          if (other.id === id || entries.length >= limits.entries) continue;
          const size = Buffer.byteLength(JSON.stringify(other));
          if (total + size <= limits.totalBytes) { entries.push(other); total += size; }
        }
        if (!current()) throw fail('The database changed. Capture its metadata again.');
        await save(entries);
        return summary(item);
      });
    },
    revalidate(id, identity, source, current) {
      return mutate(async () => {
        guard();
        if (!current() || !isHash(identity)) return 'unverified';
        const entries = read(), item = entries.find(entry => entry.id === id);
        if (!item) return 'absent';
        let fingerprint;
        try { fingerprint = hash([identity, liveCatalog(source)]); } catch { /* An incomplete or unsupported live catalog cannot rebind this entry. */ }
        if (!current()) return 'unverified';
        if (!fingerprint || item.identity !== identity || item.fingerprint !== fingerprint) {
          await save(entries.filter(entry => entry !== item));
          return 'invalidated';
        }
        const stamp = now();
        if (isTimestamp(stamp) && stamp >= item.checkedAt) {
          item.checkedAt = stamp;
          await save(entries);
        }
        return 'matched';
      });
    },
    revalidateObjects(id, identity, source, observations, current) {
      return mutate(async () => {
        guard();
        if (!current() || !isHash(identity) || source?.semanticContextObserved !== true) return 'unverified';
        const entries = read(), item = entries.find(entry => entry.id === id);
        if (!item) return 'absent';
        const nameKey = name => item.catalog.tableNameCaseSensitive ? name : name.toLowerCase();
        const savedObjects = new Map([...item.catalog.tables, ...item.catalog.views].map(object => [nameKey(object.name), object]));
        let differs = item.identity !== identity;
        if (!differs) for (const { name, object } of observations) {
          let projection;
          if (object) {
            try {
              const partial = projectCatalog({ ...source, tables: object.kind === 'table' ? [object] : [],
                views: object.kind === 'view' ? [object] : [] });
              projection = partial.tables[0] ?? partial.views[0];
            } catch { continue; }
            if (!projection) continue;
          }
          if (JSON.stringify(savedObjects.get(nameKey(name))) !== JSON.stringify(projection)) {
            differs = true;
            break;
          }
        }
        if (!current() || !differs) return 'unverified';
        await save(entries.filter(entry => entry !== item));
        return 'invalidated';
      });
    },
    remove(id, fingerprint) {
      return mutate(async () => {
        const entries = read(), item = entries.find(entry => entry.id === id);
        if (!item || item.fingerprint !== fingerprint) throw fail('Choose the current saved metadata snapshot again.');
        await save(entries.filter(entry => entry !== item));
      });
    }
  };
}

module.exports = { createMetadataCache, observeCatalogIdentity, storageKey, limits };
