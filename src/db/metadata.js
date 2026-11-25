'use strict';

/**
 * A database-scoped catalog assembled from actual INFORMATION_SCHEMA rows.
 * An empty result means "visible to this account", never "globally absent".
 * Version-specific routine/trigger/index visibility is reported independently.
 */
async function readMetadata(query, database, revision, onlyTable, { exactScope = false } = {}) {
  const warnings = [], coverage = {};
  const equality = column => exactScope ? 'CAST(' + column + ' AS BINARY) = CAST(? AS BINARY)' : column + ' = ?';
  const target = column => onlyTable ? ' AND ' + equality(column) : '';
  const joined = name => exactScope ? 'CAST(r.' + name + ' AS BINARY) = CAST(k.' + name + ' AS BINARY)' : 'r.' + name + ' = k.' + name;
  const values = onlyTable ? [database, onlyTable] : [database];
  const fetch = async (area, sql, optional = false) => {
    try { const result = await query(sql, values); coverage[area] = 'loaded'; return result.rows; }
    catch (error) {
      coverage[area] = 'unavailable';
      if (!optional) throw error;
      warnings.push({ area, code: error.code || 'METADATA_ERROR', message: error.message }); return [];
    }
  };
  const tableRows = await fetch('tables', 'SELECT TABLE_NAME, TABLE_TYPE, ENGINE, TABLE_COLLATION, TABLE_COMMENT FROM information_schema.TABLES WHERE ' + equality('TABLE_SCHEMA') + target('TABLE_NAME') + ' ORDER BY TABLE_NAME');
  const columnRows = await fetch('columns', 'SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY, EXTRA, ORDINAL_POSITION, COLUMN_COMMENT, CHARACTER_SET_NAME, COLLATION_NAME FROM information_schema.COLUMNS WHERE ' + equality('TABLE_SCHEMA') + target('TABLE_NAME') + ' ORDER BY TABLE_NAME, ORDINAL_POSITION');
  const objects = new Map(tableRows.map(([name, kind, engine, collation, comment]) => [name, { name, kind: kind === 'VIEW' ? 'view' : 'table', engine, collation, comment, columns: [], indexes: [], foreignKeys: [] }]));
  for (const [tableName, name, type, nullable, defaultValue, key, extra, ordinal, comment, charset, collation] of columnRows) {
    if (!objects.has(tableName)) objects.set(tableName, { name: tableName, kind: 'unknown', columns: [], indexes: [], foreignKeys: [] });
    objects.get(tableName).columns.push({ name, type, primaryKey: key === 'PRI', nullable: nullable === 'YES', defaultValue, extra, ordinal: Number(ordinal), comment, charset, collation });
  }
  const indexRows = await fetch('indexes', 'SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME, SUB_PART, INDEX_TYPE, COLLATION FROM information_schema.STATISTICS WHERE ' + equality('TABLE_SCHEMA') + target('TABLE_NAME') + ' ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX', true);
  for (const [tableName, name, nonUnique, ordinal, column, prefixLength, type, collation] of indexRows) {
    const table = objects.get(tableName); if (!table) continue;
    let index = table.indexes.find(item => item.name === name);
    if (!index) table.indexes.push(index = { name, unique: Number(nonUnique) === 0, primaryKey: name === 'PRIMARY', type, columns: [] });
    index.columns.push({ name: column, ordinal: Number(ordinal), prefixLength, collation });
  }
  const fkRows = await fetch('foreignKeys', 'SELECT k.TABLE_NAME, k.CONSTRAINT_NAME, k.COLUMN_NAME, k.ORDINAL_POSITION, k.REFERENCED_TABLE_SCHEMA, k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME, r.UPDATE_RULE, r.DELETE_RULE FROM information_schema.KEY_COLUMN_USAGE k LEFT JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON ' +
    ['CONSTRAINT_SCHEMA', 'TABLE_NAME', 'CONSTRAINT_NAME'].map(joined).join(' AND ') + ' WHERE ' + equality('k.CONSTRAINT_SCHEMA') +
    target('k.TABLE_NAME') + ' AND k.REFERENCED_TABLE_NAME IS NOT NULL ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION', true);
  for (const [tableName, name, column, ordinal, referencedSchema, referencedTable, referencedColumn, onUpdate, onDelete] of fkRows) {
    const table = objects.get(tableName); if (!table) continue;
    let fk = table.foreignKeys.find(item => item.name === name);
    if (!fk) table.foreignKeys.push(fk = { name, referencedSchema, referencedTable, onUpdate, onDelete, columns: [] });
    fk.columns.push({ name: column, referencedColumn, ordinal: Number(ordinal) });
  }
  const routineRows = onlyTable ? [] : await fetch('routines', 'SELECT ROUTINE_NAME, ROUTINE_TYPE, DATA_TYPE, IS_DETERMINISTIC, SQL_DATA_ACCESS, SECURITY_TYPE, ROUTINE_COMMENT FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_NAME', true);
  const triggerRows = onlyTable ? [] : await fetch('triggers', 'SELECT TRIGGER_NAME, EVENT_OBJECT_TABLE, ACTION_TIMING, EVENT_MANIPULATION FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? ORDER BY TRIGGER_NAME', true);
  const all = [...objects.values()];
  return { database, revision, loadedAt: new Date().toISOString(), scope: onlyTable ? 'table' : 'database',
    ...(onlyTable ? { selectedTable: onlyTable } : {}), visibility: 'current-account',
    tables: all.filter(item => item.kind !== 'view'), views: all.filter(item => item.kind === 'view'),
    routines: routineRows.map(([name, type, returnType, deterministic, dataAccess, security, comment]) => ({ name, type, returnType, deterministic: deterministic === 'YES', dataAccess, security, comment })),
    triggers: triggerRows.map(([name, table, timing, event]) => ({ name, table, timing, event })),
    coverage, warnings, complete: Object.values(coverage).every(value => value === 'loaded'),
    limitations: ['Catalog visibility is limited by the current database account.', 'The separate catalog queries are not an atomic snapshot during concurrent DDL.', 'Expression indexes, routine bodies, generated expressions and cross-database objects are not loaded.', 'This catalog is not a semantic SQL binder or a schema migration engine.'] };
}

