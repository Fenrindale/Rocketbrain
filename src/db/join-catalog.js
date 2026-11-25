'use strict';

const maxSources = 8;
const maxTables = 40;
const maxParts = 16;
const maxRows = 4096;
const maxForeignKeys = 64;
const validName = value => typeof value === 'string' && value.length > 0 && value.length <= 64 && !/[\x00-\x1f\x7f]/.test(value);
const endpointKey = ({ schema, table }) => JSON.stringify([schema, table]);
const endpoint = value => value && validName(value.schema) && validName(value.table);
const tupleFilter = (schema, table, count) => '(' + schema + ',' + table + ') IN (' + Array(count).fill('(?,?)').join(',') + ')';

async function readJoinCatalog(query, _activeDatabase, { endpoints, includeEdges = true } = {}) {
  if (!Array.isArray(endpoints) || !endpoints.length || endpoints.length > maxSources || !endpoints.every(endpoint)) {
    throw Error('Choose at most eight exact table identities for JOIN metadata.');
  }
  const sources = new Map(endpoints.map(value => [endpointKey(value), value]));
  const visible = new Map(sources), edges = new Map();
  const bindings = [...sources.values()].flatMap(({ schema, table }) => [schema, table]);
  const filter = tupleFilter('TABLE_SCHEMA', 'TABLE_NAME', sources.size);
  async function rows(sql, parameters, limit) {
    const result = await query(sql + ' LIMIT ' + (limit + 1), parameters);
    if (result.truncated || result.rows.length > limit) throw Error('JOIN metadata exceeds the bounded editor scope.');
    return result.rows;
  }
  if (includeEdges) {
    const parentFilter = tupleFilter('REFERENCED_TABLE_SCHEMA', 'REFERENCED_TABLE_NAME', sources.size);
    const foreign = await rows('SELECT TABLE_SCHEMA,TABLE_NAME,CONSTRAINT_NAME,COLUMN_NAME,ORDINAL_POSITION,' +
      'REFERENCED_TABLE_SCHEMA,REFERENCED_TABLE_NAME,REFERENCED_COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE ' +
      'WHERE REFERENCED_TABLE_NAME IS NOT NULL AND (' + filter + ' OR ' + parentFilter + ') ' +
      'ORDER BY TABLE_SCHEMA,TABLE_NAME,CONSTRAINT_NAME,ORDINAL_POSITION', [...bindings, ...bindings], maxForeignKeys * maxParts);
    for (const [schema, table, name, column, position, parentSchema, parentTable, parentColumn] of foreign) {
      const child = { schema, table }, parent = { schema: parentSchema, table: parentTable };
      if (!endpoint(child) || !endpoint(parent) || ![name, column, parentColumn].every(validName)) continue;
      const key = endpointKey(child), parentKey = endpointKey(parent);
      if (!sources.has(key) && !sources.has(parentKey)) continue;
      const constraint = JSON.stringify([schema, table, name]);
      if (!edges.has(constraint)) edges.set(constraint, { name, kind: 'physical', child, parent, parts: [] });
      const edge = edges.get(constraint);
      if (endpointKey(edge.parent) !== parentKey) throw Error('The foreign-key target changed during JOIN inspection.');
      edge.parts.push({ column, parentColumn, ordinal: Number(position) });
      visible.set(key, child);
      visible.set(parentKey, parent);
    }
  }
  if (edges.size > maxForeignKeys || visible.size > maxTables) throw Error('Too many visible tables are linked to this JOIN scope.');
  const graphFilter = tupleFilter('TABLE_SCHEMA', 'TABLE_NAME', visible.size);
  const parameters = [...visible.values()].flatMap(({ schema, table }) => [schema, table]);
  const objects = await rows('SELECT TABLE_SCHEMA,TABLE_NAME,TABLE_TYPE FROM information_schema.TABLES WHERE ' + graphFilter +
    ' ORDER BY TABLE_SCHEMA,TABLE_NAME', parameters, maxTables * 2);
  const columns = await rows('SELECT TABLE_SCHEMA,TABLE_NAME,COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,CHARACTER_SET_NAME,COLLATION_NAME,EXTRA ' +
    'FROM information_schema.COLUMNS WHERE ' + graphFilter + ' ORDER BY TABLE_SCHEMA,TABLE_NAME,ORDINAL_POSITION', parameters, maxRows);
  const tables = new Map();
  for (const [schema, table, type] of objects) {
    const key = endpointKey({ schema, table });
    if (visible.has(key) && ['BASE TABLE', 'VIEW'].includes(type)) tables.set(key, { schema, name: table, kind: type === 'VIEW' ? 'view' : 'table', columns: [] });
  }
  for (const [schema, table, name, type, nullable, charset, collation, extra] of columns) {
    if (!validName(name) || typeof type !== 'string') continue;
    tables.get(endpointKey({ schema, table }))?.columns.push({ name, type, nullable: nullable === 'YES', charset, collation,
      ...(typeof extra === 'string' && { extra }) });
  }
  return { tables: [...tables.values()].filter(table => table.columns.length), edges: [...edges.values()] };
}

module.exports = { readJoinCatalog, endpointKey, validName, maxSources, maxParts };
