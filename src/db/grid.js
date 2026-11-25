'use strict';
const { createHash, randomUUID } = require('node:crypto');
const { compileGridSort, observeSortCollations, sortOptions } = require('./grid-sort');
const { jsonCursorBound } = require('./grid-json-sort');
const { protectionError, tableProtection } = require('./write-protection');
const QUOTE = String.fromCharCode(96);
const quote = name => QUOTE + name.replaceAll(QUOTE, QUOTE + QUOTE) + QUOTE;
const fail = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });
const MAX_CHANGES = 500, MAX_CELL_BYTES = 128 * 1024;

function columnKind(type) {
  const base = type.toLowerCase().split('(')[0].trim().split(' ')[0];
  if (['tinyint', 'smallint', 'mediumint', 'int', 'integer', 'bigint', 'year'].includes(base)) return 'integer';
  if (['decimal', 'numeric'].includes(base)) return 'decimal';
  if (['float', 'double', 'real'].includes(base)) return 'float';
  if (['binary', 'varbinary', 'tinyblob', 'blob', 'mediumblob', 'longblob', 'bit'].includes(base)) return 'binary';
  if (base === 'json') return 'json';
  if (['date', 'datetime', 'timestamp', 'time'].includes(base)) return 'datetime';
  if (['char', 'varchar', 'tinytext', 'text', 'mediumtext', 'longtext', 'enum', 'set'].includes(base)) return 'text';
  return 'unsupported';
}
function columnDefinition(row) {
  const [name, type, nullable, defaultValue, key, extra, generationExpression, charset = null, collation = null] = row;
  const generated = Boolean(generationExpression) || /\b(?:VIRTUAL|STORED)\s+GENERATED\b/i.test(extra || '');
  const autoIncrement = /\bauto_increment\b/i.test(extra || '');
  const kind = columnKind(type), primaryKey = key === 'PRI';
  return { name, type, kind, nullable: nullable === 'YES', defaultValue, primaryKey, generated, autoIncrement,
    extra: extra || '', generationExpression: generationExpression || '', charset, collation,
    editable: !primaryKey && !generated && kind !== 'unsupported',
    insertable: !generated && !autoIncrement && kind !== 'unsupported',
    required: nullable !== 'YES' && defaultValue == null && !generated && !autoIncrement };
}
function typedCell(input, column) {
  let value;
  if (input === null || input?.kind === 'null') {
    if (!column.nullable) throw fail('ROCKETBRAIN_GRID_VALUE', column.name + ' cannot be NULL.');
    return { parameter: null, display: null };
  }
  if (typeof input === 'string') value = input;
  else if (input && input.kind === 'value' && typeof input.text === 'string') value = input.text;
  else throw fail('ROCKETBRAIN_GRID_VALUE', 'Use explicit text or NULL for ' + column.name + '.');
  if (Buffer.byteLength(value, 'utf8') > MAX_CELL_BYTES) throw fail('ROCKETBRAIN_GRID_VALUE', 'A grid edit cell exceeds 128 KiB.');
  let parameter = value;
  switch (column.kind) {
    case 'integer': {
      if (!/^[+-]?\d+$/.test(value)) throw fail('ROCKETBRAIN_GRID_VALUE', column.name + ' requires an integer.');
      const number = BigInt(value), unsigned = /\bunsigned\b/i.test(column.type);
      const base = column.type.toLowerCase().split('(')[0].trim().split(' ')[0];
      const bits = { tinyint: 8, smallint: 16, mediumint: 24, int: 32, integer: 32, bigint: 64, year: 16 }[base];
      const min = unsigned ? 0n : -(1n << BigInt(bits - 1)), max = (1n << BigInt(bits - (unsigned ? 0 : 1))) - 1n;
      if (number < min || number > max || base === 'year' && number !== 0n && (number < 1901n || number > 2155n)) throw fail('ROCKETBRAIN_GRID_VALUE', column.name + ' is outside its integer range.');
      parameter = number.toString(); break;
    }
    case 'decimal': {
      if (!/^[+-]?\d+(?:\.\d+)?$/.test(value)) throw fail('ROCKETBRAIN_GRID_VALUE', column.name + ' requires decimal text.');
      const parts = value.replace(/^[+-]/, '').split('.'), spec = /\((\d+),(\d+)\)/.exec(column.type);
      if (/\bunsigned\b/i.test(column.type) && value.startsWith('-')) throw fail('ROCKETBRAIN_GRID_VALUE', column.name + ' is unsigned.');
      if (spec && ((parts[0].replace(/^0+/, '').length || 0) > Number(spec[1]) - Number(spec[2]) || (parts[1]?.length || 0) > Number(spec[2]))) throw fail('ROCKETBRAIN_GRID_VALUE', column.name + ' exceeds its decimal precision or scale.');
      break;
    }
    case 'float':
      if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) || !Number.isFinite(Number(value))) throw fail('ROCKETBRAIN_GRID_VALUE', column.name + ' requires a finite number.');
      break;
    case 'binary':
      if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) throw fail('ROCKETBRAIN_GRID_VALUE', column.name + ' requires even-length 0x hexadecimal bytes.');
      parameter = Buffer.from(value.slice(2), 'hex'); break;
    case 'json':
      try { JSON.parse(value); } catch { throw fail('ROCKETBRAIN_GRID_VALUE', column.name + ' requires valid JSON text.'); }
      break;
    case 'datetime':
      if (!/^(?:\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?)?|-?\d{1,3}:\d{2}:\d{2}(?:\.\d{1,6})?)$/.test(value)) throw fail('ROCKETBRAIN_GRID_VALUE', column.name + ' requires database date/time text.');
      break;
    case 'unsupported': throw fail('ROCKETBRAIN_GRID_VALUE', column.name + ' has an unsupported editor type.');
  }
  return { parameter, display: Buffer.isBuffer(parameter) ? '0x' + parameter.toString('hex') : parameter };
}
function snapshotParameter(value, column) {
  if (value === null) return null;
  if (column.kind === 'binary') return Buffer.from(String(value).slice(2), 'hex');
  return typeof value === 'number' ? String(value) : value;
}
/** Normalize only the volatile AUTO_INCREMENT table option in server-generated
 * SHOW CREATE output. Quoted defaults/comments and column clauses stay exact.
 * This is a catalog fingerprint helper, not an executable SQL parser. */
function normalizedCreate(sql) {
  let result = '', quote = '', depth = 0;
  for (let i = 0; i < sql.length;) {
    const c = sql[i];
    if (quote) {
      result += c; i++;
      if (c === '\\' && i < sql.length) { result += sql[i++]; continue; }
      if (c === quote) {
        if (sql[i] === quote) result += sql[i++];
        else quote = '';
      }
      continue;
    }
    if (c === "'" || c === '"' || c === QUOTE) { quote = c; result += c; i++; continue; }
    if (sql.startsWith('/*', i)) {
      const end = sql.indexOf('*/', i + 2), next = end < 0 ? sql.length : end + 2;
      result += sql.slice(i, next); i = next; continue;
    }
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (depth === 0) {
      const option = /^AUTO_INCREMENT\s*=\s*\d+/i.exec(sql.slice(i));
      if (option && !/[A-Za-z0-9_$]/.test(sql[i - 1] || '')) { result += 'AUTO_INCREMENT=<counter>'; i += option[0].length; continue; }
    }
    result += c; i++;
  }
  return result;
}
function fingerprint(definition) {
  return JSON.stringify({ table: definition.name, engine: definition.engine, kind: definition.kind,
    createSql: definition.createSql,
    columns: definition.columns, indexes: definition.indexes, foreignKeys: definition.foreignKeys, checks: definition.checks,
    triggers: definition.triggers, triggerVisibility: definition.triggerVisibility });
}
function equalRows(left, right) {
  return left.length === right.length && left.every((value, i) => value === right[i]);
}
const reviewDigest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const retainedValues = values => Object.fromEntries(values.map(value => [value.column.name, value.display]));
const draftValues = values => Object.fromEntries(Object.entries(values).map(([name, value]) =>
  [name, value === null ? { kind: 'null' } : { kind: 'value', text: value }]));
