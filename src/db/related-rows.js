'use strict';

const { columnKind } = require('./grid');
const { visibleCrossEdges } = require('./cross-schema-logical');

const supportedKeys = new Set(['integer', 'decimal', 'float', 'datetime', 'text', 'binary']);
const maxRelations = 32;
const maxParts = 16;
const maxColumns = 512;
const endpointKey = ({ schema, table }) => JSON.stringify([schema, table]);
const validName = name => typeof name === 'string' && name.length > 0 && name.length <= 64 && !name.includes('\0');

function edgeFromPhysical(rows, origin) {
  const all = new Map(), source = endpointKey(origin);
  for (const [schema, table, name, column, ordinal, foreignSchema, foreignTable, foreignColumn] of rows) {
    if (![schema, table, name, column, foreignSchema, foreignTable, foreignColumn].every(validName)) continue;
    const child = { schema, table }, parent = { schema: foreignSchema, table: foreignTable };
    if (endpointKey(child) !== source && endpointKey(parent) !== source) continue;
    const key = JSON.stringify([schema, table, name]);
    if (!all.has(key)) all.set(key, { id: name, name, child, parent, parts: [], kind: 'physical' });
    const edge = all.get(key);
    if (endpointKey(edge.parent) !== endpointKey(parent)) throw Error('The visible foreign key changed during discovery.');
    edge.parts.push({ column, foreignColumn, ordinal: Number(ordinal) });
  }
  return [...all.values()];
}

function edgeFromLogical(records, origin) {
  return records.filter(edge => edge.child === origin.table || edge.parent === origin.table).map(edge => ({
    id: edge.id, name: edge.name, kind: 'logical', child: { schema: origin.schema, table: edge.child },
    parent: { schema: origin.schema, table: edge.parent }, parts: edge.pairs.map(({ child, parent }, index) =>
      ({ column: child, foreignColumn: parent, ordinal: index + 1 }))
  }));
}

async function observeTable(query, endpoint) {
  const values = [endpoint.schema, endpoint.table];
  const { rows } = await query('SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE, ENGINE FROM information_schema.TABLES ' +
    'WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? LIMIT 2', values);
  if (rows.length !== 1 || rows[0][0] !== endpoint.schema || rows[0][1] !== endpoint.table || rows[0][2] !== 'BASE TABLE' ||
      String(rows[0][3]).toUpperCase() !== 'INNODB') return null;
  const observed = await query('SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, CHARACTER_SET_NAME, COLLATION_NAME ' +
    'FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION LIMIT ' + (maxColumns + 1), values);
  if (observed.truncated || observed.rows.length > maxColumns || observed.rows.some(([schema, table]) =>
    schema !== endpoint.schema || table !== endpoint.table)) return null;
  return new Map(observed.rows.map(([, , name, type, charset, collation]) => [name, { type, charset, collation }]));
}

async function readRelatedCatalog(query, _activeDatabase, { schema, table, logical = [], crossLogical = [] }) {
  if (![schema, table].every(validName)) throw Error('Choose a saved table preview for related-row navigation.');
  const origin = { schema, table }, source = endpointKey(origin);
  const limit = maxRelations * maxParts + 1;
  const physical = await query('SELECT TABLE_SCHEMA, TABLE_NAME, CONSTRAINT_NAME, COLUMN_NAME, ORDINAL_POSITION, ' +
    'REFERENCED_TABLE_SCHEMA, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE ' +
    'WHERE REFERENCED_TABLE_NAME IS NOT NULL AND ((TABLE_SCHEMA = ? AND TABLE_NAME = ?) OR ' +
    '(REFERENCED_TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME = ?)) ' +
    'ORDER BY TABLE_SCHEMA, TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION LIMIT ' + limit, [schema, table, schema, table]);
  if (physical.truncated || physical.rows.length >= limit) throw Error('Too many related tables are visible for this preview.');
  const edges = [...edgeFromPhysical(physical.rows, origin), ...edgeFromLogical(logical, origin),
    ...await visibleCrossEdges(query, origin, crossLogical)];
  if (edges.length > maxRelations) throw Error('Too many related tables are visible for this preview.');
  const tables = new Map([[source, await observeTable(query, origin)]]);
  for (const edge of edges) {
    for (const endpoint of [edge.child, edge.parent]) {
      const key = endpointKey(endpoint);
      if (!tables.has(key)) tables.set(key, await observeTable(query, endpoint));
    }
  }
  return { source, edges, tables };
}

