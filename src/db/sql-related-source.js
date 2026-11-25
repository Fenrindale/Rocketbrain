'use strict';

const { createHash } = require('node:crypto');
const { tokenize } = require('./sql-policy');
const { identifier, stableCreate } = require('./schema-rename');
const { columnKind, keysetValue } = require('./grid');

const maxColumns = 128;
const maxKeyParts = 16;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const quote = name => '`' + identifier(name).replaceAll('`', '``') + '`';
const word = (token, text) => token?.kind === 'word' && token.upper === text;
const symbol = (token, text) => token?.kind === 'symbol' && token.value === text;
const name = token => ['word', 'identifier'].includes(token?.kind) ? identifier(token.value) : null;
const sameName = (left, right) => left.toLowerCase() === right.toLowerCase();
const tailWords = new Set(['WHERE', 'ORDER', 'LIMIT']);
const disallowed = new Set(['DISTINCT', 'DISTINCTROW', 'JOIN', 'UNION', 'INTERSECT', 'EXCEPT', 'GROUP', 'HAVING', 'WINDOW',
  'PROCEDURE', 'INTO', 'FOR', 'LOCK', 'USE', 'PARTITION', 'OFFSET', 'SQL_CALC_FOUND_ROWS']);

async function sourceServer(query) {
  const { rows } = await query('SELECT VERSION(),CURRENT_USER(),CURRENT_ROLE(),DATABASE(),@@SESSION.sql_mode,@@SESSION.time_zone');
  if (rows.length !== 1 || rows[0].length !== 6 || rows[0].some((value, index) => index !== 2 && typeof value !== 'string')) {
    throw Error('The source database identity could not be confirmed.');
  }
  const uid = (await query(/MariaDB/i.test(rows[0][0]) ? 'SELECT @@server_uid' : 'SELECT @@server_uuid')).rows;
  if (uid.length !== 1 || typeof uid[0][0] !== 'string' || !uid[0][0]) throw Error('The physical source server could not be confirmed.');
  return hash([rows[0], uid[0][0]]);
}

function parseProjection(sql, database, sqlMode = []) {
  try {
    if (typeof sql !== 'string' || !database || sql.includes('"')) return null;
    const tokens = tokenize(sql, false, { sqlMode, allowOptimizerHints: false });
    if (!word(tokens[0], 'SELECT')) return null;
    const from = tokens.findIndex(token => word(token, 'FROM'));
    if (from < 2 || tokens.slice(1).some(token => token.kind === 'word' &&
        (disallowed.has(token.upper) || token.upper === 'SELECT' || token.upper === 'WITH')) ||
        tokens.slice(from + 1).some(token => word(token, 'FROM'))) return null;
    let at = from + 1, schema = database, table = name(tokens[at++]);
    if (symbol(tokens[at], '.')) { schema = table; at++; table = name(tokens[at++]); }
    if (!schema || !table) return null;
    identifier(schema, { table: true });
    identifier(table, { table: true });
    let alias = table;
    if (word(tokens[at], 'AS')) { at++; alias = name(tokens[at++]); }
    else if (tokens[at] && !(tokens[at].kind === 'word' && tailWords.has(tokens[at].upper))) alias = name(tokens[at++]);
    if (!alias || tokens[at] && !(tokens[at].kind === 'word' && tailWords.has(tokens[at].upper))) return null;
    const projection = [];
    let index = 1;
    while (index < from) {
      let first = tokens[index++], column;
      if (symbol(tokens[index], '.')) {
        if (name(first) !== alias) return null;
        index++;
        first = tokens[index++];
      }
      if (symbol(first, '*')) {
        if (projection.length || index !== from) return null;
        return { schema, table, alias, projection: null };
      }
      column = name(first);
      if (!column) return null;
      let label = column;
      if (word(tokens[index], 'AS')) { index++; label = name(tokens[index++]); }
      if (!label || projection.length >= maxColumns) return null;
      projection.push({ column, label });
      if (index < from && !symbol(tokens[index++], ',')) return null;
    }
    return index === from ? { schema, table, alias, projection } : null;
  } catch { return null; }
}

