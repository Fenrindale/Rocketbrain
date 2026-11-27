'use strict';

const {identifier} = require('./schema-rename');

const LIMIT = 8;
const portable = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const fail = message => Object.assign(new Error(message), {code: 'ROCKETBRAIN_REBUILD_COLUMN_MAPPING'});
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const folded = name => name.toLowerCase();
const expressionColumn = column => Boolean(column.generationExpression) ||
  /\b(?:VIRTUAL|STORED|PERSISTENT)\s+GENERATED\b/iu.test(column.extra);
const physicalValue = column => !expressionColumn(column) && !/\bauto_increment\b/iu.test(column.extra);
const ordinary = table => table?.kind === 'table' && /^INNODB$/iu.test(table.engine);

function candidates(before, after) {
  if (!ordinary(before) || !ordinary(after)) return {from: [], to: []};
  const names = table => new Set(table.columns.map(column => folded(column.name)));
  const added = names(after), original = names(before);
  if (added.size !== after.columns.length || original.size !== before.columns.length) return {from: [], to: []};
  const available = (table, other) => table.columns.filter(column => portable.test(column.name) &&
    physicalValue(column) && !other.has(folded(column.name)));
  return {from: available(before, added), to: available(after, original)};
}

function validateIndexes(before, after, mappings) {
  if ([before, after].some(table => table.columns.some(expressionColumn) ||
      table.indexes.some(index => index.columns.some(part => part.expression !== undefined)) ||
      table.checks.length || table.partitions.length)) {
    throw fail('Column mappings require tables without generated, CHECK, partition or expression-index dependencies.');
  }
  const bySource = new Map(mappings.map(({from, to}) => [from, to]));
  for (const index of before.indexes.filter(item => item.columns.some(part => bySource.has(part.name)))) {
    if (String(index.type).toUpperCase() !== 'BTREE') {
      throw fail('A mapped column may retain an ordinary B-tree key only.');
    }
    const expected = {...index, columns: index.columns.map(part => ({
      ...part, name: bySource.get(part.name) || part.name
    }))};
    if (!same(expected, after.indexes.find(item => item.name === index.name))) {
      throw fail('Retain each affected index name, ordered key parts and attributes with the reviewed new column names.');
    }
  }
}

function normalizeColumnMappings(input, current, desired, tables, {coordinator} = {}) {
  if (input === undefined) return {};
  if (!input || Object.getPrototypeOf(input) !== Object.prototype ||
      Object.keys(input).some(name => !tables.includes(name))) {
    throw fail('Use exact column mappings keyed by selected rebuild tables.');
  }
  if (!Object.keys(input).length) return {};
  if (coordinator) throw fail('Column mapping is available for an individual server rebuild.');
  const result = [];
  for (const table of tables) {
    if (!Object.hasOwn(input, table)) continue;
    const mappings = input[table], before = current.tables.find(item => item.name === table);
    const after = desired.tables.find(item => item.name === table);
    if (!Array.isArray(mappings) || !mappings.length || mappings.length > LIMIT || !ordinary(before) || !ordinary(after)) {
      throw fail('Choose one to eight explicit column pairs in a retained InnoDB table.');
    }
    const available = candidates(before, after);
    const fromNames = new Set(available.from.map(column => column.name));
    const toNames = new Set(available.to.map(column => column.name));
    const usedFrom = new Set(), usedTo = new Set(), verified = [];
    for (const pair of mappings) {
      if (!pair || Object.getPrototypeOf(pair) !== Object.prototype || Object.keys(pair).length !== 2 ||
          !Object.hasOwn(pair, 'from') || !Object.hasOwn(pair, 'to') ||
          !fromNames.has(pair.from) || !toNames.has(pair.to) || usedFrom.has(folded(pair.from)) ||
          usedTo.has(folded(pair.to)) || folded(pair.from) === folded(pair.to)) {
        throw fail('Map distinct removed writable columns to distinct added writable columns using exact names.');
      }
      usedFrom.add(folded(pair.from));
      usedTo.add(folded(pair.to));
      verified.push({from: identifier(pair.from), to: identifier(pair.to)});
    }
    verified.sort((left, right) => after.columns.findIndex(column => column.name === left.to) -
      after.columns.findIndex(column => column.name === right.to));
    validateIndexes(before, after, verified);
    result.push([table, verified]);
  }
  return Object.fromEntries(result);
}

function validateMappedDependencies(plan, dependencies) {
  if (!plan.columnMappings) return;
  const byTable = new Map(Object.entries(plan.columnMappings).map(([table, mappings]) =>
    [table, new Map(mappings.map(({from, to}) => [from, to]))]));
  const mapped = (schema, table, name) => schema === plan.database
    ? byTable.get(table)?.get(name) || name : name;
  const {before, after} = dependencies;
  if (plan.formatVersion === 9) {
    require('./schema-mapped-triggers').validateMappedTriggerBundle(plan, dependencies);
  } else if (plan.formatVersion === 8) {
    if (!plan.selectedViews?.length || before.triggers.length || after.triggers.length ||
        before.routines?.length || after.routines?.length) {
      throw fail('Mapped view rebuilds require a selected dependent view and cannot change trigger or routine references.');
    }
    require('./schema-mapped-view-references').assertMappedViewReferences(plan, dependencies);
  } else if (before.triggers.length || before.views.length || before.routines?.length) {
    throw fail('A mapped rebuild cannot rewrite dependent trigger, view or routine column references.');
  }
  for (const foreign of before.foreignKeys) {
    const columns = foreign.columns.map(part => ({
      name: mapped(foreign.schema, foreign.table, part.name),
      referencedColumn: mapped(foreign.referencedSchema, foreign.referencedTable, part.referencedColumn)
    }));
    if (same(columns, foreign.columns)) continue;
    if (foreign.schema !== plan.database || foreign.referencedSchema !== plan.database ||
        !plan.steps.some(step => step.table === foreign.table && step.after)) {
      throw fail('Select both affected same-schema table definitions to retain the mapped foreign key.');
    }
    const expected = {...foreign, columns};
    if (!after.foreignKeys.some(item => same(item, expected))) {
      throw fail('The target must retain each affected foreign key name, actions and ordered references with exact mapped column names.');
    }
  }
}

module.exports = {LIMIT, candidates, normalizeColumnMappings, validateMappedDependencies};
