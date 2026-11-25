'use strict';

const { MongoClient, BSON } = require('mongodb');

const maxQueryBytes = 64 * 1024;
const maxDocumentBytes = 256 * 1024;
const maxPreviewBytes = 1024 * 1024;
const maxDocuments = 200;
const maxCatalogEntries = 200;
const maxTimeMS = 5000;
const reserved = new Set(['__proto__', 'prototype', 'constructor']);
const queryKeys = new Set(['database', 'collection', 'filter', 'projection', 'sort', 'limit']);
const comparisons = new Set(['$eq', '$ne', '$lt', '$lte', '$gt', '$gte']);
const logicalOperators = new Set(['$and', '$or', '$nor']);
const decimal = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?$/;
const integer = /^-?(?:0|[1-9]\d*)$/;

class MongoDbError extends Error {
  constructor(message, code = 'ROCKETBRAIN_MONGO_INPUT') {
    super(message);
    this.name = 'MongoDbError';
    this.code = code;
  }
}

const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validText = (value, size) => typeof value === 'string' && value.length > 0 &&
  !value.includes('\0') && Buffer.byteLength(value) <= size;

function databaseName(value) {
  if (!validText(value, 63) || /[\/\\." $*<>:|?\x00-\x1f]/u.test(value)) {
    throw new MongoDbError('Use a valid MongoDB database name of up to 63 bytes.');
  }
  return value;
}

function collectionName(value) {
  if (!validText(value, 200) || /[$\x00-\x1f]/u.test(value) || value.startsWith('.') || value.endsWith('.')) {
    throw new MongoDbError('Use a valid MongoDB collection name of up to 200 bytes.');
  }
  return value;
}

function mongoTarget(options) {
  const { host = '127.0.0.1', port = 27017, authSource = 'admin', username, password } = options ?? {};
  if (host !== '127.0.0.1' && host !== '::1') throw new MongoDbError('Use a numeric loopback MongoDB address, 127.0.0.1 or ::1.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new MongoDbError('Use a MongoDB port from 1 to 65535.');
  if (!validText(username, 256) || !validText(password, 2048)) throw new MongoDbError('Supply a MongoDB username and password.');
  return { host, port, authSource: databaseName(authSource), username, password };
}

function fieldName(key) {
  if (!validText(key, 256) || !key.split('.').every(part =>
    part && !reserved.has(part) && !/[$\x00-\x1f]/u.test(part))) {
    throw new MongoDbError('Use ordinary MongoDB field names or dotted field paths.');
  }
}

function exactShape(value, keys) {
  return plainObject(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function intText(value, min, max) {
  return typeof value === 'string' && value.length <= 20 && integer.test(value) && BigInt(value) >= min && BigInt(value) <= max;
}

function typedLiteral(value) {
  const [type] = Object.keys(value);
  if (!exactShape(value, [type])) return false;
  const argument = value[type];
  switch (type) {
    case '$oid': return typeof argument === 'string' && /^[0-9a-f]{24}$/i.test(argument);
    case '$numberInt': return intText(argument, -2147483648n, 2147483647n);
    case '$numberLong': return intText(argument, -9223372036854775808n, 9223372036854775807n);
    case '$numberDouble':
    case '$numberDecimal': return typeof argument === 'string' && argument.length <= 100 &&
      (decimal.test(argument) || ['NaN', 'Infinity', '-Infinity'].includes(argument));
    case '$date':
      return typeof argument === 'string' ? /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(argument) &&
        Number.isFinite(Date.parse(argument)) : exactShape(argument, ['$numberLong']) &&
        intText(argument.$numberLong, -8640000000000000n, 8640000000000000n);
    case '$binary': return exactShape(argument, ['base64', 'subType']) && typeof argument.base64 === 'string' &&
      argument.base64.length <= 16384 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(argument.base64) &&
      typeof argument.subType === 'string' && /^[\da-f]{2}$/i.test(argument.subType);
    default: return false;
  }
}

function scope() {
  let remaining = 600;
  return depth => {
    if (--remaining < 0 || depth > 12) throw new MongoDbError('The MongoDB filter is too deeply nested or complex.');
  };
}

function checkLiteral(value, depth, count) {
  count(depth);
  if (typeof value === 'number' && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) {
    throw new MongoDbError('Use a canonical Extended JSON number for values outside the safe JSON integer range.');
  }
  if (Array.isArray(value)) {
    if (value.length > 100) throw new MongoDbError('MongoDB filter arrays are limited to 100 values.');
    for (const item of value) checkLiteral(item, depth + 1, count);
  } else if (plainObject(value) && !typedLiteral(value)) {
    for (const [key, item] of Object.entries(value)) {
      fieldName(key);
      checkLiteral(item, depth + 1, count);
    }
  }
}

function checkFieldCondition(value, depth, count) {
  if (!plainObject(value) || typedLiteral(value) || !Object.keys(value).some(key => key.startsWith('$'))) {
    return checkLiteral(value, depth, count);
  }
  count(depth);
  for (const [operator, operand] of Object.entries(value)) {
    if (comparisons.has(operator)) checkLiteral(operand, depth + 1, count);
    else if ((operator === '$in' || operator === '$nin') && Array.isArray(operand)) checkLiteral(operand, depth + 1, count);
    else if (operator === '$exists' && typeof operand === 'boolean') count(depth + 1);
    else throw new MongoDbError('Use comparison, membership or existence operators in field conditions.');
  }
}

function checkFilter(value, depth, count) {
  count(depth);
  if (!plainObject(value)) throw new MongoDbError('The MongoDB filter must be a JSON object.');
  for (const [key, condition] of Object.entries(value)) {
    if (logicalOperators.has(key)) {
      if (!Array.isArray(condition) || condition.length < 1 || condition.length > 25) {
        throw new MongoDbError('Each logical group requires between 1 and 25 filter objects.');
      }
      for (const item of condition) checkFilter(item, depth + 1, count);
    } else {
      fieldName(key);
      checkFieldCondition(condition, depth + 1, count);
    }
  }
}

function fieldOptions(value, allowed, maximum, label) {
  if (value === undefined) return undefined;
  if (!plainObject(value) || Object.keys(value).length > maximum) {
    throw new MongoDbError(`${label} must be a JSON object with at most ${maximum} fields.`);
  }
  for (const [key, direction] of Object.entries(value)) {
    fieldName(key);
    if (!allowed.includes(direction)) throw new MongoDbError(`${label} uses values ${allowed.join(' and ')}.`);
  }
  return value;
}

function parseMongoFind(source) {
  if (typeof source !== 'string' || Buffer.byteLength(source) > maxQueryBytes) {
    throw new MongoDbError('A MongoDB find document is limited to 64 KiB.');
  }
  let query;
  try { query = JSON.parse(source); }
  catch { throw new MongoDbError('Enter one valid JSON find document.'); }
  if (!plainObject(query) || Object.keys(query).some(key => !queryKeys.has(key))) {
    throw new MongoDbError('Use only database, collection, filter, projection, sort and limit.');
  }
  const database = databaseName(query.database);
  const collection = collectionName(query.collection);
  const limit = query.limit === undefined ? 50 : query.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > maxDocuments) throw new MongoDbError('Use a limit from 1 to 200.');
  const projection = fieldOptions(query.projection, [0, 1], 64, 'Projection');
  const sort = fieldOptions(query.sort, [-1, 1], 16, 'Sort');
  const filter = query.filter === undefined ? {} : query.filter;
  checkFilter(filter, 0, scope());
  let bsonFilter;
  try { bsonFilter = BSON.EJSON.deserialize(filter, { relaxed: false }); }
  catch { throw new MongoDbError('The filter contains an invalid Extended JSON value.'); }
  return { database, collection, filter: bsonFilter, projection, sort, limit };
}

function safeError(error, signal) {
  if (signal?.aborted) return new MongoDbError('MongoDB operation cancelled or timed out.', 'ROCKETBRAIN_MONGO_CANCELLED');
  if (error instanceof MongoDbError) return error;
  const code = error?.code instanceof BSON.Int32 ? error.code.valueOf() : error?.code;
  switch (code) {
    case 13: return new MongoDbError('The MongoDB account cannot read this database or collection.', 'ROCKETBRAIN_MONGO_FORBIDDEN');
    case 18: return new MongoDbError('MongoDB rejected the connection credentials.', 'ROCKETBRAIN_MONGO_AUTH');
    case 50: return new MongoDbError('MongoDB reached the read time limit.', 'ROCKETBRAIN_MONGO_TIMEOUT');
    default: return new MongoDbError('MongoDB could not complete the read. Check the local server and query settings.', 'ROCKETBRAIN_MONGO_READ');
  }
}

function serializeDocument(document) {
  if (BSON.calculateObjectSize(document) > maxDocumentBytes) return undefined;
  const json = BSON.EJSON.stringify(document, null, 2, { relaxed: false });
  if (Buffer.byteLength(json) > maxDocumentBytes) return undefined;
  return json;
}

async function closeCursor(cursor) {
  // Preserve the original query outcome if the driver already closed the socket.
  await cursor.close().catch(() => {});
}

async function collectCatalog(cursor) {
  const values = [];
  try {
    for await (const item of cursor) {
      if (values.length === maxCatalogEntries) return { values, truncated: true };
      values.push({ name: item.name, kind: item.type });
    }
    return { values, truncated: false };
  } finally { await closeCursor(cursor); }
}

async function openMongoDb(configuration, { signal } = {}) {
  const { host, port, authSource, username, password } = mongoTarget(configuration);
  const endpoint = `mongodb://${host === '::1' ? '[::1]' : host}:${port}`;
  const client = new MongoClient(endpoint, { auth: { username, password }, authSource,
    authMechanism: 'SCRAM-SHA-256', directConnection: true, appName: 'Rocketbrain',
    serverSelectionTimeoutMS: maxTimeMS, connectTimeoutMS: maxTimeMS, socketTimeoutMS: 8000,
    waitQueueTimeoutMS: maxTimeMS, maxPoolSize: 2, retryReads: false });
  const lifetime = new AbortController();
  let running = false;
  let closing;
  function close() {
    lifetime.abort();
    closing ??= client.close();
    return closing;
  }

  const connectSignal = AbortSignal.any([AbortSignal.timeout(10000), ...(signal ? [signal] : [])]);
  try {
    connectSignal.throwIfAborted();
    await client.connect();
    await client.db('admin').command({ ping: 1 }, { signal: connectSignal });
    connectSignal.throwIfAborted();
  } catch (error) {
    await close().catch(() => {});
    throw safeError(error, connectSignal);
  }

  async function use(action, options = {}) {
    if (lifetime.signal.aborted) throw new MongoDbError('Reconnect to the MongoDB instance.');
    if (running) throw new MongoDbError('Wait for the active MongoDB operation to finish.');
    const inputs = [lifetime.signal, AbortSignal.timeout(12000)];
    if (options.signal) inputs.push(options.signal);
    const request = AbortSignal.any(inputs);
    running = true;
    try {
      request.throwIfAborted();
      const result = await action(request);
      request.throwIfAborted();
      return result;
    } catch (error) { throw safeError(error, request); }
    finally { running = false; }
  }

  return {
    source: Object.freeze({ host, port, authSource }),
    close,
    databases: options => use(async request => {
      const { databases } = await client.db('admin').command({ listDatabases: 1, authorizedDatabases: true, nameOnly: true, maxTimeMS },
        { signal: request });
      return { databases: databases.slice(0, maxCatalogEntries).map(item => item.name), truncated: databases.length > maxCatalogEntries };
    }, options),
    collections: (database, options) => use(async request => {
      const cursor = client.db(databaseName(database)).listCollections({}, { nameOnly: true, authorizedCollections: true,
        batchSize: 25, maxTimeMS, signal: request });
      const { values, truncated } = await collectCatalog(cursor);
      return { database, collections: values, truncated };
    }, options),
    find: (source, options) => use(async request => {
      const { database, collection, filter, sort, projection, limit } = parseMongoFind(source);
      const cursor = client.db(database).collection(collection).find(filter, { sort, projection, limit: limit + 1,
        batchSize: 10, maxTimeMS, allowDiskUse: false, promoteValues: false, signal: request });
      const documents = [];
      let bytes = 0;
      let truncated;
      try {
        for await (const document of cursor) {
          if (documents.length === limit) { truncated = 'row-limit'; break; }
          const json = serializeDocument(document);
          if (json === undefined) { truncated = 'document-size'; break; }
          bytes += Buffer.byteLength(json);
          if (bytes > maxPreviewBytes) { truncated = 'preview-size'; break; }
          documents.push(JSON.parse(json));
        }
      } finally { await closeCursor(cursor); }
      return { database, collection, documents, encoding: 'canonical-extended-json', truncated: truncated ?? null };
    }, options)
  };
}

module.exports = { openMongoDb, parseMongoFind, mongoTarget, MongoDbError };
