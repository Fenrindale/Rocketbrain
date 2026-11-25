'use strict';

const { createHash } = require('node:crypto');
const { identifier } = require('./schema-rename');
const { searchInventory, loadSource } = require('./object-source');

const limits = Object.freeze({ schemas: 8, names: 200, definitions: 120, ddlBytes: 4 * 1024 * 1024,
  files: 250, fileBytes: 256 * 1024, totalFileBytes: 8 * 1024 * 1024, matchesPerSource: 3, resultsPerGroup: 150, dbTimeMs: 12000 });
const textHash = text => createHash('sha256').update(text).digest('hex');
const qualified = object => object.kind === 'schema' ? object.schema :
  [object.schema, object.owner?.name, object.name].filter(Boolean).join('.');

function normalizeTerm(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 128 || /[\x00-\x1f\x7f]/.test(value)) {
    throw Error('Enter a literal search term between 1 and 128 characters.');
  }
  return value.trim();
}

function matches(text, term, max = limits.matchesPerSource) {
  const needle = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const options = new RegExp(needle, 'giu');
  const found = [];
  for (const item of text.matchAll(options)) {
    if (found.length === max) return { found, extra: true };
    const start = item.index;
    const end = start + item[0].length;
    const lineStart = text.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
    const approximateStart = Math.max(lineStart, start - 45);
    const lineEnd = text.indexOf('\n', start);
    const snippet = text.slice(approximateStart, Math.min(lineEnd < 0 ? text.length : lineEnd, approximateStart + 160))
      .replace(/[\r\n\t\u202a-\u202e\u2066-\u2069]/g, ' ').trim();
    found.push({ start, end, snippet });
  }
  return { found, extra: false };
}

function pushLimited(target, extra, item) {
  if (target.length < limits.resultsPerGroup) target.push(item);
  else extra.count++;
}

function sourceIssue(code) {
  switch (code) {
    case 'ROCKETBRAIN_OBJECT_SOURCE_PERMISSION': return 'permission';
    case 'ROCKETBRAIN_OBJECT_SOURCE_UNAVAILABLE': return 'changed';
    case 'ROCKETBRAIN_OBJECT_SOURCE_SIZE': return 'too-large';
    case 'ROCKETBRAIN_OBJECT_SOURCE_DEFINITION': return 'definition-format';
    default: return 'read-failed';
  }
}

async function searchDatabaseText(query, context, options, assertCurrent = () => {}) {
  const term = normalizeTerm(options?.term);
  const requested = options?.schemas ?? [context.database];
  if (!Array.isArray(requested) || !requested.length || requested.length > limits.schemas || new Set(requested).size !== requested.length) {
    throw Error('Choose one to eight different live schemas.');
  }
  const schemas = requested.map(schema => identifier(schema, { table: true }));
  const deadline = Date.now() + limits.dbTimeMs;
  const { rows } = await query('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE CAST(SCHEMA_NAME AS BINARY) IN (' +
    schemas.map(() => 'CAST(? AS BINARY)').join(',') + ')', schemas);
  assertCurrent();
  const visible = new Set(rows.map(([name]) => name));
  const scannedSchemas = schemas.filter(name => visible.has(name));
  const coverage = { dialect: context.dialect, activeSchema: context.database, scopes: scannedSchemas,
    unavailableSchemas: schemas.filter(name => !visible.has(name)), inventoryLimited: false, namesLimited: false,
    unsupportedNames: 0, inspectedDefinitions: 0, totalDefinitionBytes: 0, timeLimited: false, sizeLimited: false,
    sourceLimited: false, extraResults: 0, unreadDefinitions: [], accountVisibleOnly: true };
  const names = [], ddl = [];
  if (!scannedSchemas.length) return { names, ddl, coverage };

  const inventory = await searchInventory(query, context, { schemas: scannedSchemas, term, limit: limits.names });
  coverage.namesLimited = inventory.limited;
  coverage.unsupportedNames += inventory.unsupported;
  const extra = { count: 0 };
  for (const object of inventory.items) pushLimited(names, extra, { type: 'database-name', label: qualified(object), object });
  assertCurrent();
  if (options?.includeDdl === false) {
    coverage.sourceSkipped = true;
    coverage.extraResults = extra.count;
    return { names, ddl, coverage };
  }

  const definitions = await searchInventory(query, context, { schemas: scannedSchemas, limit: limits.definitions });
  const targets = new Map();
  for (const object of [...inventory.items.map(item => item.owner ?? item), ...definitions.items]) {
    targets.set(JSON.stringify([object.kind, object.schema, object.name]), object);
  }
  coverage.inventoryLimited = definitions.limited || targets.size > limits.definitions;
  coverage.unsupportedNames += definitions.unsupported;
  for (const object of [...targets.values()].slice(0, limits.definitions)) {
    assertCurrent();
    if (Date.now() >= deadline) { coverage.timeLimited = true; break; }
    if (coverage.totalDefinitionBytes >= limits.ddlBytes) { coverage.sizeLimited = true; break; }
    let source;
    try { ({ source } = await loadSource(query, context, object)); }
    catch (error) {
      assertCurrent();
      coverage.unreadDefinitions.push({ object, reason: sourceIssue(error.code) });
      continue;
    }
    assertCurrent();
    const size = Buffer.byteLength(source);
    if (coverage.totalDefinitionBytes + size > limits.ddlBytes) { coverage.sizeLimited = true; break; }
    coverage.totalDefinitionBytes += size;
    coverage.inspectedDefinitions++;
    const { found, extra: more } = matches(source, term);
    if (more) coverage.sourceLimited = true;
    if (found.length) {
      const hash = textHash(source);
      for (const span of found) pushLimited(ddl, extra, { type: 'database-ddl', label: qualified(object), object, hash, ...span });
    }
  }
  coverage.extraResults = extra.count;
  return { names, ddl, coverage };
}

module.exports = { limits, normalizeTerm, matches, textHash, qualified, pushLimited, searchDatabaseText };
