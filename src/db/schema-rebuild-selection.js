'use strict';

const {compareSnapshots, normalizeSnapshot, LIMITS} = require('./schema-diff');
const generated = require('./schema-generated-column');
const {assertSelectedViewPair} = require('./schema-rebuild-view');

const columnChanges = new Set(['add-column', 'drop-column', 'change-column']);
const indexChanges = new Set(['add-index', 'drop-index', 'change-index']);
const foreignKeyChange = 'change-foreignKeys';
const viewChange = 'change-view';
const selectedViewLimit = 4;
const rebuildTableLimit = 10;
const fail = message => Object.assign(new Error(message), {code: 'ROCKETBRAIN_REBUILD_SELECTION'});
const byName = items => new Map(items.map(item => [item.name, item]));
const columnName = (table, name) => table.columns.find(column => column.name === name);
const isInnoDb = table => table?.kind === 'table' && String(table.engine).toUpperCase() === 'INNODB';
const complete = snapshot => Object.values(snapshot.coverage).every(value => value === 'loaded');
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const fold = name => name.toLowerCase();
const caseCollision = items => new Set(items.map(item => fold(item.name))).size !== items.length;

function selectionContext(current, desired) {
  return {before: byName(current.tables), proposed: byName(desired.tables),
    compatible: current.server.dialect === desired.server.dialect && complete(current) && complete(desired),
    sameViewContext: current.database === desired.database && current.server.sqlMode === desired.server.sqlMode &&
      current.server.currentUser === desired.server.currentUser};
}

function eligible(change, {before, proposed, compatible, sameViewContext}) {
  if (!change || !compatible || change.reason === 'Comparison options are review-only.' ||
      /^__rb_/iu.test(change.table)) return false;
  const source = before.get(change.table), target = proposed.get(change.table);
  if (change.kind === viewChange) return sameViewContext && source?.kind === 'view' && target?.kind === 'view';
  if (!columnChanges.has(change.kind) && !indexChanges.has(change.kind) && change.kind !== foreignKeyChange) return false;
  // The current rebuild keeps original CHECK names on the backup and gives the
  // shadow different names. Selected changes must preserve unselected names.
  if (!isInnoDb(source) || !isInnoDb(target) ||
      source.partitions.length || source.checks.length) return false;
  return true;
}

function isSelectableRebuildChange(change, current, desired) {
  return eligible(change, selectionContext(current, desired));
}

function changeColumnOrder(columns, added, proposedOrder) {
  let previous;
  for (const [index, column] of proposedOrder.entries()) {
    if (added.has(column.name)) {
      const earlier = previous === undefined ? -1 : columns.findIndex(item => item.name === previous);
      const next = proposedOrder.slice(index + 1).find(item =>
        !added.has(item.name) && columns.some(candidate => candidate.name === item.name));
      const later = next ? columns.findIndex(item => item.name === next.name) : columns.length;
      if (earlier >= later) throw fail('The selected column position needs an unselected reorder.');
      // Retained columns keep their live relative order. Place the addition
      // beside a retained anchor, or first if no proposed anchor survives.
      const position = earlier >= 0 ? earlier + 1 : next ? later : 0;
      columns.splice(position, 0, {...column, key: ''});
    }
    if (columns.some(item => item.name === column.name)) previous = column.name;
  }
  return columns.map((column, index) => ({...column, ordinal: index + 1}));
}

function projectTable(source, proposed, changes, currentServer, proposedDatabase) {
  const currentDatabase = currentServer.database;
  const columns = byName(source.columns), indexes = byName(source.indexes), added = new Set();
  let foreignKeys = source.foreignKeys;
  for (const change of changes) {
    if (change.kind === 'add-column') added.add(change.object);
    if (change.kind === 'drop-column') columns.delete(change.object);
    if (change.kind === 'change-column') {
      const prior = columns.get(change.object);
      columns.set(change.object, {...change.after, key: prior.key, ordinal: prior.ordinal});
    }
    if (change.kind === 'drop-index') indexes.delete(change.object);
    if (change.kind === 'add-index' || change.kind === 'change-index') indexes.set(change.object, change.after);
    if (change.kind === foreignKeyChange) {
      const physicalDatabase = currentServer.tableNameCaseSensitive ? name => name : fold;
      if (proposed.foreignKeys.some(key => key.referencedSchema !== proposedDatabase &&
          physicalDatabase(key.referencedSchema) === physicalDatabase(currentDatabase))) {
        throw fail('A desired external foreign-key reference collides with the current schema name.');
      }
      foreignKeys = proposed.foreignKeys.map(key => ({
        ...key, referencedSchema: key.referencedSchema === proposedDatabase ? currentDatabase : key.referencedSchema
      }));
    }
  }
  // This is a projected table rather than another SHOW CREATE observation.
  // The established rebuild renderer generates the executable definition.
  return {...source, createSql: '', columns: changeColumnOrder([...columns.values()], added, proposed.columns),
    indexes: [...indexes.values()], foreignKeys};
}

