'use strict';
const { randomUUID } = require('node:crypto');
const { compileGridSort, observeSortCollations, sortOptions } = require('./grid-sort');
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
const MAX_PAGE = 2000;
function keysetValue(column, value) {
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
function keysetAfter(order, columns, anchor) {
  if (anchor.length !== order.length) throw fail('ROCKETBRAIN_GRID_QUERY', 'The keyset position no longer matches the sort.');
  const alternatives = [], parameters = [], prefix = [], previous = [];
  for (const [index, { column, direction }] of order.entries()) {
    const name = quote(column), value = anchor[index];
    if (value === null) {
      if (direction === 'asc') {
        alternatives.push('(' + [...prefix, name + ' IS NOT NULL'].join(' AND ') + ')');
        parameters.push(...previous);
      }
      prefix.push(name + ' IS NULL');
      continue;
    }
    const bound = keysetValue(columns.get(column), value);
    const condition = direction === 'asc' ? name + ' > ' + bound.sql
      : '(' + name + ' < ' + bound.sql + ' OR ' + name + ' IS NULL)';
    alternatives.push('(' + [...prefix, condition].join(' AND ') + ')');
    parameters.push(...previous, bound.parameter);
    prefix.push(name + ' <=> ' + bound.sql);
    previous.push(bound.parameter);
  }
  return { sql: alternatives.length ? '(' + alternatives.join(' OR ') + ')' : '0 = 1', parameters };
}
/** Compile only catalog-backed identifiers and explicitly typed bound values. */
function browseQuery(definition, input = {}, schema, related = false, collations = {}, cursor, reverse = false) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('ROCKETBRAIN_GRID_QUERY', 'Choose table paging, sorting and filter options.');
  if (Object.keys(input).some(key => !['page', 'pageSize', 'maxRows', 'sort', 'filters', 'sessionId'].includes(key))) throw fail('ROCKETBRAIN_GRID_QUERY', 'Unsupported table browsing option.');
  const page = input.page ?? 0, pageSize = input.pageSize ?? input.maxRows ?? 200;
  if (!Number.isInteger(page) || page < 0 || page > MAX_PAGE) throw fail('ROCKETBRAIN_GRID_QUERY', 'Page index must be between 0 and 2000.');
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500) throw fail('ROCKETBRAIN_GRID_QUERY', 'Page size must be between 1 and 500.');
  const columns = new Map(definition.columns.map(column => [column.name, column]));
  const pk = definition.columns.filter(column => column.primaryKey), parameters = [], where = [], filters = [];
  if (page && !pk.length) throw fail('ROCKETBRAIN_GRID_QUERY', 'A primary key is required for stable page navigation.');
  if (!Array.isArray(input.sort || []) || (input.sort || []).length > 8 || !Array.isArray(input.filters || []) || (input.filters || []).length > 20) throw fail('ROCKETBRAIN_GRID_QUERY', 'Use at most 8 sort columns and 20 filters.');
  const { sort, order, fragments } = compileGridSort(definition.columns, input.sort || [], collations);
  if (cursor && (!pk.length || order.some(({ column, nulls, expression, collation }) => {
    const { type, kind } = columns.get(column);
    return nulls !== undefined || expression !== undefined || collation !== undefined ||
      ['json', 'unsupported'].includes(kind) || /^(?:enum|set)\b/i.test(type);
  }))) throw fail('ROCKETBRAIN_GRID_QUERY', 'Choose a primary-key table and default-ordered scalar columns for keyset browsing.');
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
  const scanOrder = reverse ? order.map(({ column, direction }) => ({ column, direction: direction === 'asc' ? 'desc' : 'asc' })) : order;
  if (cursor?.length) {
    const seek = keysetAfter(scanOrder, columns, cursor);
    where.push(seek.sql);
    parameters.push(...seek.parameters);
  }
  const orderBy = reverse ? scanOrder.map(item => quote(item.column) + ' ' + item.direction.toUpperCase()) : fragments;
  const sql = 'SELECT ' + definition.columns.map(column => quote(column.name)).join(',') + ' FROM ' + quote(schema) + '.' + quote(definition.name)
    + (where.length ? ' WHERE ' + where.join(' AND ') : '') + (orderBy.length ? ' ORDER BY ' + orderBy.join(',') : '')
    + ' LIMIT ' + (pageSize + 1) + (cursor ? '' : ' OFFSET ' + (page * pageSize));
  return { sql, parameters, page, pageSize, order, query: { page, pageSize, sort, filters }, pageable: pk.length > 0,
    consistency: pk.length ? 'Offset pages use explicit ordering plus primary-key tiebreakers. Concurrent inserts, deletes or sort-value changes may move rows between pages; no cross-page snapshot is implied.' : 'No primary key is visible. Only the first page is available; tied rows have no stable cross-page order.' };
}

