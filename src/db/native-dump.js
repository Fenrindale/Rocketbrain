'use strict';

const { createReadStream, createWriteStream } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const native = require('./native-dump-process');
const schemaGraph = require('./native-dump-graph');

const key = 'rocketbrain.nativeDumps.v1';
const maxTables = 64;
const maxReceipts = 24;
const reviewLifetime = 5 * 60 * 1000;
const legalName = value => typeof value === 'string' && /^[a-zA-Z_][a-zA-Z0-9_$]{0,63}$/.test(value);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const isDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const knownDialect = value => value === 'mysql' || value === 'mariadb';
const fail = native.error;

function current(guard, signal) {
  if (!guard() || signal?.aborted) throw fail('CANCELLED', 'The database changed or the native database operation was cancelled.');
}

function nativeConnection(db) {
  const options = db?._options;
  if (!options || options.ssl || options.socketPath || options.stream ||
      !['127.0.0.1', '::1'].includes(options.host) || !Number.isInteger(options.port) ||
      !legalName(options.database) || typeof options.user !== 'string' || !options.user || typeof options.password !== 'string') {
    throw fail('ROUTE', 'Use a direct loopback TCP database connection and a supported schema name for native backup and restore.');
  }
  return options;
}

async function one(db, sql, parameters = []) {
  const response = await db._metadataQuery(sql, parameters);
  if (response.truncated || response.rows.length !== 1) throw fail('CONTEXT', 'The native database operation could not verify its server context.');
  return response.rows[0];
}

async function verifyTarget(db) {
  const config = nativeConnection(db);
  const [version, database, account] = await one(db, 'SELECT VERSION(), DATABASE(), CURRENT_USER()');
  const dialect = typeof version === 'string' && /mariadb/i.test(version) ? 'mariadb' : 'mysql';
  const [server] = await one(db, dialect === 'mysql' ? 'SELECT @@server_uuid' : 'SELECT @@server_uid');
  if (typeof version !== 'string' || typeof server !== 'string' || !server || server.length > 256 ||
      database !== config.database || typeof account !== 'string' || !account || account.length > 1024) {
    throw fail('CONTEXT', 'The observed server or database account changed. Connect again.');
  }
  const schemaKey = digest([dialect, server, database]);
  const serverKey = digest([dialect, server]);
  return { dialect, version, database, account, config, schemaKey, serverKey, accountKey: digest([serverKey, account]),
    route: digest([schemaKey, account, config.host, config.port]),
    endpoint: config.host.includes(':') ? '[' + config.host + ']:' + config.port : config.host + ':' + config.port };
}

function dumpable(catalog) {
  if (catalog.scope !== 'database' || catalog.coverage?.tables !== 'loaded' || catalog.coverage?.foreignKeys !== 'loaded') {
    throw fail('CATALOG', 'Observe the database tables and foreign keys before starting a native backup.');
  }
  return catalog.tables.filter(table => table.kind === 'table' && legalName(table.name) && /^innodb$/i.test(table.engine));
}

function selectTables(catalog, tables) {
  if (!Array.isArray(tables) || !tables.length || tables.length > maxTables || !tables.every(legalName) || new Set(tables).size !== tables.length) {
    throw fail('TABLES', 'Choose between one and 64 distinct InnoDB base tables.');
  }
  const available = new Map(dumpable(catalog).map(table => [table.name, table]));
  const selected = new Set(tables);
  for (const name of tables) {
    const table = available.get(name);
    if (!table || !Array.isArray(table.foreignKeys)) throw fail('TABLES', 'Every selected table must be an observed InnoDB base table.');
    for (const fk of table.foreignKeys) {
      if (fk.referencedSchema !== catalog.database || !selected.has(fk.referencedTable)) {
        throw fail('DEPENDENCIES', 'Include all selected tables’ referenced InnoDB tables from the same schema.');
      }
    }
  }
  return [...tables].sort();
}

async function assertEmpty(db, { database }) {
  const values = await one(db, 'SELECT (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?), ' +
    '(SELECT COUNT(*) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ?), ' +
    '(SELECT COUNT(*) FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ?)', [database, database, database]);
  if (values.length !== 3 || values.some(count => !['0', 0, 0n].includes(count))) {
    throw fail('DESTINATION', 'Choose an empty destination schema before native restore.');
  }
}

function vendorArgs(dialect) {
  return ['--defaults-file=rb-client.cnf', ...(dialect === 'mysql' ? ['--no-login-paths', '--ssl-mode=DISABLED'] : ['--skip-ssl'])];
}

function verifiedReceipt(item) {
  return isDigest(item?.sha256) && isDigest(item.sourceKey) && knownDialect(item.dialect) && legalName(item.sourceDatabase) &&
    typeof item.capturedAt === 'string' && item.capturedAt.length === 24 && Number.isFinite(Date.parse(item.capturedAt)) &&
    typeof item.toolVersion === 'string' && /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(item.toolVersion) &&
    Number.isInteger(item.bytes) && item.bytes > 0 && item.bytes <= native.maxDumpBytes &&
    Array.isArray(item.tables) && item.tables.length > 0 && item.tables.length <= maxTables && item.tables.every(legalName) &&
    (item.graph === undefined || schemaGraph.validGraph(item.graph));
}

