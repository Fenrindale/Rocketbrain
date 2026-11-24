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
    const value = change.source === null ? { kind: 'null' } :
      { kind: 'value', text: Object.is(change.source, -0) ? '-0' : String(change.source) };
    typedCell(value, column);
    return [column.name, value];
  });
  return { rowId: target.edit.rowIds[row.index], values: Object.fromEntries(entries) };
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
  const primaryKey = target.edit?.columns?.flatMap((column, index) => column.primaryKey ? [index] : []) || [];
  const editable = target.edit?.canEdit && primaryKey.length === keyPairs.length && keyPairs.every(pair => primaryKey.includes(pair.target));
  const summary = { equal: 0, changed: 0, targetOnly: 0, sourceOnly: 0 };
  const rows = [], updates = new Map();
  let bytes = 0;
  function add(entry, update) {
    entry.index = rows.length;
    if (update) updates.set(entry.index, update);
    bytes += Buffer.byteLength(JSON.stringify(entry));
    if (bytes > limits.reportBytes) throw Error('The captured differences exceed the 8 MiB report limit. Compare smaller results.');
    rows.push(entry);
  }
  for (const [key, row] of left) {
    const other = right.get(key);
    if (!other) {
      summary.targetOnly++;
      add({ key: row.key, state: 'target-only' });
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
    add({ key: row.key, state: 'changed', fields: changes, canStage: Boolean(update), ...(reason && { reason }) }, update);
  }
  for (const [key, row] of right) if (!left.has(key)) {
    summary.sourceOnly++;
    add({ key: row.key, state: 'source-only' });
  }
  return { report: { mapped, summary, rows, target: coverage(target), source: coverage(source), stageableRows: updates.size }, updates };
}

function selectUpdates(comparison, indices) {
  if (!Array.isArray(indices) || !indices.length || indices.length > limits.draftRows || new Set(indices).size !== indices.length ||
      indices.some(index => !Number.isInteger(index) || !comparison.updates.has(index))) {
    throw Error('Select distinct eligible matched rows from the current comparison.');
  }
  const updates = indices.map(index => comparison.updates.get(index));
  const rows = new Set(updates.map(update => update.rowId));
  if (rows.has(undefined) || rows.size !== updates.length) throw Error('These rows do not have distinct retained target identities.');
  const changes = { updates, deletes: [], inserts: [] };
  if (Buffer.byteLength(JSON.stringify(changes)) > limits.draftBytes) throw Error('Select at most 1 MiB of staged values at a time.');
  return changes;
}

module.exports = { compareDatasets, selectUpdates };