const viewParameter = value => Buffer.isBuffer(value) ? '0x' + value.toString('hex') : value;
const reviewRowChanged = () => fail('ROCKETBRAIN_GRID_CONFLICT', 'A saved row is absent or its exact values changed.');
const MAX_PAGE = 2000;
const choiceType = /^(enum|set)\(/i;
function keysetValue(column, value, cast) {
  const choice = choiceType.exec(column.type);
  if (choice) {
    const ordinal = String(value), signed = cast === 'SIGNED';
    const minimum = signed ? -9223372036854775808n : 0n;
    const maximum = choice[1].toLowerCase() === 'enum' ? 65535n : signed ? 9223372036854775807n : 18446744073709551615n;
    if (!/^-?\d{1,20}$/u.test(ordinal) || BigInt(ordinal) < minimum || BigInt(ordinal) > maximum) {
      throw fail('ROCKETBRAIN_GRID_QUERY', 'The observed ENUM or SET continuation value is invalid.');
    }
    return { sql: 'CAST(? AS ' + (signed ? 'SIGNED' : 'UNSIGNED') + ')', parameter: ordinal };
  }
  const { parameter } = typedCell(value === null ? null : String(value), column);
  if (column.kind === 'integer') {
    return { sql: /\bunsigned\b/i.test(column.type) ? 'CAST(? AS UNSIGNED)' : 'CAST(? AS SIGNED)', parameter };
  }
  if (column.kind === 'decimal') {
    const precision = /^(?:decimal|numeric)\((\d{1,2}),(\d{1,2})\)/i.exec(column.type);
    if (!precision) throw fail('ROCKETBRAIN_GRID_QUERY', 'A decimal sort column needs observed precision and scale.');
    return { sql: 'CAST(? AS DECIMAL(' + precision[1] + ',' + precision[2] + '))', parameter };
  }
  return { sql: '?', parameter: column.kind === 'float' ? Number(parameter) : parameter };
}
const keyExpression = ({ sql, cursorCast }) => cursorCast ? 'CAST(' + sql + ' AS ' + cursorCast + ')' : sql;
const nullableOrder = ({ nulls, direction }) => nulls === 'first' || nulls === undefined && direction === 'asc';
function keysetFragments(item) {
  const sql = keyExpression(item);
  return [
    ...(item.nulls === undefined ? [] : ['(' + sql + ' IS NULL) ' + (nullableOrder(item) ? 'DESC' : 'ASC')]),
    sql + ' ' + item.direction.toUpperCase()
  ];
}
function invertDirection(item) {
  return { ...item, direction: item.direction === 'asc' ? 'desc' : 'asc',
    ...(item.nulls !== undefined && { nulls: item.nulls === 'first' ? 'last' : 'first' }) };
}

function keysetOrder(order, columns, dialect) {
  const names = new Set([...columns.keys()].map(name => name.toLowerCase()));
  let index = 0;
  return order.map(item => {
    const type = !item.collation && choiceType.exec(columns.get(item.column).type)?.[1].toLowerCase();
    if (!type && !item.cursorKind) return item;
    if (!['mysql', 'mariadb'].includes(dialect)) {
      throw fail('ROCKETBRAIN_GRID_QUERY', 'Observe the database engine before sorting ENUM or SET keys or JSON scalar paths.');
    }
    let cursorAlias;
    do { cursorAlias = '__rb_grid_seek_' + index++; } while (names.has(cursorAlias));
    names.add(cursorAlias);
    // Native MySQL SET order is signed. A direct cast preserves all bits and avoids arithmetic coercion.
    const cursorCast = type ? (type === 'set' && dialect === 'mysql' ? 'SIGNED' : 'UNSIGNED') : undefined;
    return { ...item, cursorAlias, cursorCast };
  });
}

function continuationValue(column, item, value) {
  if (item.cursorKind) return jsonCursorBound(value, item.cursorKind);
  if (item.collation) return { sql: '?', parameter: typedCell(String(value), column).parameter };
  return keysetValue(column, value, item.cursorCast);
}

function keysetAfter(order, columns, anchor) {
  if (anchor.length !== order.length) throw fail('ROCKETBRAIN_GRID_QUERY', 'The keyset position no longer matches the sort.');
  const alternatives = [], parameters = [], prefix = [], previous = [];
  for (const [index, item] of order.entries()) {
    const { column, direction } = item, name = keyExpression(item), value = anchor[index];
    const nullsFirst = nullableOrder(item);
    if (value === null) {
      if (nullsFirst) {
        alternatives.push('(' + [...prefix, name + ' IS NOT NULL'].join(' AND ') + ')');
        parameters.push(...previous);
      }
      prefix.push(name + ' IS NULL');
      continue;
    }
    const bound = continuationValue(columns.get(column), item, value);
    const comparison = name + (direction === 'asc' ? ' > ' : ' < ') + bound.sql;
    const condition = nullsFirst ? comparison : '(' + comparison + ' OR ' + name + ' IS NULL)';
    alternatives.push('(' + [...prefix, condition].join(' AND ') + ')');
    parameters.push(...previous, bound.parameter);
    prefix.push(name + ' <=> ' + bound.sql);
    previous.push(bound.parameter);
  }
  return { sql: alternatives.length ? '(' + alternatives.join(' OR ') + ')' : '0 = 1', parameters };
}
/** Compile only catalog-backed identifiers and explicitly typed bound values. */
function browseQuery(definition, input = {}, schema, related = false, collations = {}, cursor, reverse = false, dialect, readLimit) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('ROCKETBRAIN_GRID_QUERY', 'Choose table paging, sorting and filter options.');
  if (Object.keys(input).some(key => !['page', 'pageSize', 'maxRows', 'sort', 'filters', 'sessionId'].includes(key))) throw fail('ROCKETBRAIN_GRID_QUERY', 'Unsupported table browsing option.');
  const page = input.page ?? 0, pageSize = input.pageSize ?? input.maxRows ?? 200;
  if (!Number.isInteger(page) || page < 0 || page > MAX_PAGE) throw fail('ROCKETBRAIN_GRID_QUERY', 'Page index must be between 0 and 2000.');
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500) throw fail('ROCKETBRAIN_GRID_QUERY', 'Page size must be between 1 and 500.');
  const columns = new Map(definition.columns.map(column => [column.name, column]));
  const pk = definition.columns.filter(column => column.primaryKey), parameters = [], where = [], filters = [];
  if (page && !pk.length) throw fail('ROCKETBRAIN_GRID_QUERY', 'A primary key is required for stable page navigation.');
  if (!Array.isArray(input.sort || []) || (input.sort || []).length > 8 || !Array.isArray(input.filters || []) || (input.filters || []).length > 20) throw fail('ROCKETBRAIN_GRID_QUERY', 'Use at most 8 sort columns and 20 filters.');
  const { sort, order, fragments, keys } = compileGridSort(definition.columns, input.sort || [], collations);
  if (cursor && (!pk.length || keys.some(({ column, expression, cursorKind }) =>
    expression !== undefined || !cursorKind && ['json', 'unsupported'].includes(columns.get(column).kind)))) {
    throw fail('ROCKETBRAIN_GRID_QUERY', 'Choose a primary-key table and scalar columns or typed JSON paths for keyset browsing.');
  }
  const operators = { eq: '=', ne: '<>', lt: '<', lte: '<=', gt: '>', gte: '>=' };
  let conditions = 0, groups = 0;
  function buildFilter(item, depth) {
    if (item && Object.hasOwn(item, 'logic')) {
      if (!['and', 'or'].includes(item.logic) || !Array.isArray(item.filters) || !item.filters.length || item.filters.length > 20 ||
          Object.keys(item).some(key => !['logic', 'filters'].includes(key)) || depth >= 3 || ++groups > 20) {
        throw fail('ROCKETBRAIN_GRID_QUERY', 'Use nonempty AND or OR groups nested at most three levels.');
      }
      const children = item.filters.map(filter => buildFilter(filter, depth + 1));
      return { sql: '(' + children.map(child => child.sql).join(item.logic === 'or' ? ' OR ' : ' AND ') + ')',
        filter: { logic: item.logic, filters: children.map(child => child.filter) } };
    }
    if (++conditions > 20) throw fail('ROCKETBRAIN_GRID_QUERY', 'Use at most 20 conditions across filter groups.');
    const column = columns.get(item?.column), operator = item?.operator;
    if (!column || ![...Object.keys(operators), 'contains', 'startsWith', 'endsWith', 'isNull', 'isNotNull'].includes(operator)) throw fail('ROCKETBRAIN_GRID_QUERY', 'Select a catalog column and a supported filter operator.');
    const name = quote(column.name), isNull = item.value === null || item.value?.kind === 'null';
    if (operator === 'isNull' || operator === 'isNotNull' || isNull && ['eq', 'ne'].includes(operator)) {
      const negate = operator === 'isNotNull' || operator === 'ne';
      return { sql: name + (negate ? ' IS NOT NULL' : ' IS NULL'), filter: { column: column.name, operator: negate ? 'isNotNull' : 'isNull' } };
    }
    const binaryRelation = related && operator === 'eq' && column.kind === 'binary' && /^(?:var)?binary\(\d+\)$/i.test(column.type);
    if (isNull || ['json', 'unsupported'].includes(column.kind) || column.kind === 'binary' && !binaryRelation) throw fail('ROCKETBRAIN_GRID_QUERY', 'This filter requires a supported non-NULL scalar value.');
    const value = typeof item.value === 'string' ? { kind: 'value', text: item.value } : item.value;
    if (!value || value.kind !== 'value' || typeof value.text !== 'string' || Buffer.byteLength(value.text, 'utf8') > 8192) throw fail('ROCKETBRAIN_GRID_QUERY', 'A filter requires at most 8 KiB of explicit text.');
    const typed = typedCell(value, column);
    let sql;
    if (['contains', 'startsWith', 'endsWith'].includes(operator)) {
      if (column.kind !== 'text') throw fail('ROCKETBRAIN_GRID_QUERY', 'Text matching requires a text column.');
      const literal = typed.parameter.replace(/[=%_]/g, character => '=' + character);
      sql = name + " LIKE ? ESCAPE '='"; parameters.push((operator !== 'startsWith' ? '%' : '') + literal + (operator !== 'endsWith' ? '%' : ''));
    } else {
      let binding = '?', parameter = typed.parameter;
      if (related && operator === 'eq') {
        if (column.kind === 'integer') binding = /\bunsigned\b/i.test(column.type) ? 'CAST(? AS UNSIGNED)' : 'CAST(? AS SIGNED)';
        if (column.kind === 'decimal') {
          const spec = /^decimal\((\d{1,2}),(\d{1,2})\)/i.exec(column.type);
          if (!spec) throw fail('ROCKETBRAIN_GRID_QUERY', 'This relationship requires observed decimal precision.');
          binding = `CAST(? AS DECIMAL(${spec[1]},${spec[2]}))`;
        }
        if (column.kind === 'float') parameter = Number(parameter);
      }
      sql = name + ' ' + operators[operator] + ' ' + binding;
      parameters.push(parameter);
    }
    return { sql, filter: { column: column.name, operator, value: { kind: 'value', text: value.text } } };
  }
  for (const item of input.filters || []) {
    const compiled = buildFilter(item, 0);
    where.push(compiled.sql);
    filters.push(compiled.filter);
  }
  if (Buffer.byteLength(JSON.stringify(filters), 'utf8') > 65536) throw fail('ROCKETBRAIN_GRID_QUERY', 'Combined table filters exceed 64 KiB.');
  const seekOrder = cursor ? keysetOrder(keys, columns, dialect) : order;
  const scanOrder = reverse ? seekOrder.map(invertDirection) : seekOrder;
  if (cursor?.length) {
    const seek = keysetAfter(scanOrder, columns, cursor);
    where.push(seek.sql);
    parameters.push(...seek.parameters);
  }
  const orderBy = cursor ? scanOrder.flatMap(keysetFragments) : fragments;
  const hidden = seekOrder.filter(item => item.cursorAlias);
  const selected = definition.columns.map(column => quote(column.name)).concat(hidden.map(item => keyExpression(item) + ' AS ' + quote(item.cursorAlias)));
  const sql = 'SELECT ' + selected.join(',') + ' FROM ' + quote(schema) + '.' + quote(definition.name)
    + (where.length ? ' WHERE ' + where.join(' AND ') : '') + (orderBy.length ? ' ORDER BY ' + orderBy.join(',') : '')
    + ' LIMIT ' + (readLimit ?? pageSize + 1) + (cursor ? '' : ' OFFSET ' + (page * pageSize));
  return { sql, parameters, page, pageSize, order, ...(cursor && { seekOrder, cursorColumns: hidden.map(item => item.cursorAlias) }), query: { page, pageSize, sort, filters }, pageable: pk.length > 0,
    consistency: pk.length ? 'Offset pages use explicit ordering plus primary-key tiebreakers. Concurrent inserts, deletes or sort-value changes may move rows between pages; no cross-page snapshot is implied.' : 'No primary key is visible. Only the first page is available; tied rows have no stable cross-page order.' };
}