function createNativeDumps(memento, withTarget) {
  const prepares = new Map();
  function receipts() {
    const value = memento.get(key);
    return value?.version === 1 && Array.isArray(value.items) && value.items.length <= maxReceipts ?
      value.items.filter(verifiedReceipt) : [];
  }
  async function record(receipt) {
    await memento.update(key, { version: 1, items: [receipt, ...receipts().filter(item => item.sha256 !== receipt.sha256)].slice(0, maxReceipts) });
  }
  async function absolute(file, operation) {
    if (typeof file !== 'string' || !path.isAbsolute(file) || path.extname(file).toLowerCase() !== '.sql') {
      throw fail('PATH', 'Choose an absolute native database .sql ' + operation + ' path.');
    }
    return path.join(await fs.realpath(path.dirname(file)), path.basename(file));
  }

  return {
    listTables: () => withTarget(async ({ db, guard, epoch }) => {
      const source = await verifyTarget(db);
      const catalog = await db.metadata();
      const candidates = dumpable(catalog).map(table => table.name);
      current(guard);
      return { database: source.database, dialect: source.dialect, tables: candidates, objects: schemaGraph.objectsFrom(catalog), connectionEpoch: epoch };
    }),
    dump: (request, options = {}) => withTarget(async ({ db, guard, epoch }) => {
      const { signal, onProgress } = options;
      current(guard, signal);
      if (request.connectionEpoch !== epoch) throw fail('CONTEXT', 'The backup connection changed. Select the source tables again.');
      const source = await verifyTarget(db);
      const tools = await native.inspectTools(request.tools, source.dialect);
      const catalog = await db.metadata();
      const tables = selectTables(catalog, request.tables);
      const selected = request.objects ?? [];
      if (!Array.isArray(selected)) throw fail('GRAPH', 'Choose visible schema objects for the native graph.');
      const graph = selected.length ? await schemaGraph.captureGraph(db, source, catalog, tables, selected) : undefined;
      const file = await absolute(request.file, 'output');
      const pending = path.join(path.dirname(file), '.rocketbrain-' + randomUUID() + '.pending');
      let owned = false;
      try {
        const handle = await fs.open(pending, 'wx', 0o600);
        owned = true;
        try {
          let streamed = await native.withPrivateDirectory(async directory => {
            await native.writeClientFile(directory, source.config);
            const counter = native.measure(native.maxDumpBytes, onProgress, signal);
            current(guard, signal);
            const result = await native.runner(tools.dump.file, [...vendorArgs(source.dialect), '--single-transaction', '--quick',
              '--skip-lock-tables', '--skip-add-locks', '--skip-add-drop-table', '--skip-triggers', '--skip-routines', '--skip-events',
              '--no-tablespaces', '--hex-blob', ...(source.dialect === 'mysql' ? ['--set-gtid-purged=OFF', '--column-statistics=0'] : []),
              source.database, ...tables], { cwd: directory, signal, output: [counter.stream, handle.createWriteStream()] });
            return { ...counter.summary(), warnings: result.warnings };
          });
          current(guard, signal);
          if (!streamed.bytes) throw fail('SIZE', 'The native backup tool produced no output.');
          if (graph) {
            const observed = await verifyTarget(db);
            const fresh = await schemaGraph.captureGraph(db, observed, await db.metadata(), tables, selected);
            current(guard, signal);
            if (observed.route !== source.route || fresh.sourceStamp !== graph.sourceStamp) {
              throw fail('GRAPH', 'The source schema changed during native backup. Prepare the graph again.');
            }
            await fs.appendFile(pending, graph.suffix);
            streamed = { ...(await native.readFile(pending, { maxBytes: native.maxDumpBytes, signal })), warnings: streamed.warnings };
          }
          const synced = await fs.open(pending, 'r+');
          try { await synced.sync(); } finally { await synced.close(); }
          const receipt = { bytes: streamed.bytes, sha256: streamed.sha256, dialect: source.dialect, sourceDatabase: source.database,
            sourceKey: source.schemaKey, toolVersion: tools.version, tables, capturedAt: new Date().toISOString(),
            ...(graph && { graph: graph.graph }) };
          try { await fs.link(pending, file); }
          catch { throw fail('PUBLISH', 'The backup was not published. Choose a new filename on a local filesystem that supports atomic file creation.'); }
          try { await record(receipt); }
          catch { throw fail('RECEIPT', 'The backup file was created, but its local restore receipt could not be saved.'); }
          return { file, ...structuredClone(receipt), warnings: streamed.warnings };
        } finally { await handle.close(); }
      } finally { if (owned) await fs.unlink(pending); }
    }),
    previewRestore: (request, options = {}) => withTarget(async ({ db, guard, epoch }) => {
      current(guard, options.signal);
      const destination = await verifyTarget(db);
      const tools = await native.inspectTools(request.tools, destination.dialect);
      const file = await absolute(request.file, 'input');
      const content = await native.readFile(file, { maxBytes: native.maxDumpBytes, signal: options.signal });
      const receipt = receipts().find(item => item.sha256 === content.sha256 && item.bytes === content.bytes && item.dialect === destination.dialect);
      if (!receipt) throw fail('RECEIPT', 'Choose an unchanged backup produced and registered in this workspace by the same database dialect.');
      if (receipt.sourceKey === destination.schemaKey) throw fail('DESTINATION', 'Connect to a different empty schema before native restore.');
      await assertEmpty(db, destination);
      if (receipt.graph) await schemaGraph.checkDestination(db, destination, receipt.graph);
      current(guard, options.signal);
      const reviewId = randomUUID();
      for (const [id, review] of prepares) if (review.expires < Date.now()) prepares.delete(id);
      while (prepares.size >= 8) prepares.delete(prepares.keys().next().value);
      const expires = Date.now() + reviewLifetime;
      prepares.set(reviewId, { file, receipt, expires, route: destination.route, epoch, tools });
      return { reviewId, file, bytes: receipt.bytes, sha256: receipt.sha256, sourceDatabase: receipt.sourceDatabase,
        destinationDatabase: destination.database, destinationEndpoint: destination.endpoint,
        tables: [...receipt.tables], ...(receipt.graph && { objects: structuredClone(receipt.graph.objects) }),
        clientVersion: tools.version, expiresAt: new Date(expires).toISOString() };
    }),
    restore: (request, options = {}) => withTarget(async ({ db, guard, epoch }) => {
      const { signal, onProgress } = options;
      current(guard, signal);
      const stored = prepares.get(request.reviewId);
      if (!stored || Date.now() > stored.expires || stored.epoch !== epoch || request.allowWrite !== true) {
        throw fail('REVIEW', 'Review this backup and its empty destination again before approving restore.');
      }
      const target = await verifyTarget(db);
      if (stored.route !== target.route || request.destinationDatabase !== target.database) {
        throw fail('DESTINATION', 'The approved restore destination changed. Review the active connection again.');
      }
      const tool = await native.readFile(stored.tools.restore.file, { maxBytes: native.maxToolBytes, signal });
      if (tool.sha256 !== stored.tools.restore.fingerprint) throw fail('TOOL_PATH', 'The reviewed restore executable changed. Review the client again.');
      prepares.delete(request.reviewId);
      return native.withPrivateDirectory(async directory => {
        const staged = path.join(directory, 'reviewed.sql');
        const content = await native.readFile(stored.file, { maxBytes: native.maxDumpBytes, signal,
          output: () => createWriteStream(staged, { flags: 'wx', mode: 0o600 }) });
        if (content.sha256 !== stored.receipt.sha256 || content.bytes !== stored.receipt.bytes) {
          throw fail('CHANGED', 'The backup bytes changed after review. Open a new restore review.');
        }
        const latest = await verifyTarget(db);
        if (latest.route !== stored.route) throw fail('DESTINATION', 'The destination changed before restore. Review the active connection again.');
        await assertEmpty(db, latest);
        if (stored.receipt.graph) await schemaGraph.checkDestination(db, latest, stored.receipt.graph);
        await native.writeClientFile(directory, latest.config);
        current(guard, signal);
        const counter = native.measure(native.maxDumpBytes, onProgress, signal);
        const input = [createReadStream(staged), counter.stream];
        try {
          const result = await native.runner(stored.tools.restore.file, [...vendorArgs(latest.dialect), '--batch', '--binary-mode',
            '--local-infile=0', '--skip-reconnect', '--database=' + latest.database], { cwd: directory, signal, input });
          const applied = counter.summary();
          if (applied.sha256 !== content.sha256 || applied.bytes !== content.bytes) throw fail('CHANGED', 'The reviewed file was not fully restored.');
          const graph = stored.receipt.graph;
          if (graph) {
            current(guard, signal);
            const saved = await schemaGraph.captureGraph(db, latest, await db.metadata(), stored.receipt.tables, graph.objects);
            if (saved.graph.fingerprint !== graph.fingerprint) throw fail('GRAPH', 'The restored server object graph differs from the reviewed definitions.');
          }
          return { state: 'restored', database: latest.database, ...applied, tables: [...stored.receipt.tables], warnings: result.warnings,
            ...(graph && { graphVerified: true, objects: structuredClone(graph.objects) }) };
        } catch (cause) {
          throw fail('RESTORE', cause.message + ' Inspect the chosen schema for partial changes before retrying.');
        }
      });
    }, { write: true })
  };
}

module.exports = { createNativeDumps, maxTables, selectTables };