async function attachCheckMetadata(query, catalog, onlyTable) {
  const maria = catalog.dialect === 'mariadb';
  const table = maria ? 'TABLE_NAME' : 'tc.TABLE_NAME';
  const checkSql = maria ?
    'SELECT TABLE_NAME, CONSTRAINT_NAME, CHECK_CLAUSE, NULL FROM information_schema.CHECK_CONSTRAINTS WHERE CAST(CONSTRAINT_SCHEMA AS BINARY) = CAST(? AS BINARY)' :
    'SELECT tc.TABLE_NAME, tc.CONSTRAINT_NAME, cc.CHECK_CLAUSE, tc.ENFORCED FROM information_schema.TABLE_CONSTRAINTS tc ' +
    'JOIN information_schema.CHECK_CONSTRAINTS cc ON CAST(cc.CONSTRAINT_SCHEMA AS BINARY) = CAST(tc.CONSTRAINT_SCHEMA AS BINARY) ' +
    'AND CAST(cc.CONSTRAINT_NAME AS BINARY) = CAST(tc.CONSTRAINT_NAME AS BINARY) ' +
    "WHERE CAST(tc.TABLE_SCHEMA AS BINARY) = CAST(? AS BINARY) AND tc.CONSTRAINT_TYPE = 'CHECK'";
  for (const object of [...catalog.tables, ...catalog.views]) object.checks = [];
  const objects = new Map(catalog.tables.map(object => [object.name, object]));
  try {
    const values = onlyTable === undefined ? [catalog.database] : [catalog.database, onlyTable];
    const { rows } = await query(checkSql + (onlyTable === undefined ? '' : ' AND CAST(' + table + ' AS BINARY) = CAST(? AS BINARY)') +
      ' ORDER BY ' + table + ',' + (maria ? 'CONSTRAINT_NAME' : 'tc.CONSTRAINT_NAME'), values);
    for (const [owner, name, expression, enforced] of rows) {
      if (objects.has(owner)) objects.get(owner).checks.push({ name, expression, enforced: enforced == null ? null : enforced === 'YES' });
    }
    catalog.coverage.checks = 'loaded';
  } catch {
    catalog.coverage.checks = 'unavailable';
    catalog.complete = false;
    catalog.warnings.push({ area: 'checks', code: 'METADATA_ERROR', message: 'Check constraint metadata is unavailable.' });
  }
  return catalog;
}