function validateIndexSelections(source, proposed, changes) {
  for (const change of changes) {
    if (change.kind !== 'add-index' && change.kind !== 'drop-index') continue;
    const adding = change.kind === 'add-index';
    const other = (adding ? source : proposed).indexes.find(index =>
      index.name !== change.object && fold(index.name) === fold(change.object));
    if (other && !changes.some(item => item.kind === (adding ? 'drop-index' : 'add-index') && item.object === other.name)) {
      throw fail('Select both index changes for a case-only name change.');
    }
  }
}

function childIndex(table, key) {
  return table.indexes.some(index => index.type === 'BTREE' && index.columns.length >= key.columns.length &&
    key.columns.every((pair, i) => index.columns[i].name === pair.name && index.columns[i].prefixLength === null));
}

function parentIndex(table, key) {
  return table.indexes.some(index => index.type === 'BTREE' && index.unique &&
    index.columns.length === key.columns.length && index.columns.every((column, i) =>
      column.name === key.columns[i].referencedColumn && column.prefixLength === null));
}

function validateProjectedKeys(current, target, selected) {
  const original = byName(current.tables), projected = byName(target.tables);
  for (const table of target.tables) {
    const ownerSelected = selected.has(table.name);
    if (ownerSelected && (caseCollision(table.indexes) || caseCollision(table.foreignKeys))) {
      throw fail('Selected index or foreign-key names collide under case-insensitive matching.');
    }
    if (ownerSelected && (!table.columns.length || table.indexes.some(index =>
      index.columns.some(part => part.expression === undefined && !columnName(table, part.name))))) {
      throw fail('Select the required index and column changes together.');
    }
    if (ownerSelected) {
      const after = byName(table.foreignKeys);
      for (const former of original.get(table.name).foreignKeys) {
        if (same(former, after.get(former.name))) continue;
        if (former.referencedSchema !== current.database || !isInnoDb(projected.get(former.referencedTable))) {
          throw fail('Select foreign-key changes only for complete same-schema endpoints.');
        }
      }
    }
    for (const key of table.foreignKeys) {
      const local = key.referencedSchema === current.database;
      const parent = local ? projected.get(key.referencedTable) : undefined;
      const parentSelected = parent && selected.has(parent.name);
      const former = original.get(table.name)?.foreignKeys.find(item => item.name === key.name);
      const changed = !same(key, former);
      if (!ownerSelected && !parentSelected) continue;
      if (changed && (!local || !isInnoDb(parent))) {
        throw fail('Select foreign-key changes only for complete same-schema endpoints.');
      }
      if (!key.columns.length || !childIndex(table, key) || key.columns.some(part => !columnName(table, part.name)) ||
          (parent && (!parentIndex(parent, key) ||
          key.columns.some(part => !columnName(parent, part.referencedColumn))))) {
        throw fail('Select the foreign-key, column and supporting index changes together.');
      }
    }
  }
}