class TableEditor {
  constructor(database) {
    this.db = database; this.models = new Map(); this.reviews = new Map(); this.keysetBrowsers = new Map();
  }
  async openKeysetBrowser(name, options = {}) {
    if (this.keysetBrowsers.size >= 8) throw fail('ROCKETBRAIN_GRID_QUERY', 'Close an existing table snapshot before opening another.');
    const id = randomUUID(), sessionId = 'keyset:' + id, schema = this.db._options.database;
    const browser = { sessionId, schema, name, page: 0 };
    this.keysetBrowsers.set(id, browser);
    try {
      const definition = await this.definition(name, schema);
      if (definition.kind !== 'BASE TABLE' || String(definition.engine).toUpperCase() !== 'INNODB') {
        throw fail('ROCKETBRAIN_GRID_QUERY', 'Choose an InnoDB table for a consistent snapshot.');
      }
      browseQuery(definition, { ...options, page: 0 }, schema, false, {}, []);
      await this.db.openSession(sessionId, { readOnly: true });
      await this.db.setTransactionIsolation('REPEATABLE READ', { sessionId });
      const transaction = await this.db._transaction('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY',
        { sessionId }, { requireIdle: true });
      browser.definition = definition;
      browser.connectionId = transaction.connectionId;
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
  async readKeysetPage(id, options = {}) {
    const browser = this.keysetBrowsers.get(id);
    if (!browser?.definition) throw fail('ROCKETBRAIN_GRID_QUERY', 'Open a current table snapshot.');
    const { definition, sessionId, schema } = browser;
    const session = this.db._session(sessionId);
    return this.db._enqueue(session, async () => {
      if (!session.readOnly || !session.inTransaction || session.connectionId !== browser.connectionId ||
          this.keysetBrowsers.get(id) !== browser) throw fail('ROCKETBRAIN_GRID_STALE', 'The table snapshot ended. Open it again.');
      const page = options.page ?? 0;
      if (!Number.isSafeInteger(page) || page < 0 || (page !== 0 && Math.abs(page - browser.page) > 1)) {
        throw fail('ROCKETBRAIN_GRID_QUERY', 'Move through the snapshot one page at a time.');
      }
      const first = browseQuery(definition, { ...options, page: 0 }, schema, false, {}, []);
      const signature = JSON.stringify(first.query);
      let cursor=[], reverse=false;
      if (page > 0) {
        if (signature !== browser.signature) {
          throw fail('ROCKETBRAIN_GRID_QUERY', 'Open the first page after changing size, sorting or filters.');
        }
        if (page === browser.page) ({ cursor, reverse } = browser.position);
        else if (page < browser.page) { cursor = browser.first; reverse = true; }
        else if (browser.hasNext) cursor = browser.last;
        else throw fail('ROCKETBRAIN_GRID_QUERY', 'The current snapshot has no next page.');
      }
      const plan = cursor.length ? browseQuery(definition, first.query, schema, false, {}, cursor, reverse) : first;
      const result = await this._read(session, plan.sql, plan.parameters, plan.pageSize + 1);
      if (result.truncated || !session.inTransaction || !session.connected || this.keysetBrowsers.get(id) !== browser) {
        throw fail('ROCKETBRAIN_GRID_STALE', 'The table snapshot ended or the page exceeded the byte limit. Open a fresh snapshot.');
      }
      if (result.columns.length !== definition.columns.length ||
          result.columns.some((column,index) => column !== definition.columns[index].name)) {
        throw fail('ROCKETBRAIN_GRID_SCHEMA_CHANGED', 'The table column projection changed during keyset browsing.');
      }
      const extra = result.rows.length > plan.pageSize;
      result.rows = result.rows.slice(0, plan.pageSize);
      if (reverse) result.rows.reverse();
      result.rowCount = result.rows.length;
      const key = row => row ? plan.order.map(item => row[result.columns.indexOf(item.column)]) : [];
      const hasNext = reverse || extra, hasPrevious = reverse ? extra : page > 0;
      browser.first = key(result.rows[0]); browser.last = key(result.rows.at(-1));
      browser.position = { cursor,reverse }; browser.hasNext = hasNext; browser.signature = signature; browser.page = page;
      const query = { ...plan.query, page };
      const reason = 'This read-only page belongs to an InnoDB consistent snapshot.';
      result.state = this.db._state(session);
      result.browse = { ...query, order: plan.order, hasNext, hasPrevious,
        pageable: true, sql: plan.sql, consistency: reason, totalRows: null, keyset: true };
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
  async definition(name, schema = this.db._options.database) {
    if (typeof name !== 'string' || !name || name.includes('\0') || name.length > 64) throw fail('ROCKETBRAIN_GRID_TABLE', 'Select a table from the current database metadata.');
    const read = async (sql, values) => (await this.db._metadataQuery(sql, values)).rows;
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
      rows: new Map(rowIds.map((id, index) => [id, [...result.rows[index]]])), maxRows, browseQuery: browsing.query, created: Date.now(), canEdit: !reason };
    this.models.set(modelId, model);
    this._prune();
    result.state = this.db._state(session);
    result.edit = { modelId, table: name, ...(related ? { schema } : {}), columns: definition.columns, rowIds, canEdit: !reason, reason,
      query: browsing.query, hasMorePossible: hasNext === true, insertable: !reason && !definition.columns.some(column => column.required && !column.insertable),
      concurrency: 'Primary-key locking read plus exact original visible-row comparison; a server-side delete/reinsert ABA without a version column cannot be detected.' };
    result.browse = { ...browsing.query, order: browsing.order, sortOptions: sortOptions(definition.columns, collations), hasNext, hasPrevious: browsing.page > 0, pageable: browsing.pageable, sql: browsing.sql, consistency: browsing.consistency, totalRows: null };
    return result;
  }
  reviewChangeSet({ sessionId = 'default', modelId, updates = [], deletes = [], inserts = [] } = {}) {
    this._prune();
    const session = this.db._session(sessionId), model = this.models.get(modelId);
    if (!model || model.sessionId !== sessionId || model.connectionId !== session.connectionId) throw fail('ROCKETBRAIN_GRID_STALE', 'This table snapshot expired or its session changed. Refresh the table.');
    const restriction = tableProtection(this.db._writeProtection, this.db._options.database, model.definition.name);
    if (restriction) throw protectionError(restriction);
    if (!model.canEdit) throw fail('ROCKETBRAIN_GRID_READ_ONLY', 'This table is structurally read-only.');
    if (session.readOnly) throw fail('ROCKETBRAIN_READ_ONLY', 'Enable read/write mode explicitly before reviewing table changes.');
    if (![updates, deletes, inserts].every(Array.isArray) || updates.length + deletes.length + inserts.length < 1 || updates.length + deletes.length + inserts.length > MAX_CHANGES) throw fail('ROCKETBRAIN_GRID_CHANGESET', 'Review between 1 and 500 row changes at a time.');
    const columns = new Map(model.definition.columns.map(column => [column.name, column]));
    const pk = model.definition.columns.filter(column => column.primaryKey), index = name => model.definition.columns.findIndex(column => column.name === name);
    const target = quote(this.db._options.database) + '.' + quote(model.definition.name), seen = new Set(), operations = [];
    let changedCells = 0, changedBytes = 0;
    const original = rowId => {
      if (typeof rowId !== 'string' || seen.has(rowId) || !model.rows.has(rowId)) throw fail('ROCKETBRAIN_GRID_ROW', 'An edited row is missing, duplicated or outside this table snapshot.');
      seen.add(rowId); return model.rows.get(rowId);
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
      operations.push({ type: 'update', row, rowId: update.rowId,
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
      operations.push({ type: 'insert', sql: 'INSERT INTO ' + target + ' (' + values.map(value => quote(value.column.name)).join(',') + ') VALUES (' + values.map(() => '?').join(',') + ')', parameters: values.map(value => value.parameter) });
    }
    const reviewId = randomUUID();
    for (const [id, review] of this.reviews) if (review.modelId === modelId) this.reviews.delete(id);
    this.reviews.set(reviewId, { reviewId, model, modelId, sessionId, operations, created: Date.now() });
    return { reviewId, statements: operations.map(operation => ({ sql: operation.sql, parameters: operation.parameters.map(value => Buffer.isBuffer(value) ? '0x' + value.toString('hex') : value) })),
      summary: { updates: updates.length, deletes: deletes.length, inserts: inserts.length }, atomic: true, pendingTransaction: !session.autocommit };
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
module.exports = { TableEditor, typedCell, columnKind, columnDefinition, equalRows, normalizedCreate, browseQuery };