const scopedName = name => typeof name === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(name);

async function readRelationshipJoinCatalog(query, activeDatabase, request = {}, revision) {
  const { joinSchema, joinTable } = request;
  if (![activeDatabase, joinSchema, joinTable].every(scopedName)) {
    throw Error('Choose a lower-case schema and table name for the relationship join table.');
  }
  async function table(schema, name, needsForeignKeys) {
    const catalog = await readMetadata(query, schema, revision, name);
    const [observed, duplicate] = catalog.tables;
    const required = ['tables', 'columns', 'indexes', ...(needsForeignKeys ? ['foreignKeys'] : [])];
    if (!observed || duplicate || observed.name !== name || observed.kind !== 'table' ||
        !required.every(area => catalog.coverage[area] === 'loaded')) {
      throw Error('The current connection cannot verify the relationship table ' + schema + '.' + name + '.');
    }
    return catalog;
  }
  const join = await table(joinSchema, joinTable, true);
  const joins = join.tables[0].foreignKeys;
  const endpoints = joins.map(({ referencedSchema, referencedTable }) => [referencedSchema, referencedTable]);
  const endpointNames = endpoints.map(([schema, name]) => schema + '.' + name);
  if (endpoints.length !== 2 || endpoints.some(pair => !pair.every(scopedName)) || new Set(endpointNames).size !== 2 ||
      endpointNames.includes(joinSchema + '.' + joinTable) ||
      ![joinSchema, ...endpoints.map(([schema]) => schema)].includes(activeDatabase)) {
    throw Error('Choose a join table with exactly two distinct foreign-key endpoints and an active schema in the relationship.');
  }
  const targets = [];
  for (const [schema, name] of endpoints) targets.push(await table(schema, name, false));
  const check = await table(joinSchema, joinTable, true);
  if (JSON.stringify(join.tables[0]) !== JSON.stringify(check.tables[0])) {
    throw Error('The join table or its foreign keys changed during inspection. Inspect again.');
  }
  return { activeDatabase, join, targets };
}

async function readForeignKeyTargetCatalog(query, sourceDatabase, request = {}, revision) {
  const { table, foreignKey, targetSchema, targetTable } = request;
  if (![sourceDatabase, table, targetSchema, targetTable].every(scopedName) || targetSchema === sourceDatabase ||
      typeof foreignKey !== 'string' || !foreignKey || foreignKey.length > 64 || foreignKey.includes('\0')) {
    throw Error('Choose an explicit foreign key and lower-case source and target identifiers in different schemas.');
  }
  const readKey = async () => {
    const { rows } = await query('SELECT TABLE_SCHEMA, TABLE_NAME, CONSTRAINT_NAME, COLUMN_NAME, ORDINAL_POSITION, ' +
      'REFERENCED_TABLE_SCHEMA, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE ' +
      'WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL ' +
      'ORDER BY ORDINAL_POSITION LIMIT 65', [sourceDatabase, table, foreignKey]);
    if (!rows.length || rows.length > 64 || rows.some(([schema, source, key, , , referenceSchema, referenceTable]) =>
      schema !== sourceDatabase || source !== table || key !== foreignKey || referenceSchema !== targetSchema || referenceTable !== targetTable)) {
      throw Error('The selected foreign key no longer proves that exact target table. Refresh the catalog.');
    }
    return rows.map(([, , , name, ordinal, , , referencedColumn]) => ({ name, ordinal: Number(ordinal), referencedColumn }));
  };
  const sourceColumns = await readKey();
  const catalog = await readMetadata(query, targetSchema, revision, targetTable);
  if (catalog.tables.length !== 1 || catalog.tables[0].name !== targetTable || catalog.tables[0].kind !== 'table' ||
      !['tables', 'columns', 'indexes'].every(area => catalog.coverage[area] === 'loaded')) {
    throw Error('The current database connection cannot verify the referenced table and primary key.');
  }
  if (JSON.stringify(sourceColumns) !== JSON.stringify(await readKey())) {
    throw Error('The selected foreign key changed during target metadata inspection. Refresh the catalog.');
  }
  return { sourceDatabase, table, foreignKey, targetSchema, targetTable, sourceColumns, catalog };
}

module.exports = { readMetadata, attachCheckMetadata, readForeignKeyTargetCatalog, readRelationshipJoinCatalog, scopedName };
