'use strict';

const { columnKind } = require('./grid');

const supportedKeys = new Set(['integer', 'decimal', 'float', 'datetime', 'text']);
const maxRelations = 200;

function relatedRows(catalog, sourceName, names, row) {
  if (!['tables', 'columns', 'foreignKeys'].every(area => catalog?.coverage?.[area] === 'loaded')) {
    throw Error('Refresh the active schema with visible foreign keys before following a relation.');
  }
  const tables = new Map(catalog.tables.filter(table => table.kind === 'table').map(table => [table.name, table]));
  const source = tables.get(sourceName);
  if (!source || !Array.isArray(row) || row.length !== names.length || new Set(names).size !== names.length) {
    throw Error('Choose a row from a current base-table preview.');
  }
  const cells = new Map(names.map((column, index) => [column, row[index]]));
  const sourceColumns = new Map(source.columns.map(column => [column.name, column]));
  const matches = [];

  function relation(from, to, fk, direction) {
    const inbound = direction === 'referencing';
    const target = inbound ? from : to;
    if (!Array.isArray(fk.columns) || !fk.columns.length || fk.columns.length > 16) return;
    const path = [...fk.columns].sort((left, right) => left.ordinal - right.ordinal);
    const targetColumns = new Map(target.columns.map(column => [column.name, column]));
    const filters = [];
    const bindings = [];
    for (const [index, part] of path.entries()) {
      if (part.ordinal !== index + 1) return;
      const sourceColumn = inbound ? part.referencedColumn : part.name;
      const targetColumn = inbound ? part.name : part.referencedColumn;
      const left = sourceColumns.get(sourceColumn);
      const right = targetColumns.get(targetColumn);
      const value = cells.get(sourceColumn);
      const kind = left && columnKind(left.type);
      // SQL foreign key matching with any NULL component denotes no relation.
      if (value == null || !right || !supportedKeys.has(kind) || kind !== columnKind(right.type) ||
          (typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value))) ||
          (kind === 'integer' && typeof value === 'number' && !Number.isSafeInteger(value))) return;
      const text = String(value);
      if (Buffer.byteLength(text) > 4096) return;
      filters.push({ column: targetColumn, operator: 'eq', value: { kind: 'value', text } });
      bindings.push([sourceColumn, left.type, targetColumn, right.type]);
    }
    if (new Set(filters.map(filter => filter.column)).size !== filters.length) return;
    const key = JSON.stringify([catalog.database, source.name, target.name, direction, fk.name, bindings]);
    const label = target.name + ' · ' + fk.name;
    matches.push({ key, label, table: target.name, direction, columns: bindings.map(([a,,b]) => [a,b]), filters });
    if (matches.length > maxRelations) throw Error('Too many related tables are visible for this preview.');
  }

  for (const from of tables.values()) {
    for (const fk of from.foreignKeys || []) {
      if (fk.referencedSchema !== catalog.database) continue;
      const to = tables.get(fk.referencedTable);
      if (!to) continue;
      if (from === source) relation(from, to, fk, 'referenced');
      if (to === source) relation(from, to, fk, 'referencing');
    }
  }
  return matches.sort((left,right) => left.label.localeCompare(right.label) || left.direction.localeCompare(right.direction));
}

module.exports = { relatedRows };