async function describeSource(query, target) {
  const { schema, table } = target, fields = [schema, table];
  const physical = (await query('SELECT TABLE_SCHEMA,TABLE_NAME,TABLE_TYPE,ENGINE FROM information_schema.TABLES ' +
    'WHERE BINARY TABLE_SCHEMA=BINARY ? AND BINARY TABLE_NAME=BINARY ? LIMIT 2', fields)).rows;
  if (physical.length !== 1 || physical[0][0] !== schema || physical[0][1] !== table ||
      physical[0][2] !== 'BASE TABLE' || String(physical[0][3]).toUpperCase() !== 'INNODB') return null;
  const shown = (await query('SHOW CREATE TABLE ' + quote(schema) + '.' + quote(table))).rows;
  if (shown.length !== 1 || shown[0][0] !== table || typeof shown[0][1] !== 'string' ||
      !/^CREATE TABLE\b/ui.test(shown[0][1])) return null;
  const columns = (await query('SELECT COLUMN_NAME,COLUMN_TYPE,CHARACTER_SET_NAME,COLLATION_NAME FROM information_schema.COLUMNS ' +
    'WHERE BINARY TABLE_SCHEMA=BINARY ? AND BINARY TABLE_NAME=BINARY ? ORDER BY ORDINAL_POSITION LIMIT ' + (maxColumns + 1), fields)).rows;
  const primary = (await query('SELECT COLUMN_NAME,ORDINAL_POSITION FROM information_schema.KEY_COLUMN_USAGE ' +
    "WHERE BINARY TABLE_SCHEMA=BINARY ? AND BINARY TABLE_NAME=BINARY ? AND BINARY CONSTRAINT_NAME='PRIMARY' " +
    'ORDER BY ORDINAL_POSITION LIMIT ' + (maxKeyParts + 1), fields)).rows;
  if (!columns.length || columns.length > maxColumns || !primary.length || primary.length > maxKeyParts ||
      primary.some(([column, ordinal], index) => Number(ordinal) !== index + 1 || !columns.some(([observed]) => observed === column))) return null;
  return { columns: columns.map(([name, type, charset, collation]) => ({ name, type, charset, collation })),
    primary: primary.map(([column]) => column), fingerprint: hash([stableCreate(shown[0][1], { omitCounter: true }), columns, primary]) };
}

function proveProjection(result, shape, metadata) {
  if (!metadata || !Array.isArray(result.fields) || !result.fields.length || result.fields.length > maxColumns ||
      shape.projection && shape.projection.length !== result.fields.length || result.fields.length !== result.columns?.length) return null;
  const physicalByName = new Map(metadata.columns.map(column => [column.name, column]));
  const definitions = [];
  for (const [index, field] of result.fields.entries()) {
    if (field.schema !== shape.schema || field.originalTable !== shape.table || field.table !== shape.alias ||
        result.columns[index] !== field.name) return null;
    const column = physicalByName.get(field.originalName), requested = shape.projection?.[index];
    if (!column || requested && (!sameName(column.name, requested.column) ||
        !sameName(requested.label, field.name))) return null;
    definitions.push(column);
  }
  const columns = definitions.map(column => column.name), projected = new Set(columns);
  if (projected.size !== columns.length || !metadata.primary.every(column => projected.has(column))) return null;
  // Duplicate display aliases remain safe because the original column and the captured index identify each value.
  return { schema: shape.schema, table: shape.table, columns, definitions, primary: metadata.primary,
    fingerprint: metadata.fingerprint };
}

const keyKinds = new Set(['integer', 'decimal', 'text', 'binary', 'datetime']);
function keyParameters(source, row) {
  return source.primary.map(name => {
    const at = source.columns.indexOf(name), value = row[at], column = source.definitions[at];
    const kind = columnKind(column.type);
    if (value == null || !keyKinds.has(kind) || kind === 'binary' && !/^(?:VAR)?BINARY\(/iu.test(column.type) ||
        typeof value !== 'string' && !(typeof value === 'number' && Number.isSafeInteger(value)) ||
        Buffer.byteLength(String(value)) > 4096) throw Error('The captured primary key has an unsupported or oversized value.');
    return keysetValue({ ...column, kind }, value);
  });
}

async function recheckSource(query, _database, { source, row }) {
  if (await sourceServer(query) !== source.server) throw Error('The physical SQL result source changed. Run the query again.');
  const before = await describeSource(query, source);
  if (!before || before.fingerprint !== source.fingerprint) throw Error('The SQL result source table changed. Run the query again.');
  const binds = keyParameters(source, row);
  const rows = (await query('SELECT ' + source.columns.map(quote).join(',') + ' FROM ' + quote(source.schema) + '.' + quote(source.table) +
    ' WHERE ' + source.primary.map((column, index) => quote(column) + ' = ' + binds[index].sql).join(' AND ') +
    ' LIMIT 2', binds.map(binding => binding.parameter))).rows;
  if (rows.length !== 1 || rows[0].length !== row.length || rows[0].some((value, index) => !Object.is(value, row[index]))) {
    throw Error('The captured source row changed or was deleted. Run the query again.');
  }
  const after = await describeSource(query, source);
  if (!after || after.fingerprint !== source.fingerprint) throw Error('The SQL result source table changed. Run the query again.');
}

module.exports = { sourceServer, parseProjection, describeSource, proveProjection, keyParameters, recheckSource };