function projectSelectedRebuild(currentValue, desiredValue, changeIds) {
  if (!Array.isArray(changeIds) || !changeIds.length || changeIds.length > LIMITS.selectedChanges ||
      Array.from(changeIds).some(id => typeof id !== 'string' || !/^[a-f0-9]{24}$/u.test(id)) ||
      new Set(changeIds).size !== changeIds.length) {
    throw fail('Select distinct exact change IDs from the reviewed schema comparison.');
  }
  const current = normalizeSnapshot(currentValue), proposed = normalizeSnapshot(desiredValue);
  const context = selectionContext(current, proposed);
  const ids = new Set(changeIds);
  const changes = compareSnapshots(current, proposed).changes.filter(change => ids.has(change.id));
  if (changes.length !== ids.size || changes.some(change => !eligible(change, context))) {
    throw fail('One or more selected rebuild changes are unknown or unsupported.');
  }
  if (changes.some(change => change.dependencies.some(id => !ids.has(id)))) {
    throw fail('Select the required dependency changes together.');
  }
  changes.sort((left, right) => left.id < right.id ? -1 : 1);
  const selectedViewChanges = changes.filter(change => change.kind === viewChange);
  if (selectedViewChanges.length > selectedViewLimit) throw fail('Select at most four dependent view changes.');
  const selectedViews = selectedViewChanges.map(change =>
    assertSelectedViewPair(current, proposed, context.before.get(change.table), context.proposed.get(change.table)));
  const viewNames = new Set(selectedViewChanges.map(change => change.table));
  const byTable = new Map();
  for (const change of changes) {
    if (change.kind === viewChange) continue;
    if (!byTable.has(change.table)) byTable.set(change.table, []);
    byTable.get(change.table).push(change);
  }
  const tables = [...byTable.keys()].sort();
  if (!tables.length) throw fail('Select a rebuild change to a base table along with its dependent view.');
  if (tables.length > rebuildTableLimit) throw fail('Select changes for at most 10 existing tables.');
  const desired = normalizeSnapshot({...current, tables: current.tables.map(table => {
    if (viewNames.has(table.name)) return context.proposed.get(table.name);
    const chosen = byTable.get(table.name);
    if (!chosen) return table;
    const target = context.proposed.get(table.name);
    validateIndexSelections(table, target, chosen);
    return projectTable(table, target, chosen, current.server, proposed.database);
  })}, {verifyFingerprint: false});
  validateProjectedKeys(current, desired, byTable);
  const actual = compareSnapshots(current, desired).changes.map(change => change.id);
  if (actual.length !== ids.size || actual.some(id => !ids.has(id))) {
    throw fail('The selected changes do not describe the complete projected schema difference.');
  }
  return {desired, tables, changes, ...(selectedViews.length && {selectedViews})};
}

function assertSelectedRebuildConversions(changes, rules) {
  if (rules === undefined) return;
  if (!rules || Object.getPrototypeOf(rules) !== Object.prototype) {
    throw fail('Use reviewed conversion rules keyed by selected rebuild tables.');
  }
  const columns = changes.filter(change => change.kind === 'add-column' || change.kind === 'change-column');
  for (const [table, conversions] of Object.entries(rules)) {
    if (!changes.some(change => change.table === table) || !Array.isArray(conversions) || conversions.length > columns.length ||
        Array.from(conversions).some(rule => !columns.some(change => change.table === table && change.object === rule?.column))) {
      throw fail('Explicit conversion rules must target selected added or changed columns.');
    }
  }
}

function assertRetainedGeneratedColumns(changes, steps) {
  for (const {table, before, after, conversions} of steps) {
    const edited = new Set(changes.filter(change => change.table === table && columnChanges.has(change.kind))
      .map(change => change.object));
    for (const column of after.columns) {
      if (edited.has(column.name) || !generated.mode(column)) continue;
      const prior = generated.definition(columnName(before, column.name), before.columns);
      const current = generated.definition(column, after.columns);
      // The existing numeric expression parser emits quoted identifiers only
      // for exact signed base-column bindings and refuses generated inputs.
      const inputs = [...current.expression.matchAll(/`((?:[^`]|``)+)`/gu)]
        .map(match => match[1].replaceAll('``', '`'));
      if (!same(prior, current) || inputs.some(input => {
        const source = columnName(before, input), target = columnName(after, input);
        const conversion = conversions.find(item => item.column === input);
        return !source || source.type !== target.type || !conversion || conversion.strategy !== 'exact' || conversion.lossy;
      })) {
        throw fail('Select the affected generated-column change with its input changes, or preserve those inputs.');
      }
    }
  }
}

module.exports = {projectSelectedRebuild, isSelectableRebuildChange, assertSelectedRebuildConversions,
  assertRetainedGeneratedColumns};