function compatible(left, right, kind, logical) {
  if (!right || columnKind(right.type) !== kind || !supportedKeys.has(kind)) return false;
  if (kind === 'text') return left.charset === right.charset && left.collation === right.collation;
  if (kind === 'binary') return /^(?:var)?binary\(\d+\)$/i.test(left.type) && left.type.toLowerCase() === right.type.toLowerCase();
  return !logical || left.type.toLowerCase() === right.type.toLowerCase();
}

function relatedRowsFromObservation(catalog, names, row, definitions) {
  const sourceColumns = catalog.tables.get(catalog.source);
  if (!sourceColumns || !Array.isArray(row) || row.length !== names.length || new Set(names).size !== names.length) {
    throw Error('Choose a row from a current base-table preview.');
  }
  const cells = new Map(names.map((column, index) => [column, row[index]]));
  const captured = definitions && new Map(definitions.map(column => [column.name, column]));
  const matches = [];
  function relation(edge, direction) {
    const inbound = direction === 'referencing';
    const target = inbound ? edge.child : edge.parent;
    const targetColumns = catalog.tables.get(endpointKey(target));
    if (!targetColumns || !edge.parts.length || edge.parts.length > maxParts) return;
    const path = [...edge.parts].sort((left, right) => left.ordinal - right.ordinal);
    const filters = [], bindings = [], keys = [];
    for (const [index, part] of path.entries()) {
      if (part.ordinal !== index + 1) return;
      const from = inbound ? part.foreignColumn : part.column;
      const to = inbound ? part.column : part.foreignColumn;
      const left = sourceColumns.get(from), right = targetColumns.get(to), value = cells.get(from);
      const kind = left && columnKind(left.type);
      const old = captured?.get(from);
      if (captured && (!old || old.type !== left?.type || old.charset !== left?.charset || old.collation !== left?.collation)) return;
      if (value == null || !left || !compatible(left, right, kind, edge.kind === 'logical') ||
          (typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value))) ||
          (kind === 'integer' && typeof value === 'number' && !Number.isSafeInteger(value))) return;
      const text = String(value);
      if (Buffer.byteLength(text) > 4096 || kind === 'binary' && !/^0x(?:[\da-f]{2})*$/i.test(text)) return;
      filters.push({ column: to, operator: 'eq', value: { kind: 'value', text } });
      bindings.push([from, left.type, left.collation, to, right.type, right.collation]);
      keys.push({ name: to, ...right });
    }
    if (new Set(filters.map(filter => filter.column)).size !== filters.length) return;
    const key = JSON.stringify([catalog.source, endpointKey(target), direction, edge.kind, edge.id, bindings]);
    const label = target.schema + '.' + target.table + ' · ' + edge.name;
    matches.push({ key, label, ...target, direction, kind: edge.kind, columns: bindings.map(([from,,,to]) => [from,to]), filters, keys,
      ...(edge.sourceServer && { sourceServer: edge.sourceServer }) });
  }
  for (const edge of catalog.edges) {
    if (endpointKey(edge.child) === catalog.source) relation(edge, 'referenced');
    if (endpointKey(edge.parent) === catalog.source) relation(edge, 'referencing');
  }
  return matches.sort((left, right) => left.label.localeCompare(right.label) || left.direction.localeCompare(right.direction));
}

function relatedRows(catalog, sourceName, names, row) {
  if (!['tables', 'columns', 'foreignKeys'].every(area => catalog?.coverage?.[area] === 'loaded')) {
    throw Error('Refresh the active schema with visible foreign keys before following a relation.');
  }
  const schema = catalog.database;
  const available = catalog.tables.filter(table => table.kind === 'table');
  const tables = new Map(available.map(({ name: table, columns }) => [
    endpointKey({ schema, table }), new Map(columns.map(column => [column.name, column]))
  ]));
  const keys = available.flatMap(({ name, foreignKeys = [] }) => foreignKeys
    .filter(fk => fk.referencedSchema === schema && Array.isArray(fk.columns))
    .flatMap(fk => fk.columns.map(part => [schema, name, fk.name, part.name, part.ordinal,
      schema, fk.referencedTable, part.referencedColumn])));
  const origin = { schema, table: sourceName };
  const matches = relatedRowsFromObservation({ source: endpointKey(origin), edges: edgeFromPhysical(keys, origin), tables }, names, row);
  if (matches.length > 200) throw Error('Too many related tables are visible for this preview.');
  return matches.map(({ key: observed, table, direction, columns, filters }) => {
    const [,,,, foreignKey, bindings] = JSON.parse(observed);
    const key = JSON.stringify([schema, sourceName, table, direction, foreignKey,
      bindings.map(([from, left,, to, right]) => [from, left, to, right])]);
    return { key, label: table + ' · ' + foreignKey, table, direction, columns, filters };
  });
}

module.exports = { readRelatedCatalog, relatedRows, relatedRowsFromObservation };
