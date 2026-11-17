'use strict';

/**
 * A database-scoped catalog assembled from actual INFORMATION_SCHEMA rows.
 * An empty result means "visible to this account", never "globally absent".
 * Version-specific routine/trigger/index visibility is reported independently.
 */
async function readMetadata(query, database, revision) {
  const warnings = [], coverage = {};
  const fetch = async (area, sql, optional = false) => {
    try { const result = await query(sql, [database]); coverage[area] = 'loaded'; return result.rows; }
    catch (error) {
      coverage[area] = 'unavailable';
      if (!optional) throw error;
      warnings.push({ area, code: error.code || 'METADATA_ERROR', message: error.message }); return [];
    }
  };
  const tableRows = await fetch('tables', 'SELECT TABLE_NAME, TABLE_TYPE, ENGINE, TABLE_COLLATION, TABLE_COMMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME');
  const columnRows = await fetch('columns', 'SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY, EXTRA, ORDINAL_POSITION, COLUMN_COMMENT, CHARACTER_SET_NAME, COLLATION_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION');
  const objects = new Map(tableRows.map(([name, kind, engine, collation, comment]) => [name, { name, kind: kind === 'VIEW' ? 'view' : 'table', engine, collation, comment, columns: [], indexes: [], foreignKeys: [] }]));
  for (const [tableName, name, type, nullable, defaultValue, key, extra, ordinal, comment, charset, collation] of columnRows) {
    if (!objects.has(tableName)) objects.set(tableName, { name: tableName, kind: 'unknown', columns: [], indexes: [], foreignKeys: [] });
    objects.get(tableName).columns.push({ name, type, primaryKey: key === 'PRI', nullable: nullable === 'YES', defaultValue, extra, ordinal: Number(ordinal), comment, charset, collation });
  }
  const indexRows = await fetch('indexes', 'SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME, SUB_PART, INDEX_TYPE, COLLATION FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX', true);
  for (const [tableName, name, nonUnique, ordinal, column, prefixLength, type, collation] of indexRows) {
    const table = objects.get(tableName); if (!table) continue;
    let index = table.indexes.find(item => item.name === name);
    if (!index) table.indexes.push(index = { name, unique: Number(nonUnique) === 0, primaryKey: name === 'PRIMARY', type, columns: [] });
    index.columns.push({ name: column, ordinal: Number(ordinal), prefixLength, collation });
  }
  const fkRows = await fetch('foreignKeys', 'SELECT k.TABLE_NAME, k.CONSTRAINT_NAME, k.COLUMN_NAME, k.ORDINAL_POSITION, k.REFERENCED_TABLE_SCHEMA, k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME, r.UPDATE_RULE, r.DELETE_RULE FROM information_schema.KEY_COLUMN_USAGE k LEFT JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.TABLE_NAME = k.TABLE_NAME AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME WHERE k.CONSTRAINT_SCHEMA = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION', true);
  for (const [tableName, name, column, ordinal, referencedSchema, referencedTable, referencedColumn, onUpdate, onDelete] of fkRows) {
    const table = objects.get(tableName); if (!table) continue;
    let fk = table.foreignKeys.find(item => item.name === name);
    if (!fk) table.foreignKeys.push(fk = { name, referencedSchema, referencedTable, onUpdate, onDelete, columns: [] });
    fk.columns.push({ name: column, referencedColumn, ordinal: Number(ordinal) });
  }
  const routineRows = await fetch('routines', 'SELECT ROUTINE_NAME, ROUTINE_TYPE, DATA_TYPE, IS_DETERMINISTIC, SQL_DATA_ACCESS, SECURITY_TYPE, ROUTINE_COMMENT FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_NAME', true);
  const triggerRows = await fetch('triggers', 'SELECT TRIGGER_NAME, EVENT_OBJECT_TABLE, ACTION_TIMING, EVENT_MANIPULATION FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? ORDER BY TRIGGER_NAME', true);
  const all = [...objects.values()];
  return { database, revision, loadedAt: new Date().toISOString(), scope: 'database', visibility: 'current-account',
    tables: all.filter(item => item.kind !== 'view'), views: all.filter(item => item.kind === 'view'),
    routines: routineRows.map(([name, type, returnType, deterministic, dataAccess, security, comment]) => ({ name, type, returnType, deterministic: deterministic === 'YES', dataAccess, security, comment })),
    triggers: triggerRows.map(([name, table, timing, event]) => ({ name, table, timing, event })),
    coverage, warnings, complete: Object.values(coverage).every(value => value === 'loaded'),
    limitations: ['Catalog visibility is limited by the current database account.', 'The separate catalog queries are not an atomic snapshot during concurrent DDL.', 'Expression indexes, routine bodies, generated expressions and cross-database objects are not loaded.', 'This catalog is not a semantic SQL binder or a schema migration engine.'] };
}

module.exports = { readMetadata };
