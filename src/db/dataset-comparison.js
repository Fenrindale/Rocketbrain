'use strict';

const { typedCell } = require('./grid');
const { columnKind } = require('./result-export');
const { normalizeCapturedNumber } = require('./result-analysis');

const limits = { rows: 1000, mapping: 64, reportBytes: 8 * 1024 * 1024, draftRows: 500, draftBytes: 1024 * 1024 };

function semanticKind(result, index) {
  const column = result.edit?.columns?.[index];
  const type = column?.kind || columnKind(result.fields?.[index]);
  if (['integer', 'decimal'].includes(type)) return 'exact-number';
  if (type === 'float') return 'float';
  if (type === 'binary' && /^bit\b/i.test(column.type)) return 'bit';
  if (type === 'binary' || type === 'binary-hex') return 'binary';
  if (type === 'json-text') return 'json';
  if (type === 'datetime') return 'temporal';
  if (type !== 'unknown') return type;
  const values = result.rows.map(row => row[index]).filter(value => value !== null);
  if (!values.length) return 'null';
  if (values.every(value => typeof value === 'string')) return 'text';
  if (values.every(Number.isSafeInteger)) return 'exact-number';
  if (values.every(Number.isFinite)) return 'float';
  if (values.every(value => typeof value === 'boolean')) return 'boolean';
  return 'storage';
}

function normalized(value, kind) {
  if (value === null) return null;
  if (kind === 'exact-number' || kind === 'float') return normalizeCapturedNumber(value);
  if (kind === 'binary' || kind === 'bit') {
    if (typeof value !== 'string' || !/^0x(?:[0-9a-f]{2})*$/i.test(value)) throw Error('A captured byte column contains an unsupported value.');
    return value.toLowerCase();
  }
  if (typeof value === 'string' || typeof value === 'boolean' || Number.isFinite(value)) return value;
  throw Error('A captured column contains a value without an exact comparison representation.');
}

function mappings(target, source, pairs) {
  if (!Array.isArray(pairs) || !pairs.length || pairs.length > limits.mapping) throw Error('Map between 1 and 64 columns for this comparison.');
  const targetIndices = new Set(), sourceIndices = new Set();
  const valid = (result, index) => Number.isInteger(index) && index >= 0 && index < result.columns.length;
  const mapped = pairs.map(pair => {
    if (!pair || !valid(target, pair.target) || !valid(source, pair.source) || typeof pair.key !== 'boolean' ||
        targetIndices.has(pair.target) || sourceIndices.has(pair.source)) {
      throw Error('Map distinct columns on both results and explicitly mark the matching key.');
    }
    targetIndices.add(pair.target);
    sourceIndices.add(pair.source);
    const left = semanticKind(target, pair.target), right = semanticKind(source, pair.source);
    if (left !== right && left !== 'null' && right !== 'null') {
      throw Error('Incompatible captured column types for ' + target.columns[pair.target] + ' and ' + source.columns[pair.source] + '.');
    }
    return { target: pair.target, source: pair.source, key: pair.key, kind: left === 'null' ? right : left,
      targetName: target.columns[pair.target], sourceName: source.columns[pair.source] };
  });
  if (!mapped.some(pair => pair.key)) throw Error('Choose at least one mapped key column.');
  return mapped;
}

function rowIndex(result, pairs, side) {
  const found = new Map();
  for (const [index, row] of result.rows.entries()) {
    const values = pairs.map(pair => normalized(row[pair[side]], pair.kind));
    const key = pairs.flatMap((pair, i) => pair.key ? [values[i]] : []);
    if (key.includes(null)) throw Error('A ' + side + ' key contains SQL NULL. Choose a complete composite key.');
    const signature = JSON.stringify(key);
    if (found.has(signature)) throw Error('A ' + side + ' key is duplicated in the captured rows. Choose a unique composite key.');
    found.set(signature, { values, row, index, key });
  }
  return found;
}

function detail(left, right, pairs) {
  return pairs.flatMap((pair, index) => {
    if (pair.key || Object.is(left.values[index], right.values[index])) return [];
    return [{ target: left.row[pair.target], source: right.row[pair.source],
      targetName: pair.targetName, sourceName: pair.sourceName, targetIndex: pair.target }];
  });
}

function stagedUpdate(target, row, changes) {
  const entries = changes.map(change => {
    const column = target.edit.columns[change.targetIndex];
    if (!column?.editable) throw Error('A changed destination column is protected.');
    return [column.name, capturedCell(change.source, column)];
  });
  return { rowId: target.edit.rowIds[row.index], values: Object.fromEntries(entries) };
}

function capturedCell(raw, column) {
  const value = raw === null ? { kind: 'null' } : { kind: 'value', text: Object.is(raw, -0) ? '-0' : String(raw) };
  typedCell(value, column);
  return value;
}

function matchingPrimaryKey(result, pairs, side) {
  const columns = result.edit?.columns;
  const key = columns?.flatMap((column, index) => column.primaryKey ? [index] : []) || [];
  return key.length === pairs.length && pairs.every(pair => key.includes(pair[side]));
}

