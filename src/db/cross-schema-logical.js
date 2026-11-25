'use strict';

const { identifier } = require('./schema-rename');
const { sourceServer, describeSource } = require('./sql-related-source');
const { columnKind } = require('./grid');
const { exact, label } = require('./schema-erd');

const crossLogicalKey = 'rocketbrain.schemaDiagram.crossSchemaLogical.v1';
const maxCrossLogical = 16;
const maxPairs = 8;
const maxSchemas = 64;
const maxTables = 128;
const allowed = new Set(['integer', 'decimal', 'datetime', 'text', 'binary']);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fingerprint = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const key = value => JSON.stringify([value.schema, value.table]);
const routeTables = new Set(['mysql', 'information_schema', 'performance_schema', 'sys']);

function endpoint(value) {
  if (!exact(value, ['schema', 'table'])) throw Error('Choose a schema-qualified table.');
  const schema = identifier(value.schema, { table: true }), table = identifier(value.table, { table: true });
  if (routeTables.has(schema.toLowerCase()) || /^__rb_/iu.test(table)) throw Error('Choose a visible application table.');
  return { schema, table };
}

function relationIntent(value) {
  if (!exact(value, ['name', 'child', 'parent', 'pairs']) || !label(value.name, 80) || value.name !== value.name.trim() ||
      !Array.isArray(value.pairs) || !value.pairs.length || value.pairs.length > maxPairs) {
    throw Error('Choose a relationship name and between one and eight ordered column pairs.');
  }
  const child = endpoint(value.child), parent = endpoint(value.parent);
  if (child.schema === parent.schema) throw Error('Choose two different schemas for this logical relationship.');
  const pairs = value.pairs.map(pair => {
    if (!exact(pair, ['child', 'parent'])) throw Error('Choose an exact column on both endpoint tables.');
    return { child: identifier(pair.child), parent: identifier(pair.parent) };
  });
  if (['child', 'parent'].some(side => new Set(pairs.map(pair => pair[side])).size !== pairs.length)) {
    throw Error('Each endpoint column must appear once in the logical relationship.');
  }
  return { name: value.name, child, parent, pairs };
}

