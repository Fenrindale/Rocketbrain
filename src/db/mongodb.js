'use strict';

const { MongoClient, BSON } = require('mongodb');
const { createHash, randomUUID, X509Certificate } = require('node:crypto');
const fs = require('node:fs/promises');
const { isIP } = require('node:net');
const path = require('node:path');
const { createSecureContext } = require('node:tls');

const maxQueryBytes = 64 * 1024;
const maxDocumentBytes = 256 * 1024;
const maxPreviewBytes = 1024 * 1024;
const maxDocuments = 200;
const maxCatalogEntries = 200;
const maxTimeMS = 5000;
const maxCaBytes = 64 * 1024;
const maxEditBytes = 8192;
const editLifetime = 2 * 60 * 1000;
const maxStages = 16;
const reserved = new Set(['__proto__', 'prototype', 'constructor']);
const queryKeys = new Set(['database', 'collection', 'filter', 'projection', 'sort', 'limit']);
const aggregateKeys = new Set(['database', 'collection', 'collectionId', 'pipeline', 'limit']);
const accumulators = new Set(['$sum', '$min', '$max', '$avg', '$first', '$last']);
const uuidPattern = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const editableField = /^[a-z_][a-z0-9_]{0,79}$/i;
const objectIdPattern = /^[a-f0-9]{24}$/i;
const comparisons = new Set(['$eq', '$ne', '$lt', '$lte', '$gt', '$gte']);
const logicalOperators = new Set(['$and', '$or', '$nor']);
const decimal = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?$/;
const integer = /^-?(?:0|[1-9]\d*)$/;
const dnsLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const certificatesPattern = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;
const tlsIdentityErrors = new Set(['ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'CERT_REVOKED',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT']);

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

function localCaPath(value) {
  return validText(value, 4096) && path.isAbsolute(value) && !/^[\\/]{2}/.test(value);
}