function completeTable(result) {
  const browse = result.browse;
  return Boolean(result.edit?.table && browse && browse.page === 0 && Array.isArray(browse.filters) &&
    browse.filters.length === 0 && browse.hasNext === false && browse.hasPrevious === false && !result.truncated);
}

function stagedInsert(target, row, mapped, keyPairs) {
  if (!target.edit.insertable || keyPairs.some(pair => !target.edit.columns[pair.target].insertable)) {
    throw Error('The destination requires generated or unsupported primary-key values.');
  }
  const columns = target.edit.columns;
  const mappedByTarget = new Map(mapped.map(pair => [pair.target,pair]));
  if (columns.some((column,index) => column.required && !mappedByTarget.has(index))) {
    throw Error('Map every required destination column before staging an insert.');
  }
  const entries = mapped.filter(pair=>columns[pair.target].insertable).map(pair=>{
    const column = columns[pair.target];
    return [column.name, capturedCell(row.row[pair.source],column)];
  });
  return {values:Object.fromEntries(entries)};
}

function coverage(result) {
  const browse = result.browse;
  return { rows: result.rows.length, partial: Boolean(result.truncated || (browse && (browse.hasPrevious || browse.hasNext !== false ||
    browse.filters?.length))), ...(browse && { page: browse.page + 1 }) };
}

function compareDatasets(target, source, pairs) {
  for (const result of [target, source]) {
    if (!result?.columns?.length || !Array.isArray(result.rows) || result.rows.length > limits.rows) {
      throw Error('Choose two completed results of at most 1,000 captured rows each.');
    }
  }
  const mapped = mappings(target, source, pairs);
  const keyPairs = mapped.filter(pair => pair.key);
  const left = rowIndex(target, mapped, 'target'), right = rowIndex(source, mapped, 'source');
  const editable = target.edit?.canEdit && matchingPrimaryKey(target,keyPairs,'target');
  const oneSided = editable && completeTable(target) && completeTable(source) && matchingPrimaryKey(source,keyPairs,'source') &&
    keyPairs.every(pair=>{
      const left = target.edit.columns[pair.target], right = source.edit.columns[pair.source];
      return left.kind === 'integer' && right.kind === 'integer' && left.type.toLowerCase() === right.type.toLowerCase();
    });
  const summary = { equal: 0, changed: 0, targetOnly: 0, sourceOnly: 0 };
  const rows = [], operations = new Map();
  let bytes = 0;
  function add(entry, type, value) {
    entry.index = rows.length;
    if (value !== undefined) {
      entry.canStage = true;
      entry.operation = type;
      operations.set(entry.index,{type,value});
    }
    bytes += Buffer.byteLength(JSON.stringify(entry));
    if (bytes > limits.reportBytes) throw Error('The captured differences exceed the 8 MiB report limit. Compare smaller results.');
    rows.push(entry);
  }
  for (const [key, row] of left) {
    const other = right.get(key);
    if (!other) {
      summary.targetOnly++;
      add({ key: row.key, state: 'target-only' },'delete',oneSided ? target.edit.rowIds[row.index] : undefined);
      continue;
    }
    const changes = detail(row, other, mapped);
    if (!changes.length) { summary.equal++; continue; }
    summary.changed++;
    let update, reason;
    if (editable) {
      try { update = stagedUpdate(target, row, changes); }
      catch (error) { reason = error.message; }
    }
    add({ key: row.key, state: 'changed', fields: changes, canStage: Boolean(update), ...(reason && { reason }) }, 'update', update);
  }
  for (const [key, row] of right) if (!left.has(key)) {
    summary.sourceOnly++;
    let insert, reason;
    if (oneSided) {
      try { insert = stagedInsert(target,row,mapped,keyPairs); }
      catch (error) { reason = error.message; }
    }
    add({ key: row.key, state: 'source-only', ...(reason && {reason}) }, 'insert', insert);
  }
  return { report: { mapped, summary, rows, target: coverage(target), source: coverage(source), stageableRows: operations.size,
    oneSidedChanges: Boolean(oneSided) }, operations };
}

function selectDatasetChanges(comparison, indices) {
  if (!Array.isArray(indices) || !indices.length || indices.length > limits.draftRows || new Set(indices).size !== indices.length ||
      indices.some(index => !Number.isInteger(index) || !comparison.operations.has(index))) {
    throw Error('Select distinct eligible rows from the current comparison.');
  }
  const changes = { updates: [], deletes: [], inserts: [] };
  for (const index of indices) {
    const {type,value} = comparison.operations.get(index);
    changes[type + 's'].push(value);
  }
  const identities = [...changes.updates.map(update=>update.rowId),...changes.deletes];
  if (identities.some(id=>typeof id!=='string') || new Set(identities).size !== identities.length) {
    throw Error('These rows do not have distinct retained target identities.');
  }
  if (Buffer.byteLength(JSON.stringify(changes)) > limits.draftBytes) throw Error('Select at most 1 MiB of staged values at a time.');
  return changes;
}

module.exports = { compareDatasets, selectDatasetChanges, capturedCell };
