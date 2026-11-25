'use strict';

const { sourceTokens } = require('./sql-analysis');

const SOURCE_ROWS = 2000;
const RESULT_ROWS = 2000;
const RESULT_BYTES = 4 * 1024 * 1024;
const fieldName = /^[a-z_][a-z0-9_$]{0,63}$/i;
const integerType = /^(?:tinyint|smallint|mediumint|int|integer|bigint)\b/i;
const integerFieldTypes = new Set([1, 2, 3, 8, 9]);
const textType = /^(?:char|varchar|tinytext|text|mediumtext|longtext)\b/i;
const comparison = new Set(['=', '<>', '!=', '<', '<=', '>', '>=']);
const quote = value => '`' + value.replaceAll('`', '``') + '`';
const templateHeader = '-- Rocketbrain Federated SELECT';

function isFederatedDocument(document) {
  return document?.languageId === 'sql' && (/\.rbjoin\.sql$/i.test(document.fileName || '') ||
    document.lineAt?.(0)?.text.trim() === templateHeader);
}

function failure(message) {
  return Object.assign(new Error(message), { code: 'ROCKETBRAIN_FEDERATED_SELECT' });
}

function parseSelect(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 32 * 1024) throw Error('Use a federated SELECT of at most 32 KiB.');
  const tokens = sourceTokens(text, { sqlMode: ['NO_BACKSLASH_ESCAPES', 'ANSI_QUOTES'] });
  let cursor = 0;
  const at = () => tokens[cursor];
  const claim = value => {
    const token = at();
    if (token && (token.kind === 'word' && token.upper === value || token.kind === 'symbol' && token.value === value)) {
      cursor++;
      return true;
    }
    return false;
  };
  function expect(value) {
    if (!claim(value)) throw Error('Expected ' + value + ' in the federated SELECT.');
  }
  function name() {
    const token = at();
    if (!token || !['word', 'identifier'].includes(token.kind) || !fieldName.test(token.value)) throw Error('Use a simple SQL table, column, or alias name.');
    cursor++;
    return token.value;
  }
  function column() {
    const alias = name().toLowerCase();
    expect('.');
    return { alias, name: name() };
  }
  function relation(requiredSource) {
    const source = name().toLowerCase();
    if (source !== requiredSource) throw Error('Use ' + requiredSource + '.table for this side of the join.');
    expect('.');
    const table = name();
    claim('AS');
    return { source, table, alias: name().toLowerCase() };
  }
  function condition() {
    const ref = column();
    if (claim('IS')) {
      const operator = claim('NOT') ? 'IS NOT NULL' : 'IS NULL';
      expect('NULL');
      return { ref, operator };
    }
    const operator = at()?.kind === 'symbol' ? at().value : undefined;
    if (!comparison.has(operator)) throw Error('Use a comparison or IS NULL filter on one source column.');
    cursor++;
    const negative = claim('-');
    const token = tokens[cursor++];
    if (token?.kind === 'number' && /^\d{1,20}$/.test(token.value)) {
      return { ref, operator, value: (negative ? '-' : '') + token.value, kind: 'integer' };
    }
    if (!negative && token?.kind === 'string' && token.value.length <= 1024 && !/[\x00-\x1f]/.test(token.value)) {
      return { ref, operator, value: token.value, kind: 'text' };
    }
    throw Error('Use an integer or bounded single-quoted string as the filter value.');
  }
  expect('SELECT');
  const select = [];
  do {
    const ref = column();
    select.push({ ref, label: claim('AS') ? name() : ref.name });
    if (select.length > 32) throw Error('Select up to 32 columns.');
  } while (claim(','));
  if (new Set(select.map(item => item.label.toLowerCase())).size !== select.length) throw Error('Use distinct result column names with AS.');
  expect('FROM');
  const left = relation('source1');
  const join = claim('LEFT') ? 'left' : 'inner';
  if (join === 'left') claim('OUTER');
  else claim('INNER');
  expect('JOIN');
  const right = relation('source2');
  if (left.alias === right.alias) throw Error('Use different aliases for the two sources.');
  expect('ON');
  const first = column();
  expect('=');
  const second = column();
  const keys = first.alias === left.alias ? [first, second] : [second, first];
  if (keys[0].alias !== left.alias || keys[1].alias !== right.alias) throw Error('Use one join key from each source.');
  const filters = [];
  if (claim('WHERE')) {
    do {
      filters.push(condition());
      if (filters.length > 16) throw Error('Use up to 16 filters.');
    } while (claim('AND'));
  }
  if (join === 'left' && filters.some(item => item.ref.alias === right.alias)) {
    throw Error('LEFT JOIN filters can reference the left source. Right-side WHERE needs evaluation after null extension.');
  }
  let resultLimit = null;
  if (claim('LIMIT')) {
    const token = tokens[cursor++];
    if (token?.kind !== 'number' || !/^\d{1,4}$/.test(token.value) || Number(token.value) < 1 || Number(token.value) > RESULT_ROWS) {
      throw Error('Use a literal LIMIT from 1 to ' + RESULT_ROWS + '.');
    }
    resultLimit = Number(token.value);
  }
  claim(';');
  if (cursor !== tokens.length) throw Error('Use one supported SELECT with equality JOIN, optional AND filters, and optional LIMIT.');
  return { sources: [left, right], select, join, keys, filters, resultLimit };
}

function parseFederatedSelect(text) {
  try { return parseSelect(text); }
  catch (error) { throw failure(error.message); }
}