function mongoTarget(options) {
  const { host = '127.0.0.1', port = 27017, authSource = 'admin', username, password } = options ?? {};
  const tls = options?.tls;
  if (tls !== undefined) {
    if (!validText(host, 253) || host.includes('%') || !(isIP(host) || host.split('.').every(item => dnsLabel.test(item)))) {
      throw new MongoDbError('Enter the MongoDB server DNS name or IP address from its certificate.');
    }
    if (!exactShape(tls, ['caPath', 'caSha256']) || !localCaPath(tls.caPath) ||
        typeof tls.caSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(tls.caSha256)) {
      throw new MongoDbError('Review the exact local MongoDB CA certificate file before connecting.');
    }
  } else if (host !== '127.0.0.1' && host !== '::1') {
    throw new MongoDbError('Use a numeric loopback MongoDB address, 127.0.0.1 or ::1, or review a verified TLS connection.');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new MongoDbError('Use a MongoDB port from 1 to 65535.');
  if (!validText(username, 256) || !validText(password, 2048)) throw new MongoDbError('Supply a MongoDB username and password.');
  return { host, port, authSource: databaseName(authSource), username, password, ...(tls && { tls: { ...tls } }),
    ...(options?.reviewedEdits === true && { reviewedEdits: true }) };
}

async function readMongoCa(caPath, signal) {
  const invalid = () => new MongoDbError('Choose a local PEM file containing up to eight public CA certificates and at most 64 KiB.',
    'ROCKETBRAIN_MONGO_TLS_CA');
  if (!localCaPath(caPath)) throw invalid();
  let file;
  const buffer = Buffer.alloc(maxCaBytes + 1);
  let total = 0;
  try {
    const resolved = await fs.realpath(caPath);
    if (!localCaPath(resolved)) throw invalid();
    file = await fs.open(resolved, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > maxCaBytes) throw invalid();
    while (total <= maxCaBytes) {
      if (signal?.aborted) throw new MongoDbError('MongoDB operation cancelled.', 'ROCKETBRAIN_MONGO_CANCELLED');
      const { bytesRead } = await file.read(buffer, total, buffer.length - total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total < 1 || total > maxCaBytes) throw invalid();
  } catch (error) {
    if (error instanceof MongoDbError) throw error;
    throw invalid();
  } finally { await file?.close(); }
  const raw = buffer.subarray(0, total), pem = raw.toString('utf8'), entries = pem.match(certificatesPattern);
  if (!entries?.length || entries.length > 8 || pem.replace(certificatesPattern, '').trim()) throw invalid();
  try {
    const certificates = entries.map(entry => new X509Certificate(entry));
    if (certificates.some(cert => !cert.ca)) throw invalid();
    return { entries, sha256: createHash('sha256').update(raw).digest('hex'),
      fingerprints: certificates.map(cert => cert.fingerprint256) };
  } catch { throw invalid(); }
}

async function inspectMongoTlsCa(caPath, { signal } = {}) {
  const { sha256, fingerprints } = await readMongoCa(caPath, signal);
  return { sha256, fingerprints };
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

function aggregationTarget(input) {
  const database = databaseName(input?.database), collection = collectionName(input?.collection);
  if (collection.startsWith('system.')) throw new MongoDbError('Choose an ordinary MongoDB collection.');
  return { database, collection };
}

function resultName(name) {
  fieldName(name);
  if (name.includes('.')) throw new MongoDbError('Use a single field name for the aggregation result.');
}

function fieldReference(value) {
  if (typeof value !== 'string' || !value.startsWith('$')) {
    throw new MongoDbError('Use a MongoDB field reference such as $amount.');
  }
  fieldName(value.slice(1));
}

function validateGroup(group) {
  const fields = Object.entries(group);
  if (!Object.hasOwn(group, '_id') || fields.length > 33) {
    throw new MongoDbError('A $group needs an _id and supports up to 32 accumulator fields.');
  }
  if (group._id !== null) fieldReference(group._id);
  for (const [name, expression] of fields) {
    if (name === '_id') continue;
    resultName(name);
    const [operator] = plainObject(expression) ? Object.keys(expression) : [];
    if (!accumulators.has(operator) || !exactShape(expression, [operator])) {
      throw new MongoDbError('Use one supported accumulator per group result field.');
    }
    if (operator !== '$sum' || expression[operator] !== 1) fieldReference(expression[operator]);
  }
}

function validateProjection(projection) {
  if (Object.keys(projection).length > 64) throw new MongoDbError('A $project supports up to 64 fields.');
  let includes = false, excludes = false;
  for (const [name, expression] of Object.entries(projection)) {
    fieldName(name);
    if (expression === 0) { if (name !== '_id') excludes = true; }
    else {
      if (expression !== 1) fieldReference(expression);
      includes = true;
    }
  }
  if (includes && excludes) throw new MongoDbError('Use either inclusion and field references or exclusion in one $project.');
}

function parseMongoAggregation(source) {
  if (typeof source !== 'string' || Buffer.byteLength(source) > maxQueryBytes) {
    throw new MongoDbError('A MongoDB aggregation document is limited to 64 KiB.');
  }
  let input;
  try { input = JSON.parse(source); }
  catch { throw new MongoDbError('Enter one valid JSON aggregation document.'); }
  if (!plainObject(input) || Object.keys(input).some(key => !aggregateKeys.has(key))) {
    throw new MongoDbError('Use only database, collection, collectionId, pipeline and limit.');
  }
  const target = aggregationTarget(input);
  if (typeof input.collectionId !== 'string' || !uuidPattern.test(input.collectionId)) {
    throw new MongoDbError('Open an aggregation editor for the observed MongoDB collection.');
  }
  const limit = input.limit === undefined ? 50 : input.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > maxDocuments) throw new MongoDbError('Use a preview limit from 1 to 200.');
  if (!Array.isArray(input.pipeline) || input.pipeline.length < 1 || input.pipeline.length > maxStages) {
    throw new MongoDbError('Use a pipeline with one to 16 stages.');
  }
  const count = scope();
  const pipeline = input.pipeline.map(value => {
    const [stage] = plainObject(value) ? Object.keys(value) : [];
    if (!stage || !exactShape(value, [stage])) throw new MongoDbError('Give each MongoDB stage a single operator.');
    const argument = value[stage];
    if (stage === '$count') resultName(argument);
    else if (stage === '$limit') {
      if (!Number.isInteger(argument) || argument < 1 || argument > maxDocuments) {
        throw new MongoDbError('Use a $limit from 1 to 200.');
      }
    } else {
      if (!plainObject(argument) || !Object.keys(argument).length && stage !== '$match') {
        throw new MongoDbError('Give the aggregation stage an object with supported fields.');
      }
      switch (stage) {
        case '$match':
          checkFilter(argument, 0, count);
          try { return { $match: BSON.EJSON.deserialize(argument, { relaxed: false }) }; }
          catch { throw new MongoDbError('The $match contains an invalid Extended JSON value.'); }
        case '$project': validateProjection(argument); break;
        case '$group': validateGroup(argument); break;
        case '$sort': fieldOptions(argument, [-1, 1], 16, 'Sort'); break;
        default: throw new MongoDbError('Use $match, $project, $group, $sort, $limit or $count for a read-only MongoDB aggregation.');
      }
    }
    return value;
  });
  return { ...target, collectionId: input.collectionId.toLowerCase(), pipeline, limit };
}

function mongoScalar(value) {
  if (value === null) return { type: 'null', value };
  if (typeof value === 'boolean') return { type: 'bool', value };
  if (value instanceof BSON.Int32) return { type: 'int', value };
  if (value instanceof BSON.Long && value._bsontype === 'Long') return { type: 'long', value };
  if (typeof value === 'string' && Buffer.byteLength(value) <= maxEditBytes && !value.includes('\0') &&
      Buffer.from(value).toString('utf8') === value) return { type: 'string', value };
  return null;
}

function parseMongoEditValue(source) {
  const invalid = () => new MongoDbError('Enter one JSON string, boolean, null or canonical BSON integer value.');
  if (typeof source !== 'string' || Buffer.byteLength(source) > maxEditBytes + 128) throw invalid();
  let value;
  try { value = JSON.parse(source); }
  catch { throw invalid(); }
  if (typeof value === 'number' || (plainObject(value) &&
      (!typedLiteral(value) || !Object.keys(value).every(key => key === '$numberInt' || key === '$numberLong')))) throw invalid();
  const scalar = mongoScalar(plainObject(value) ? BSON.EJSON.deserialize(value, { relaxed: false }) : value);
  if (!scalar) throw invalid();
  return scalar;
}

function previewValue(scalar) {
  return BSON.EJSON.serialize({ value: scalar.value }, { relaxed: false }).value;
}

function noEdit(message) { return new MongoDbError(message, 'ROCKETBRAIN_MONGO_EDIT'); }
function staleEdit() {
  return new MongoDbError('The MongoDB field or collection changed. Inspect the current document and review it again.', 'ROCKETBRAIN_MONGO_STALE');
}

function safeError(error, signal) {
  if (signal?.aborted) return new MongoDbError('MongoDB operation cancelled or timed out.', 'ROCKETBRAIN_MONGO_CANCELLED');
  if (error instanceof MongoDbError) return error;
  for (let cause = error, depth = 0; cause && depth < 5; cause = cause.cause, depth++) {
    if (tlsIdentityErrors.has(cause.code)) {
      return new MongoDbError('MongoDB did not verify the server certificate or its host name.', 'ROCKETBRAIN_MONGO_TLS_IDENTITY');
    }
  }
  const code = error?.code instanceof BSON.Int32 ? error.code.valueOf() : error?.code;
  switch (code) {
    case 13: return new MongoDbError('The MongoDB account cannot read this database or collection.', 'ROCKETBRAIN_MONGO_FORBIDDEN');
    case 18: return new MongoDbError('MongoDB rejected the connection credentials.', 'ROCKETBRAIN_MONGO_AUTH');
    case 50: return new MongoDbError('MongoDB reached the read time limit.', 'ROCKETBRAIN_MONGO_TIMEOUT');
    case 361: return new MongoDbError('The selected MongoDB collection changed. Open a new aggregation editor.', 'ROCKETBRAIN_MONGO_STALE');
    default: return new MongoDbError('MongoDB could not complete the operation. Check the server and connection or query settings.', 'ROCKETBRAIN_MONGO_READ');
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

async function collectDocuments(cursor, limit) {
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
  return { documents, encoding: 'canonical-extended-json', truncated: truncated ?? null };
}

async function observeCollection(db, collection, signal) {
  const cursor = db.listCollections({ name: collection }, { nameOnly: false, batchSize: 2, maxTimeMS, signal });
  try {
    const item = await cursor.next();
    const id = item?.info?.uuid;
    if (item?.name !== collection || item.type !== 'collection' ||
        !(id instanceof BSON.Binary) || id.sub_type !== BSON.Binary.SUBTYPE_UUID || id.length() !== 16) {
      throw new MongoDbError('Choose an ordinary MongoDB collection with visible identity metadata.', 'ROCKETBRAIN_MONGO_AGGREGATE_SCOPE');
    }
    return { uuid: new BSON.UUID(id.buffer.subarray(0, 16)), options: item.options ?? {},
      settingsSha256: createHash('sha256').update(BSON.serialize({ options: item.options ?? {}, idIndex: item.idIndex ?? null })).digest('hex') };
  } finally { await closeCursor(cursor); }
}

async function readEditableDocument(db, target, identity, signal) {
  const { uuid, settingsSha256, options } = await observeCollection(db, target.collection, signal);
  if (options.capped || options.timeseries || options.encryptedFields || options.clusteredIndex) {
    throw noEdit('Choose an ordinary collection for a reviewed edit.');
  }
  const cursor = db.runCursorCommand({ aggregate: target.collection, collectionUUID: uuid,
    pipeline: [{ $match: { _id: identity } }, { $limit: 1 }], cursor: { batchSize: 1 }, maxTimeMS, allowDiskUse: false },
  { promoteValues: false, signal });
  try {
    const document = await cursor.next();
    if (!document || !(document._id instanceof BSON.ObjectId) || !document._id.equals(identity) ||
        BSON.calculateObjectSize(document) > maxDocumentBytes) throw noEdit('Choose a visible ObjectId document within the editable size limit.');
    const fields = new Map();
    for (const [name, value] of Object.entries(document)) {
      if (name === '_id' || reserved.has(name) || !editableField.test(name)) continue;
      const scalar = mongoScalar(value);
      if (scalar) fields.set(name, scalar);
      if (fields.size >= 64) break;
    }
    if (!fields.size) throw noEdit('The document has no supported top-level scalar fields.');
    return { ...target, uuid, settingsSha256, identity, fields };
  } finally { await closeCursor(cursor); }
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
  const { host, port, authSource, username, password, tls, reviewedEdits } = mongoTarget(configuration);
  const endpoint = `mongodb://${isIP(host) === 6 ? '[' + host + ']' : host}:${port}`;
  let secureContext;
  if (tls) {
    const ca = await readMongoCa(tls.caPath, signal);
    if (ca.sha256 !== tls.caSha256) throw new MongoDbError('The MongoDB CA changed after approval. Review the current certificate file.',
      'ROCKETBRAIN_MONGO_TLS_CA_CHANGED');
    secureContext = createSecureContext({ ca: ca.entries, minVersion: 'TLSv1.2' });
  }
  const client = new MongoClient(endpoint, { auth: { username, password }, authSource,
    authMechanism: 'SCRAM-SHA-256', directConnection: true, appName: 'Rocketbrain',
    serverSelectionTimeoutMS: maxTimeMS, connectTimeoutMS: maxTimeMS, socketTimeoutMS: 8000,
    waitQueueTimeoutMS: maxTimeMS, maxPoolSize: 2, retryReads: false, retryWrites: false, ...(secureContext && {
      tls: true, secureContext, tlsAllowInvalidCertificates: false, tlsAllowInvalidHostnames: false
    }) });
  const lifetime = new AbortController();
  const editSnapshots = new Map();
  const editReviews = new Map();
  let running = false;
  let closing;
  function close() {
    lifetime.abort();
    editSnapshots.clear();
    editReviews.clear();
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

  function requireEditApproval() {
    if (!reviewedEdits || lifetime.signal.aborted) throw noEdit('Open a MongoDB connection explicitly approved for reviewed field edits.');
  }

  function keepReview(map, id, value) {
    while (map.size >= 8) map.delete(map.keys().next().value);
    map.set(id, { ...value, expires: Date.now() + editLifetime });
  }

  function prepareEdit(snapshotId, field, newValue) {
    requireEditApproval();
    const snapshot = editSnapshots.get(snapshotId);
    const before = snapshot?.fields.get(field);
    if (!snapshot || snapshot.expires <= Date.now() || !before) throw noEdit('Inspect the current MongoDB document and select an observed editable field.');
    const after = parseMongoEditValue(newValue);
    const previous = previewValue(before), replacement = previewValue(after);
    if (JSON.stringify(previous) === JSON.stringify(replacement)) throw noEdit('Enter a changed BSON value.');
    const id = randomUUID();
    keepReview(editReviews, id, { snapshotId, field, before, after });
    return { id, database: snapshot.database, collection: snapshot.collection, collectionId: snapshot.uuid.toHexString(),
      objectId: snapshot.identity.toHexString(), field, before: previous, after: replacement, beforeType: before.type, afterType: after.type };
  }

  function applyEdit(id, approved, options) {
    let dispatched = false;
    return use(async request => {
      requireEditApproval();
      const review = editReviews.get(id), snapshot = review && editSnapshots.get(review.snapshotId);
      if (approved !== true || !snapshot || review.expires <= Date.now() || snapshot.expires <= Date.now()) {
        throw noEdit('Inspect and explicitly approve the exact current MongoDB edit.');
      }
      editReviews.delete(id);
      editSnapshots.delete(review.snapshotId);
      const db = client.db(snapshot.database);
      const live = await observeCollection(db, snapshot.collection, request);
      if (!live.uuid.equals(snapshot.uuid) || live.settingsSha256 !== snapshot.settingsSha256) throw staleEdit();
      request.throwIfAborted();
      const current = '$' + review.field;
      const query = { _id: snapshot.identity, $expr: { $and: [
        { $eq: [{ $type: current }, review.before.type] }, { $eq: [current, { $literal: review.before.value }] }
      ] } };
      dispatched = true;
      const response = await db.command({ update: snapshot.collection, collectionUUID: snapshot.uuid,
        updates: [{ q: query, u: { $set: { [review.field]: review.after.value } }, collation: { locale: 'simple' }, multi: false, upsert: false }],
        ordered: true, bypassDocumentValidation: false, writeConcern: { w: 1, j: true }, maxTimeMS }, { signal: request });
      const error = response.writeErrors?.[0];
      if (error?.code === 361 || response.n === 0 && !error && !response.writeConcernError) throw staleEdit();
      if (error) throw new MongoDbError('MongoDB declined the reviewed field update.', 'ROCKETBRAIN_MONGO_EDIT_REFUSED');
      if (response.writeConcernError || response.n !== 1 || response.nModified !== 1 || response.upserted?.length) {
        throw new MongoDbError('MongoDB did not confirm the single-field write.', 'ROCKETBRAIN_MONGO_EDIT_UNCONFIRMED');
      }
      return { acknowledged: true, objectId: snapshot.identity.toHexString(), field: review.field,
        value: previewValue(review.after), type: review.after.type };
    }, options).catch(error => {
      if (error.code === 'ROCKETBRAIN_MONGO_STALE') throw staleEdit();
      if (!dispatched || ['ROCKETBRAIN_MONGO_FORBIDDEN', 'ROCKETBRAIN_MONGO_EDIT_REFUSED'].includes(error.code)) throw error;
      throw new MongoDbError('MongoDB did not confirm the result. Inspect the current document before making another edit.',
        'ROCKETBRAIN_MONGO_EDIT_UNCONFIRMED');
    });
  }

  return {
    source: Object.freeze({ host, port, authSource, ...(tls && { transport: 'tls-verified', caSha256: tls.caSha256 }),
      ...(reviewedEdits && { reviewedEdits: true }) }),
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
      return { database, collection, ...await collectDocuments(cursor, limit) };
    }, options),
    inspectAggregation: (input, options) => use(async request => {
      const target = aggregationTarget(input);
      const { uuid } = await observeCollection(client.db(target.database), target.collection, request);
      return { ...target, collectionId: uuid.toHexString() };
    }, options),
    aggregate: (source, options) => use(async request => {
      const { database, collection, collectionId, pipeline, limit } = parseMongoAggregation(source);
      const db = client.db(database);
      const { uuid } = await observeCollection(db, collection, request);
      if (uuid.toHexString() !== collectionId) {
        throw new MongoDbError('The selected MongoDB collection changed. Open a new aggregation editor.', 'ROCKETBRAIN_MONGO_STALE');
      }
      const cursor = db.runCursorCommand({ aggregate: collection, collectionUUID: uuid, pipeline: [...pipeline, { $limit: limit + 1 }],
        cursor: { batchSize: 10 }, maxTimeMS, allowDiskUse: false }, { promoteValues: false, signal: request }).setBatchSize(10);
      return { database, collection, collectionId, kind: 'aggregation', stages: pipeline.map(stage => Object.keys(stage)[0]),
        ...await collectDocuments(cursor, limit) };
    }, options),
    inspectDocumentEdit: (input, options) => use(async request => {
      requireEditApproval();
      const target = aggregationTarget(input);
      if (typeof input.objectId !== 'string' || !objectIdPattern.test(input.objectId)) throw noEdit('Enter the document ObjectId from Find.');
      const snapshot = await readEditableDocument(client.db(target.database), target, new BSON.ObjectId(input.objectId), request);
      const id = randomUUID();
      keepReview(editSnapshots, id, snapshot);
      return { ...target, id, objectId: snapshot.identity.toHexString(), collectionId: snapshot.uuid.toHexString(),
        fields: [...snapshot.fields].map(([name, scalar]) => ({ name, type: scalar.type, value: previewValue(scalar) })) };
    }, options),
    prepareEdit,
    applyEdit
  };
}

module.exports = { openMongoDb, parseMongoFind, parseMongoAggregation, parseMongoEditValue, mongoTarget, inspectMongoTlsCa, MongoDbError };