function compatibleColumns(child, parent) {
  if (!child || !parent || child.type.toLowerCase() !== parent.type.toLowerCase() ||
      child.charset !== parent.charset || child.collation !== parent.collation) return false;
  const kind = columnKind(child.type);
  return allowed.has(kind) && (kind !== 'binary' || /^(?:VAR)?BINARY\(/iu.test(child.type));
}

function validateDefinition(intent, child, parent) {
  if (!child || !parent || !same(intent.pairs.map(pair => pair.parent), parent.primary)) {
    throw Error('Use two visible InnoDB tables and map every parent primary-key column in its observed order.');
  }
  if (intent.pairs.some(pair => !compatibleColumns(child.columns.find(column => column.name === pair.child),
    parent.columns.find(column => column.name === pair.parent)))) {
    throw Error('Each logical key pair needs compatible, exact types and character collations.');
  }
}

function readSaved(value) {
  if (!exact(value, ['id', 'name', 'child', 'parent', 'pairs', 'server', 'definitions']) || !label(value.id) ||
      !fingerprint(value.server) || !Array.isArray(value.definitions) || value.definitions.length !== 2 ||
      !value.definitions.every(fingerprint)) return null;
  try {
    return { id: value.id, ...relationIntent({ name: value.name, child: value.child, parent: value.parent, pairs: value.pairs }),
      server: value.server, definitions: value.definitions };
  } catch { return null; }
}

function sameMapping(a, b) {
  return key(a.child) === key(b.child) && key(a.parent) === key(b.parent) && same(a.pairs, b.pairs);
}

async function visibleEndpoint(query, _activeDatabase, request = {}) {
  if (!Object.hasOwn(request, 'schema')) {
    const { rows } = await query('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA ' +
      "WHERE SCHEMA_NAME NOT IN ('mysql','information_schema','performance_schema','sys') ORDER BY BINARY SCHEMA_NAME LIMIT " + (maxSchemas + 1));
    if (rows.length > maxSchemas) throw Error('The visible schema inventory exceeds 64 schemas.');
    return { schemas: rows.map(([schema]) => identifier(schema, { table: true })) };
  }
  if (Object.hasOwn(request, 'table')) {
    const target = endpoint(request), definition = await describeSource(query, target);
    if (!definition) throw Error('Choose a visible InnoDB table with a supported primary key.');
    return { ...target, columns: definition.columns, primary: definition.primary };
  }
  const schema = identifier(request.schema, { table: true });
  if (routeTables.has(schema.toLowerCase())) throw Error('Choose a visible application schema.');
  const { rows } = await query("SELECT TABLE_NAME FROM information_schema.TABLES WHERE BINARY TABLE_SCHEMA=BINARY ? AND TABLE_TYPE='BASE TABLE' " +
    "AND ENGINE='InnoDB' AND LEFT(TABLE_NAME,5)<>'__rb_' ORDER BY BINARY TABLE_NAME LIMIT " + (maxTables + 1), [schema]);
  if (rows.length > maxTables) throw Error('The visible table inventory exceeds 128 tables for this schema.');
  return { schema, tables: rows.map(([table]) => identifier(table, { table: true })) };
}

async function physicalMapping(query, intent) {
  const { parent, child } = intent;
  const { rows } = await query('SELECT CONSTRAINT_NAME,COLUMN_NAME,REFERENCED_COLUMN_NAME,ORDINAL_POSITION FROM information_schema.KEY_COLUMN_USAGE ' +
    'WHERE BINARY TABLE_SCHEMA=BINARY ? AND BINARY TABLE_NAME=BINARY ? AND BINARY REFERENCED_TABLE_SCHEMA=BINARY ? ' +
    'AND BINARY REFERENCED_TABLE_NAME=BINARY ? ORDER BY BINARY CONSTRAINT_NAME,ORDINAL_POSITION LIMIT 257',
  [child.schema, child.table, parent.schema, parent.table]);
  if (rows.length >= 257) throw Error('The physical relationship inventory exceeds the review limit.');
  const groups = new Map();
  for (const [name, child, parent] of rows) {
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push({ child, parent });
  }
  return [...groups.values()].some(pairs => same(pairs, intent.pairs));
}

async function inspectCrossLogical(query, _activeDatabase, value) {
  const intent = relationIntent(value), server = await sourceServer(query);
  const child = await describeSource(query, intent.child), parent = await describeSource(query, intent.parent);
  validateDefinition(intent, child, parent);
  if (await physicalMapping(query, intent)) throw Error('This mapping already exists as a physical foreign key.');
  if (await sourceServer(query) !== server) throw Error('The physical server or account changed during relationship review.');
  return { ...intent, server, definitions: [child.fingerprint, parent.fingerprint] };
}

async function visibleCrossEdges(query, origin, values) {
  if (!Array.isArray(values) || values.length > maxCrossLogical) return [];
  const approved = values.map(readSaved).filter(value => value && [key(value.child), key(value.parent)].includes(key(origin)));
  if (!approved.length) return [];
  const server = await sourceServer(query), cache = new Map(), edges = [];
  async function definition(target) {
    const id = key(target);
    if (!cache.has(id)) {
      try { cache.set(id, await describeSource(query, target)); }
      catch (cause) {
        if (!['ER_ACCESS_DENIED_ERROR', 'ER_TABLEACCESS_DENIED_ERROR', 'ER_DBACCESS_DENIED_ERROR', 'ER_NO_SUCH_TABLE'].includes(cause.code)) throw cause;
        cache.set(id, null);
      }
    }
    return cache.get(id);
  }
  for (const candidate of approved) {
    if (candidate.server !== server) continue;
    const child = await definition(candidate.child), parent = await definition(candidate.parent);
    if (!child || !parent || !same([child.fingerprint, parent.fingerprint], candidate.definitions)) continue;
    edges.push({ id: candidate.id, name: candidate.name, kind: 'logical', child: candidate.child, parent: candidate.parent, sourceServer: server,
      parts: candidate.pairs.map((pair, index) => ({ column: pair.child, foreignColumn: pair.parent, ordinal: index + 1 })) });
  }
  return edges;
}

module.exports = { crossLogicalKey, maxCrossLogical, maxPairs, compatibleColumns, relationIntent, sameMapping, readSaved,
  visibleEndpoint, inspectCrossLogical, visibleCrossEdges };