function planSource(catalog, relation, key, selected, filters) {
  if (!catalog?.database) throw Error('The selected source catalog is unavailable.');
  const matches = (catalog.tables || []).filter(item => catalog.tableNameCaseSensitive === false
    ? item.name.toLowerCase() === relation.table.toLowerCase() : item.name === relation.table);
  if (matches.length !== 1) throw Error('The selected table is missing or ambiguous in ' + relation.source + '.');
  const [table] = matches;
  if (table.kind !== 'table' || !fieldName.test(table.name) || table.name.startsWith('__rb_')) throw Error('Choose a visible base table.');
  function resolve(ref) {
    const observed = table.columns.filter(column => column.name.toLowerCase() === ref.name.toLowerCase());
    if (observed.length !== 1 || !fieldName.test(observed[0].name)) throw Error('The column ' + ref.name + ' is missing or ambiguous in ' + relation.source + '.');
    return observed[0];
  }
  const joinKey = resolve(key);
  if (!integerType.test(joinKey.type)) throw Error('Both join keys must be observed integer columns.');
  const columns = [joinKey, ...selected.map(item => resolve(item.ref))];
  const unique = [...new Map(columns.map(item => [item.name, item])).values()];
  const values = [];
  const where = filters.map(item => {
    const field = resolve(item.ref);
    if (!item.kind) return quote(field.name) + ' ' + item.operator;
    if (item.kind === 'integer' && !integerType.test(field.type) || item.kind === 'text' && !textType.test(field.type)) {
      throw Error('Match the filter value type to the observed integer or text column.');
    }
    values.push(item.value);
    return quote(field.name) + ' ' + item.operator + (item.kind === 'integer' ? ' CAST(? AS DECIMAL(65,0))' : ' ?');
  });
  const sql = 'SELECT ' + unique.map(item => quote(item.name)).join(', ') + ' FROM ' + quote(catalog.database) + '.' + quote(table.name) +
    (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' LIMIT ' + (SOURCE_ROWS + 1);
  return { relation, sql, values, index: ref => unique.indexOf(resolve(ref)), type: ref => resolve(ref).type,
    explain: { source: relation.source, table: table.name, projected: unique.map(item => item.name), filters: where, sentValues: values.length } };
}

function keyOf(value) {
  if (value === null) return null;
  if (Number.isSafeInteger(value) || typeof value === 'string' && /^-?\d{1,20}$/.test(value)) return BigInt(value);
  throw Error('The server returned a join key that could not be represented exactly.');
}

function joinedRows(query, projection, left, right) {
  const index = new Map();
  for (const row of right) {
    const key = keyOf(row[0]);
    if (key === null) continue;
    const list = index.get(key) || [];
    list.push(row);
    index.set(key, list);
  }
  const rows = [];
  let bytes = 0;
  for (const input of left) {
    const matches = index.get(keyOf(input[0])) || (query.join === 'left' ? [null] : []);
    for (const match of matches) {
      if (rows.length >= (query.resultLimit ?? RESULT_ROWS)) {
        if (query.resultLimit !== null) return rows;
        throw Error('The join exceeds the result row limit. Refine filters or add LIMIT.');
      }
      const row = projection.map(field => field.sourceIndex === 0 ? input[field.index] : match === null ? null : match[field.index]);
      bytes += Buffer.byteLength(JSON.stringify(row));
      if (bytes > RESULT_BYTES) throw Error('The joined result exceeds 4 MiB. Refine the selected columns or filters.');
      rows.push(row);
    }
  }
  return rows;
}

async function executeFederatedSelect(query, sources) {
  if (!Array.isArray(sources) || sources.length !== 2) throw failure('Select two database profiles.');
  const aliases = query.sources.map(relation => relation.alias);
  const indexOf = ref => aliases.indexOf(ref.alias);
  if ([...query.select, ...query.filters].some(item => indexOf(item.ref) < 0)) throw failure('Use only the two declared source aliases.');
  const catalogs = await Promise.allSettled(sources.map(source => source.catalog()));
  for (const outcome of catalogs) if (outcome.status === 'rejected') throw outcome.reason;
  const plans = query.sources.map((relation, i) => {
    try {
      return planSource(catalogs[i].value, relation, query.keys[i],
        query.select.filter(item => indexOf(item.ref) === i), query.filters.filter(item => indexOf(item.ref) === i));
    } catch (error) { throw failure(error.message); }
  });
  const projection = query.select.map(item => {
    const sourceIndex = indexOf(item.ref), plan = plans[sourceIndex];
    return { sourceIndex, index: plan.index(item.ref), column: { name: item.label, type: plan.type(item.ref), source: plan.relation.source } };
  });
  const settled = await Promise.allSettled(plans.map((plan, i) => sources[i].read(plan.sql, plan.values, SOURCE_ROWS + 1)));
  const inputs = settled.map((outcome, index) => {
    if (outcome.status === 'rejected') throw outcome.reason;
    const result = outcome.value;
    if (result.truncated || result.rows.length > SOURCE_ROWS) throw failure('Source ' + (index + 1) + ' exceeds its read limit. Refine source filters.');
    const projected = plans[index].explain.projected;
    if (!integerFieldTypes.has(result.fields?.[0]?.type) || result.columns?.length !== projected.length ||
        !projected.every((column, ordinal) => result.columns[ordinal] === column)) {
      throw failure('Source ' + (index + 1) + ' changed its projection or integer join key after inspection.');
    }
    return result.rows;
  });
  let rows;
  try { rows = joinedRows(query, projection, ...inputs); }
  catch (error) { throw failure(error.message); }
  return { columns: projection.map(item => item.column), rows, rowCount: rows.length, join: query.join,
    inputs: plans.map(({ explain }, index) => ({ ...explain, rows: inputs[index].length })), crossServerSnapshot: false };
}

module.exports = { parseFederatedSelect, executeFederatedSelect, isFederatedDocument, templateHeader };