class TableEditor {
  constructor(database) {
    this.db = database; this.models = new Map(); this.reviews = new Map(); this.keysetBrowsers = new Map();
  }
  async openKeysetBrowser(name, options = {}) {
    if (this.keysetBrowsers.size >= 8) throw fail('ROCKETBRAIN_GRID_QUERY', 'Close an existing table snapshot before opening another.');
    const id = randomUUID(), sessionId = 'keyset:' + id, schema = this.db._options.database;
    const browser = { sessionId, schema, name, page: 0, anchors: new Map() };
    this.keysetBrowsers.set(id, browser);
    try {
      const definition = await this.definition(name, schema);
      if (definition.kind !== 'BASE TABLE' || String(definition.engine).toUpperCase() !== 'INNODB') {
        throw fail('ROCKETBRAIN_GRID_QUERY', 'Choose an InnoDB table for a consistent snapshot.');
      }
      await this.db.openSession(sessionId, { readOnly: true });
      await this.db.setTransactionIsolation('REPEATABLE READ', { sessionId });
      const transaction = await this.db._transaction('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY',
        { sessionId }, { requireIdle: true });
      browser.definition = definition;
      browser.connectionId = transaction.connectionId;
      const session = this.db._session(sessionId);
      const engine = await this.db._enqueue(session, () => this._read(session, 'SELECT VERSION()', [], 1));
      const version = engine.rows[0]?.[0];
      if (typeof version !== 'string' || !/^\d+\.\d+/u.test(version)) throw fail('ROCKETBRAIN_GRID_QUERY', 'The database engine for the read snapshot could not be observed.');
      browser.dialect = /mariadb/i.test(version) ? 'mariadb' : 'mysql';
      browser.collations = await this.db._enqueue(session, () => observeSortCollations(definition.columns,
        async (sql, values, limit) => (await this._read(session, sql, values, limit)).rows));
      const result = await this.readKeysetPage(id, { ...options, page: 0 });
      if (fingerprint(definition) !== fingerprint(await this.definition(name, schema))) {
        throw fail('ROCKETBRAIN_GRID_SCHEMA_CHANGED', 'The table changed while opening its read snapshot.');
      }
      return { id, result };
    } catch (error) {
      await this.closeKeysetBrowser(id);
      throw error;
    }
  }
  async readKeysetPage(id, options = {}, adjacentTo) {
    const browser = this.keysetBrowsers.get(id);
    if (!browser?.definition) throw fail('ROCKETBRAIN_GRID_QUERY', 'Open a current table snapshot.');
    const { definition, sessionId, schema } = browser;
    const session = this.db._session(sessionId);
    return this.db._enqueue(session, async () => {
      if (!session.readOnly || !session.inTransaction || session.connectionId !== browser.connectionId ||
          this.keysetBrowsers.get(id) !== browser) throw fail('ROCKETBRAIN_GRID_STALE', 'The table snapshot ended. Open it again.');
      const page = options.page ?? 0;
      const from = adjacentTo ?? browser.page;
      const anchor = browser.anchors.get(from);
      if (!Number.isSafeInteger(page) || page < 0 || (adjacentTo !== undefined && (!anchor || Math.abs(page - from) !== 1)) ||
          (page !== 0 && Math.abs(page - from) > 1)) {
        throw fail('ROCKETBRAIN_GRID_QUERY', 'Move through the snapshot one page at a time.');
      }
      const first = browseQuery(definition, { ...options, page: 0 }, schema, false, browser.collations, [], false, browser.dialect);
      const signature = JSON.stringify(first.query);
      let cursor=[], reverse=false;
      if ((page > 0 || adjacentTo !== undefined) && signature !== browser.signature) {
        throw fail('ROCKETBRAIN_GRID_QUERY', 'Open the first page after changing size, sorting or filters.');
      }
      if (page > 0) {
        if (page === from) ({ cursor, reverse } = anchor.position);
        else if (page < from) { cursor = anchor.first; reverse = true; }
        else if (anchor.hasNext) cursor = anchor.last;
        else throw fail('ROCKETBRAIN_GRID_QUERY', 'The current snapshot has no next page.');
      }
      const plan = cursor.length ? browseQuery(definition, first.query, schema, false, browser.collations, cursor, reverse, browser.dialect) : first;
      const result = await this._read(session, plan.sql, plan.parameters, plan.pageSize + 1);
      if (result.truncated || !session.inTransaction || !session.connected || this.keysetBrowsers.get(id) !== browser) {
        throw fail('ROCKETBRAIN_GRID_STALE', 'The table snapshot ended or the page exceeded the byte limit. Open a fresh snapshot.');
      }
      const visible = definition.columns.map(column => column.name), expected = [...visible, ...plan.cursorColumns];
      if (!equalRows(result.columns, expected)) {
        throw fail('ROCKETBRAIN_GRID_SCHEMA_CHANGED', 'The table column projection changed during keyset browsing.');
      }
      const extra = result.rows.length > plan.pageSize;
      result.rows = result.rows.slice(0, plan.pageSize);
      if (reverse) result.rows.reverse();
      result.rowCount = result.rows.length;
      if (result.spatial) result.spatial = result.spatial.filter(item => item.row < result.rowCount)
        .map(item => reverse ? { ...item, row: result.rowCount - 1 - item.row } : item);
      const key = row => row ? plan.seekOrder.map(item => row[expected.indexOf(item.cursorAlias || item.column)]) : [];
      const hasNext = reverse || extra, hasPrevious = reverse ? extra : page > 0;
      if (signature !== browser.signature) browser.anchors.clear();
      browser.anchors.delete(page);
      browser.anchors.set(page, { first: key(result.rows[0]), last: key(result.rows.at(-1)), hasNext, position: { cursor, reverse } });
      while (browser.anchors.size > 8) browser.anchors.delete(browser.anchors.keys().next().value);
      browser.signature = signature; browser.page = page;
      if (plan.cursorColumns.length) {
        result.columns = visible;
        result.fields = result.fields?.slice(0, visible.length);
        result.rows = result.rows.map(row => row.slice(0, visible.length));
      }
      const query = { ...plan.query, page };
      const reason = 'This read-only page belongs to an InnoDB consistent snapshot.';
      result.state = this.db._state(session);
      result.browse = { ...query, order: plan.order, hasNext, hasPrevious,
        pageable: true, sql: plan.sql, consistency: reason, totalRows: null, keyset: true,
        sortOptions: sortOptions(definition.columns, browser.collations, true) };
      result.edit = { modelId: randomUUID(), table: browser.name, query, columns: definition.columns, canEdit: false, reason,
        rowIds: result.rows.map(() => randomUUID()), hasMorePossible: hasNext, insertable: false };
      return result;
    });
  }
  async closeKeysetBrowser(id) {
    const browser = this.keysetBrowsers.get(id);
    if (!browser) return;
    this.keysetBrowsers.delete(id);
    await this.db.closeSession(browser.sessionId);
  }
  retainTableSnapshot({ sessionId = 'default', modelId } = {}) {
    this._prune();
    const session = this.db._session(sessionId), model = this.models.get(modelId);
    if (!model || model.sessionId !== sessionId || model.connectionId !== session.connectionId || !session.connected || session.needsReconnect) {
      throw fail('ROCKETBRAIN_GRID_STALE', 'This table snapshot expired or its connection changed. Refresh the table.');
    }
    if (!model.retained && [...this.models.values()].filter(item => item.retained).length >= 16) {
      throw fail('ROCKETBRAIN_GRID_RETENTION_LIMIT', 'Close an unused table editor before retaining more than 16 table snapshots.');
    }
    model.retained = true;
    return { sessionId, modelId, retained: true };
  }
  releaseTableSnapshot({ sessionId = 'default', modelId } = {}) {
    let session;
    // Host cleanup can run after a console or the entire connection closes.
    try { session = this.db._session(sessionId); } catch { return false; }
    const model = this.models.get(modelId);
    if (!model || model.sessionId !== sessionId || model.connectionId !== session.connectionId) return false;
    const retained = Boolean(model.retained);
    model.retained = false;
    this._prune();
    return retained;
  }
  invalidate(sessionId) {
    for (const [id, model] of this.models) if (model.sessionId === sessionId) this.models.delete(id);
    for (const [id, review] of this.reviews) if (review.sessionId === sessionId) this.reviews.delete(id);
  }
  _prune() {
    const now = Date.now();
    for (const [id, model] of this.models) if (!model.retained && now - model.created > 10 * 60 * 1000) this.models.delete(id);
    for (const [id, review] of this.reviews) if (now - review.created > 2 * 60 * 1000) this.reviews.delete(id);
    for (const [id, model] of this.models) {
      if (this.models.size <= 40) break;
      if (!model.retained) this.models.delete(id);
    }
    while (this.reviews.size > 40) this.reviews.delete(this.reviews.keys().next().value);
  }
  async definition(name, schema = this.db._options.database, metadataRead) {
    if (typeof name !== 'string' || !name || name.includes('\0') || name.length > 64) throw fail('ROCKETBRAIN_GRID_TABLE', 'Select a table from the current database metadata.');
    const read = metadataRead ?? (async (sql, values) => (await this.db._metadataQuery(sql, values)).rows);
    const rows = await read('SELECT TABLE_NAME,TABLE_TYPE,ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=?', [schema, name]);
    if (rows.length !== 1 || rows[0][0] !== name) throw fail('ROCKETBRAIN_GRID_TABLE', 'The selected table no longer exists in the current database metadata.');
    const columns = (await read('SELECT COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,COLUMN_DEFAULT,COLUMN_KEY,EXTRA,GENERATION_EXPRESSION,CHARACTER_SET_NAME,COLLATION_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION', [schema, name])).map(columnDefinition);
    const createRows = await read('SHOW CREATE TABLE ' + quote(schema) + '.' + quote(rows[0][0]), []);
    const createSql = normalizedCreate(String(createRows[0]?.[1] || ''));
    const checks = await read("SELECT cc.CHECK_CLAUSE FROM information_schema.CHECK_CONSTRAINTS cc JOIN information_schema.TABLE_CONSTRAINTS tc ON tc.CONSTRAINT_SCHEMA=cc.CONSTRAINT_SCHEMA AND tc.CONSTRAINT_NAME=cc.CONSTRAINT_NAME WHERE tc.TABLE_SCHEMA=? AND tc.TABLE_NAME=? AND tc.CONSTRAINT_TYPE='CHECK' ORDER BY tc.CONSTRAINT_NAME", [schema, name]);
    // MariaDB represents its JSON alias as LONGTEXT plus JSON_VALID(column).
    for (const column of columns.filter(column => column.kind === 'text')) {
      const escaped = quote(column.name).replace(/[.*+?^$()|[\]\\]/g, '\\$&').replaceAll('{', '\\{').replaceAll('}', '\\}');
      const jsonCheck = new RegExp('^\\s*json_valid\\s*\\(\\s*' + escaped + '\\s*\\)\\s*$', 'i');
      if (checks.some(row => jsonCheck.test(row[0]))) { column.kind = 'json'; column.type += ' (JSON_VALID)'; }
    }
    const indexes = await read('SELECT INDEX_NAME,NON_UNIQUE,SEQ_IN_INDEX,COLUMN_NAME,SUB_PART,INDEX_TYPE FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY INDEX_NAME,SEQ_IN_INDEX', [schema, name]);
    const foreignKeys = await read('SELECT CONSTRAINT_NAME,COLUMN_NAME,ORDINAL_POSITION,REFERENCED_TABLE_SCHEMA,REFERENCED_TABLE_NAME,REFERENCED_COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND REFERENCED_TABLE_NAME IS NOT NULL ORDER BY CONSTRAINT_NAME,ORDINAL_POSITION', [schema, name]);
    const user = (await read('SELECT CURRENT_USER()', []))[0]?.[0];
    let triggerVisibility = false;
    if (typeof user === 'string' && /^[A-Za-z0-9_$.-]+@[A-Za-z0-9_%:.-]+$/.test(user)) {
      const split = user.lastIndexOf('@'), grantee = "'" + user.slice(0, split) + "'@'" + user.slice(split + 1) + "'";
      const privileges = await read("SELECT 'global' AS privilege_scope FROM information_schema.USER_PRIVILEGES WHERE GRANTEE=? AND PRIVILEGE_TYPE='TRIGGER' UNION ALL SELECT 'schema' FROM information_schema.SCHEMA_PRIVILEGES WHERE GRANTEE=? AND TABLE_SCHEMA=? AND PRIVILEGE_TYPE='TRIGGER' UNION ALL SELECT 'table' FROM information_schema.TABLE_PRIVILEGES WHERE GRANTEE=? AND TABLE_SCHEMA=? AND TABLE_NAME=? AND PRIVILEGE_TYPE='TRIGGER'", [grantee, grantee, schema, grantee, schema, name]);
      triggerVisibility = privileges.some(row => row[0] !== 'global');
      if (!triggerVisibility && privileges.length) {
        // MySQL global grants may be restricted by schema partial revokes.
        // Decline global-only visibility if any such restriction is present.
        const grants = await read('SHOW GRANTS FOR CURRENT_USER()', []);
        triggerVisibility = !grants.some(row => /^\s*REVOKE\b/i.test(String(row[0])));
      }
    }
    const triggers = (await read('SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=? AND EVENT_OBJECT_TABLE=? ORDER BY TRIGGER_NAME', [schema, name])).map(row => row[0]);
    return { name, kind: rows[0][1], engine: rows[0][2], createSql, columns, indexes, foreignKeys, checks, triggers, triggerVisibility };
  }
  previewTable(name, options = {}) {
    const { sessionId = 'default' } = options;
    const session = this.db._session(sessionId);
    return this.db._enqueue(session, () => this._preview(session, name, options));
  }
  previewRelatedTable(target, options = {}) {
    if (!target || typeof target.schema !== 'string' || !target.schema || target.schema.length > 64 || target.schema.includes('\0') ||
        !Array.isArray(target.keys) || !target.keys.length || target.keys.length > 16) {
      throw fail('ROCKETBRAIN_GRID_TABLE', 'Choose a verified related table.');
    }
    const session = this.db._session(options.sessionId ?? 'default');
    return this.db._enqueue(session, () => this._preview(session, target.table, options, undefined, target));
  }
  async _read(session, sql, values = [], maxRows = 500) {
    try {
      const result = await this.db._stream(session, sql, values, { maxRows, timeoutMs: 10000 }, !/^\s*SELECT\b/.test(sql));
      if (session.connected) await this.db._refreshState(session);
      return result;
    } catch (error) {
      if (session.connected) { try { await this.db._refreshState(session); } catch {} }
      error.state = this.db._state(session); throw error;
    }
  }
  async _preview(session, name, options, definition, related) {
    await this.db._ensureConnection(session);
    if (related?.sourceServer && await this.db._sqlRelatedServer(session) !== related.sourceServer) {
      throw fail('ROCKETBRAIN_GRID_STALE', 'The related preview is connected to a different server or account. Run the source query again.');
    }
    const schema = related?.schema ?? this.db._options.database;
    definition ||= await this.definition(name, schema);
    if (related && (!session.readOnly || !session.autocommit || session.inTransaction || definition.kind !== 'BASE TABLE' ||
        String(definition.engine).toUpperCase() !== 'INNODB')) {
      throw fail('ROCKETBRAIN_GRID_READ_ONLY', 'Use a read-only console to browse an observed related InnoDB table.');
    }
    if (related?.keys?.some(key => !definition.columns.some(column => column.name === key.name && column.type === key.type &&
      column.charset === key.charset && column.collation === key.collation))) {
      throw fail('ROCKETBRAIN_GRID_SCHEMA_CHANGED', 'The related key columns changed. Follow the relation again.');
    }
    const pk = definition.columns.filter(column => column.primaryKey);
    const restriction = tableProtection(this.db._writeProtection, schema, definition.name);
    if (this.db._writeProtection?.tables.length && !session.readOnly && definition.kind !== 'BASE TABLE') {
      throw protectionError('Use a read-only console to browse views while this profile protects tables.');
    }
    let reason = '';
    if (related) reason = 'Related rows are opened in a read-only preview.';
    else if (restriction) reason = restriction;
    else if (definition.kind !== 'BASE TABLE') reason = 'Views and arbitrary SQL results are read-only.';
    else if (String(definition.engine).toUpperCase() !== 'INNODB') reason = 'Editing currently requires an InnoDB table for transactional rollback.';
    else if (!pk.length) reason = 'A primary key is required to identify edited rows safely.';
    else if (pk.some(column => column.kind === 'unsupported')) reason = 'A primary-key type is not supported by this editor.';
    else if (!definition.triggerVisibility) reason = 'Trigger metadata visibility could not be verified for this account; editing is disabled.';
    else if (definition.triggers.length) reason = 'Tables with triggers are read-only until their transactional side effects can be verified.';
    if (!definition.columns.length) throw fail('ROCKETBRAIN_GRID_TABLE', 'The table has no visible columns.');
    const collations = await observeSortCollations(definition.columns, async (sql, values) => (await this.db._metadataQuery(sql, values)).rows);
    const browsing = browseQuery(definition, options, schema, Boolean(related), collations), maxRows = browsing.pageSize;
    const result = await this._read(session, browsing.sql, browsing.parameters, maxRows + 1);
    const hasNext = result.truncated ? null : result.rows.length > maxRows;
    if (result.rows.length > maxRows) result.rows = result.rows.slice(0, maxRows);
    result.rowCount = result.rows.length;
    const modelId = randomUUID(), rowIds = result.rows.map(() => randomUUID());
    this._prune();
    const model = { modelId, sessionId: session.id, connectionId: session.connectionId, definition, fingerprint: fingerprint(definition),
      rows: new Map(rowIds.map((id, index) => [id, [...result.rows[index]]])), maxRows, browseQuery: structuredClone(browsing.query),
      collations, completePage: !result.truncated, created: Date.now(), canEdit: !reason };
    this.models.set(modelId, model);
    this._prune();
    result.state = this.db._state(session);
    result.edit = { modelId, table: name, ...(related ? { schema } : {}), columns: structuredClone(definition.columns), rowIds, canEdit: !reason, reason,
      query: browsing.query, hasMorePossible: hasNext === true, insertable: !reason && !definition.columns.some(column => column.required && !column.insertable),
      concurrency: 'Primary-key locking read plus exact original visible-row comparison; a server-side delete/reinsert ABA without a version column cannot be detected.' };
    result.browse = { ...browsing.query, order: browsing.order, sortOptions: sortOptions(definition.columns, collations), hasNext, hasPrevious: browsing.page > 0, pageable: browsing.pageable, sql: browsing.sql, consistency: browsing.consistency, totalRows: null };
    return result;
  }
  _editableModel(session, modelId) {
    this._prune();
    const model = this.models.get(modelId);
    if (!model || model.sessionId !== session.id || model.connectionId !== session.connectionId) throw fail('ROCKETBRAIN_GRID_STALE', 'This table snapshot expired or its session changed. Refresh the table.');
    const restriction = tableProtection(this.db._writeProtection, this.db._options.database, model.definition.name);
    if (restriction) throw protectionError(restriction);
    if (!model.canEdit) throw fail('ROCKETBRAIN_GRID_READ_ONLY', 'This table is structurally read-only.');
    if (session.readOnly) throw fail('ROCKETBRAIN_READ_ONLY', 'Enable read/write mode explicitly before reviewing table changes.');
    return model;
  }
  stagePaste({ sessionId, modelId, parsed, draft, acrossPages, anchorRowId, anchorColumn, nullToken }) {
    const { planPaste, mergePasteDraft } = require('./grid-bulk');
    const session = this.db._session(sessionId);
    return this.db._enqueue(session, async () => {
      const model = this._editableModel(session, modelId);
      const rowIds = [...model.rows.keys()], anchor = rowIds.indexOf(anchorRowId);
      const count = anchor + parsed.rows.length;
      const draftRows = new Set([...draft.updates.map(update => update?.rowId), ...draft.deletes]);
      const extra = new Map([...(model.pasteRows ?? [])].filter(([id]) => draftRows.has(id)));
      const definition = model.definition;
      const columnModel = { canEdit: true, columns: definition.columns, rowIds };
      let range;
      if (acrossPages && anchor >= 0 && count > rowIds.length) {
        const query = model.browseQuery, lastPage = query.page + Math.floor((count - 1) / query.pageSize);
        if (!model.completePage || rowIds.length !== query.pageSize || lastPage > MAX_PAGE) {
          throw fail('ROCKETBRAIN_GRID_BULK', 'The selected paste does not fit the observed result pages.');
        }
        if (!session.connected || session.outcomeUnknown || session.needsReconnect) {
          throw fail('ROCKETBRAIN_GRID_STALE', 'Reconnect before capturing additional paste rows.');
        }
        const current = await this.definition(definition.name);
        if (fingerprint(current) !== model.fingerprint) throw fail('ROCKETBRAIN_GRID_SCHEMA_CHANGED', 'The table definition changed. Refresh the table before staging this paste.');
        const plan = browseQuery(current, query, this.db._options.database, false, model.collations, undefined, false, undefined, count);
        const result = await this._read(session, plan.sql, plan.parameters, count);
        if (result.truncated || !session.connected || this._editableModel(session, modelId) !== model ||
            !equalRows(result.columns, current.columns.map(column => column.name)) ||
            [...model.rows.values()].some((row, index) => !result.rows[index] || !equalRows(row, result.rows[index]))) {
          throw fail('ROCKETBRAIN_GRID_STALE', 'The current page no longer matches the captured rows. Refresh the table before staging this paste.');
        }
        if (result.rows.length !== count) throw fail('ROCKETBRAIN_GRID_BULK', 'There are too few matching rows on following pages for this paste.');
        const keyIndices = current.columns.flatMap((column, index) => column.primaryKey ? [index] : []);
        const key = row => JSON.stringify(keyIndices.map(index => row[index]));
        const known = new Map([...extra].map(([id, row]) => [key(row), { id, row }]));
        const present = new Set([...model.rows.values()].map(key));
        for (const row of result.rows.slice(rowIds.length)) {
          const primaryKey = key(row), previous = known.get(primaryKey);
          if (present.has(primaryKey) || previous && !equalRows(row, previous.row)) {
            throw fail('ROCKETBRAIN_GRID_STALE', 'A staged row no longer matches the observed row at its primary key. Refresh the table before staging this paste.');
          }
          present.add(primaryKey);
          const id = previous?.id || randomUUID();
          extra.set(id, row);
          rowIds.push(id);
        }
        const offset = query.page * query.pageSize;
        range = { firstRow: offset + anchor + 1, lastRow: offset + count, firstPage: query.page + 1, lastPage: lastPage + 1,
          outsidePage: count - query.pageSize };
      }
      const pasted = planPaste(columnModel, parsed, { anchorRowId, anchorColumn, nullToken });
      const changes = mergePasteDraft(draft, pasted);
      if (extra.size > MAX_CHANGES || Buffer.byteLength(JSON.stringify([...extra.values()])) > 4 * 1024 * 1024) {
        throw fail('ROCKETBRAIN_GRID_BULK', 'Captured paste rows exceed the snapshot budget. Apply or discard the current draft before staging another paste.');
      }
      this._compileChanges(model, changes, extra);
      model.pasteRows = extra;
      return { ...changes, range };
    });
  }
  _compileChanges(model, { updates, deletes, inserts }, extra = model.pasteRows) {
    if (![updates, deletes, inserts].every(Array.isArray) || updates.length + deletes.length + inserts.length < 1 || updates.length + deletes.length + inserts.length > MAX_CHANGES) throw fail('ROCKETBRAIN_GRID_CHANGESET', 'Review between 1 and 500 row changes at a time.');
    const columns = new Map(model.definition.columns.map(column => [column.name, column]));
    const pk = model.definition.columns.filter(column => column.primaryKey), index = name => model.definition.columns.findIndex(column => column.name === name);
    const target = quote(this.db._options.database) + '.' + quote(model.definition.name), seen = new Set(), operations = [];
    let changedCells = 0, changedBytes = 0;
    const original = rowId => {
      const row = model.rows.get(rowId) ?? extra?.get(rowId);
      if (typeof rowId !== 'string' || seen.has(rowId) || !row) throw fail('ROCKETBRAIN_GRID_ROW', 'An edited row is missing, duplicated or outside this table snapshot.');
      seen.add(rowId); return row;
    };
    const valuesFor = (values, inserting) => {
      if (!values || typeof values !== 'object' || Array.isArray(values)) throw fail('ROCKETBRAIN_GRID_CHANGESET', 'Each row change needs named column values.');
      return Object.entries(values).map(([name, input]) => {
        const column = columns.get(name);
        if (!column || !(inserting ? column.insertable : column.editable)) throw fail('ROCKETBRAIN_GRID_COLUMN', 'A generated, primary-key or unsupported column is not writable in this operation.');
        const typed = typedCell(input, column);
        changedCells++; changedBytes += typed.parameter == null ? 0 : Buffer.isBuffer(typed.parameter) ? typed.parameter.length : Buffer.byteLength(String(typed.parameter), 'utf8');
        if (changedCells > 2000 || changedBytes > 2 * 1024 * 1024) throw fail('ROCKETBRAIN_GRID_CHANGESET', 'Review at most 2000 edited cells and 2 MiB of values at a time.');
        return { column, ...typed };
      });
    };
    const where = pk.map(column => quote(column.name) + ' <=> ?').join(' AND ');
    for (const update of updates) {
      const row = original(update?.rowId), values = valuesFor(update.values, false);
      if (!values.length) throw fail('ROCKETBRAIN_GRID_CHANGESET', 'An updated row contains no changed columns.');
      operations.push({ type: 'update', row, rowId: update.rowId, values: retainedValues(values),
        sql: 'UPDATE ' + target + ' SET ' + values.map(value => quote(value.column.name) + '=?').join(',') + ' WHERE ' + where,
        parameters: [...values.map(value => value.parameter), ...pk.map(column => snapshotParameter(row[index(column.name)], column))] });
    }
    for (const rowId of deletes) {
      const row = original(rowId);
      operations.push({ type: 'delete', row, rowId, sql: 'DELETE FROM ' + target + ' WHERE ' + where,
        parameters: pk.map(column => snapshotParameter(row[index(column.name)], column)) });
    }
    for (const insert of inserts) {
      const values = valuesFor(insert?.values, true), provided = new Set(values.map(value => value.column.name));
      if (model.definition.columns.some(column => column.required && !provided.has(column.name))) throw fail('ROCKETBRAIN_GRID_VALUE', 'A required insert column has no value.');
      operations.push({ type: 'insert', values: retainedValues(values),
        sql: 'INSERT INTO ' + target + ' (' + values.map(value => quote(value.column.name)).join(',') + ') VALUES (' + values.map(() => '?').join(',') + ')', parameters: values.map(value => value.parameter) });
    }
    return operations;
  }
  reviewChangeSet({ sessionId = 'default', modelId, updates = [], deletes = [], inserts = [] } = {}) {
    const session = this.db._session(sessionId), model = this._editableModel(session, modelId);
    const operations = this._compileChanges(model, { updates, deletes, inserts });
    const reviewId = randomUUID();
    for (const [id, review] of this.reviews) if (review.modelId === modelId) this.reviews.delete(id);
    this.reviews.set(reviewId, { reviewId, model, modelId, sessionId, operations, created: Date.now() });
    return { reviewId, statements: operations.map(operation => ({ sql: operation.sql, parameters: operation.parameters.map(viewParameter) })),
      summary: { updates: updates.length, deletes: deletes.length, inserts: inserts.length }, atomic: true, pendingTransaction: !session.autocommit };
  }
  captureReview({ sessionId, reviewId }) {
    const session = this.db._session(sessionId);
    return this.db._enqueue(session, async () => {
      this._prune();
      const review = this.reviews.get(reviewId);
      if (!review || review.sessionId !== sessionId || review.model.connectionId !== session.connectionId ||
          !session.connected || session.readOnly || session.outcomeUnknown || session.needsReconnect) {
        throw fail('ROCKETBRAIN_GRID_STALE', 'Review the current table edits before saving them.');
      }
      const { model, operations } = review;
      if (operations.some(operation => operation.rowId && !model.rows.has(operation.rowId))) {
        throw fail('ROCKETBRAIN_GRID_BULK', 'A multi-page review stays in this editor. Apply it here or discard the draft.');
      }
      const server = await this.db._sqlRelatedServer(session);
      const definition = await this.definition(model.definition.name);
      if (fingerprint(definition) !== model.fingerprint || this.reviews.get(reviewId) !== review) {
        throw fail('ROCKETBRAIN_GRID_STALE', 'The table or edit review changed before the save.');
      }
      const keys = model.definition.columns.flatMap((column, index) => column.primaryKey ? [index] : []);
      return { schema: this.db._options.database, table: model.definition.name, server, definition: reviewDigest(model.fingerprint),
        operations: operations.map(operation => ({ type: operation.type, ...(operation.values && { values: operation.values }),
          ...(operation.row && { key: reviewDigest(keys.map(index => operation.row[index])), row: reviewDigest(operation.row) }),
          sql: operation.sql, parameters: operation.parameters.map(viewParameter) })) };
    });
  }
  rebindReview({ sessionId, modelId, saved }) {
    const session = this.db._session(sessionId);
    return this.db._enqueue(session, async () => {
      this._prune();
      const model = this.models.get(modelId);
      if (!model?.canEdit || model.sessionId !== sessionId || model.connectionId !== session.connectionId ||
          !session.connected || session.readOnly || session.outcomeUnknown || session.needsReconnect ||
          saved.schema !== this.db._options.database || saved.table !== model.definition.name) {
        throw fail('ROCKETBRAIN_GRID_STALE', 'Open the same table in a clean editable grid before recovering this review.');
      }
      if (saved.server !== await this.db._sqlRelatedServer(session)) {
        throw fail('ROCKETBRAIN_GRID_STALE', 'The saved review belongs to a different physical server, account or SQL context.');
      }
      const definition = await this.definition(model.definition.name);
      if (fingerprint(definition) !== model.fingerprint || saved.definition !== reviewDigest(model.fingerprint) || this.models.get(modelId) !== model) {
        throw fail('ROCKETBRAIN_GRID_SCHEMA_CHANGED', 'The table definition or editable page changed after this review was saved.');
      }
      const keys = model.definition.columns.flatMap((column, index) => column.primaryKey ? [index] : []);
      const byKey = new Map([...model.rows].map(([id, row]) => [reviewDigest(keys.map(index => row[index])), { id, row }]));
      const changes = { updates: [], deletes: [], inserts: [] };
      const selected = new Set();
      const originals = [];
      for (const operation of saved.operations) {
        if (operation.type === 'insert') {
          changes.inserts.push({ values: draftValues(operation.values) });
          continue;
        }
        const current = byKey.get(operation.key);
        if (!current || selected.has(current.id) || operation.row !== reviewDigest(current.row)) {
          throw reviewRowChanged();
        }
        selected.add(current.id);
        originals.push(current.row);
        if (operation.type === 'delete') changes.deletes.push(current.id);
        else changes.updates.push({ rowId: current.id, values: draftValues(operation.values) });
      }
      const validation = this.reviewChangeSet({ sessionId, modelId, ...changes });
      this.reviews.delete(validation.reviewId);
      const savedStatements = saved.operations.map(({ sql, parameters }) => ({ sql, parameters }));
      if (reviewDigest(validation.statements) !== reviewDigest(savedStatements)) {
        throw fail('ROCKETBRAIN_GRID_STALE', 'The current statements or parameters differ from the saved edit review.');
      }
      if (originals.length) {
        const { sourceServer } = require('./sql-related-source');
        const columns = definition.columns;
        const target = quote(saved.schema) + '.' + quote(definition.name);
        const match = '(' + keys.map(index => quote(columns[index].name) + ' <=> ?').join(' AND ') + ')';
        const prefix = 'SELECT ' + columns.map(column => quote(column.name)).join(',') + ' FROM ' + target + ' WHERE ';
        await this.db._relationshipCatalog(async read => {
          if (await sourceServer(read) !== saved.server) {
            throw fail('ROCKETBRAIN_GRID_STALE', 'The current metadata session has a different server, account or SQL context.');
          }
          for (let offset = 0; offset < originals.length; offset += 32) {
            const batch = originals.slice(offset, offset + 32);
            const parameters = batch.flatMap(row => keys.map(index => snapshotParameter(row[index], columns[index])));
            const { rows } = await read(prefix + batch.map(() => match).join(' OR '), parameters);
            const digests = new Set(rows.map(reviewDigest));
            if (rows.length !== batch.length || batch.some(row => !digests.has(reviewDigest(row)))) throw reviewRowChanged();
          }
        });
      }
      return changes;
    });
  }
  applyChangeSet({ sessionId = 'default', reviewId } = {}) {
    const session = this.db._session(sessionId);
    return this.db._enqueue(session, async () => {
      this._prune();
      const review = this.reviews.get(reviewId); this.reviews.delete(reviewId);
      if (!review || review.sessionId !== sessionId || !this.models.has(review.modelId) || review.model.connectionId !== session.connectionId) throw fail('ROCKETBRAIN_GRID_STALE', 'This reviewed change set expired, was already used or belongs to another session.');
      if (session.readOnly) throw fail('ROCKETBRAIN_READ_ONLY', 'Enable read/write mode explicitly before applying table changes.');
      const model = review.model;
      const restriction = tableProtection(this.db._writeProtection, this.db._options.database, model.definition.name);
      if (restriction) throw protectionError(restriction);
      let definition = await this.definition(model.definition.name);
      if (fingerprint(definition) !== model.fingerprint) { this.invalidate(sessionId); throw fail('ROCKETBRAIN_GRID_SCHEMA_CHANGED', 'The table schema or trigger visibility changed. Refresh and review the edits again.'); }
      const previousTransaction = session.inTransaction, autoCommit = session.autocommit, savepoint = 'rb_grid_' + randomUUID().replaceAll('-', '');
      let started = false;
      try {
        if (!session.inTransaction) { this.db._observe(session, await this.db._control(session, 'START TRANSACTION READ WRITE')); started = true; }
        await this.db._control(session, 'SAVEPOINT ' + savepoint);
        // Hold this table's metadata lock, then recheck the catalog to close
        // the DDL race between the first catalog read and the row locks.
        await this._read(session, 'SELECT ' + definition.columns.map(column => quote(column.name)).join(',') + ' FROM ' + quote(this.db._options.database) + '.' + quote(definition.name) + ' LIMIT 0 FOR UPDATE', [], 1);
        definition = await this.definition(model.definition.name);
        if (fingerprint(definition) !== model.fingerprint) throw fail('ROCKETBRAIN_GRID_SCHEMA_CHANGED', 'The table schema changed before the apply acquired its metadata lock. Refresh and review again.');
        const pk = definition.columns.filter(column => column.primaryKey), indices = pk.map(column => definition.columns.findIndex(item => item.name === column.name));
        const target = quote(this.db._options.database) + '.' + quote(definition.name);
        const select = 'SELECT ' + definition.columns.map(column => quote(column.name)).join(',') + ' FROM ' + target + ' WHERE ' + pk.map(column => quote(column.name) + ' <=> ?').join(' AND ') + ' FOR UPDATE';
        // Lock and compare current reads, never a repeatable-read historical row.
        for (const operation of review.operations.filter(operation => operation.row).sort((a, b) => a.rowId.localeCompare(b.rowId))) {
          const current = await this._read(session, select, pk.map((column, i) => snapshotParameter(operation.row[indices[i]], column)), 2);
          if (current.rows.length !== 1 || !equalRows(current.rows[0], operation.row)) throw fail('ROCKETBRAIN_GRID_CONFLICT', 'A row changed or was deleted on the server. No changes from this apply were retained. Refresh the table before editing again.');
        }
        for (const operation of review.operations) {
          const result = await this._read(session, operation.sql, operation.parameters);
          if (result.warningCount) throw fail('ROCKETBRAIN_GRID_WARNING', 'The server reported a conversion warning. This apply was rolled back to avoid silent value changes.');
          if (result.affectedRows > 1 || operation.type !== 'update' && result.affectedRows !== 1) throw fail('ROCKETBRAIN_GRID_ROW', 'The server affected an unexpected number of rows. This apply was rolled back.');
        }
        this.invalidate(sessionId);
        const result = await this._preview(session, definition.name, model.browseQuery || { maxRows: model.maxRows }, definition);
        await this.db._control(session, 'RELEASE SAVEPOINT ' + savepoint);
        let committed = false;
        if (started && autoCommit) { this.db._observe(session, await this.db._control(session, 'COMMIT')); committed = true; }
        else await this.db._refreshState(session);
        result.state = this.db._state(session);
        return { applied: review.operations.length, committed, pendingTransaction: !committed && session.inTransaction, result, state: this.db._state(session) };
      } catch (error) {
        this.invalidate(sessionId);
        if (session.connected) {
          try {
            await this.db._refreshState(session);
            if (session.inTransaction) {
              await this.db._control(session, started ? 'ROLLBACK' : 'ROLLBACK TO SAVEPOINT ' + savepoint);
              if (!started) await this.db._control(session, 'RELEASE SAVEPOINT ' + savepoint);
              await this.db._refreshState(session);
            } else if (previousTransaction) error.priorTransactionRolledBack = true;
          } catch {
            this.db._lose(session, fail('ROCKETBRAIN_GRID_ROLLBACK_UNKNOWN', 'The apply failed and rollback could not be confirmed. Inspect the server before retrying.'), true);
          }
        }
        error.state = this.db._state(session); error.modelInvalidated = true; throw error;
      }
    });
  }
}
module.exports = { TableEditor, typedCell, columnKind, columnDefinition, equalRows, normalizedCreate, browseQuery, keysetValue };
