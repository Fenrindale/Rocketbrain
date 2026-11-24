'use strict';

const { toCsv } = require('../sql');
const { workbook } = require('./result-xlsx');

const formats = new Map([
  ['csv', { extension: 'csv', label: 'CSV' }],
  ['json', { extension: 'json', label: 'JSON' }],
  ['xlsx', { extension: 'xlsx', label: 'Excel workbook' }],
  ['insert', { extension: 'sql', label: 'SQL INSERT statements' }]
]);
const binaryCharSet = 63;
const integerTypes = new Set([1, 2, 3, 8, 9, 13]);
const temporalTypes = new Set([7, 10, 11, 12, 14, 17, 18, 19]);
const stringTypes = new Set([15, 247, 248, 249, 250, 251, 252, 253, 254]);
const decimalSyntax = /^[+-]?\d+(?:\.\d+)?$/;
const integerSyntax = /^[+-]?\d+$/;
const formattedLimit = 20 * 1024 * 1024;

function columnKind(field) {
  const type = field?.type;
  if (integerTypes.has(type)) return 'integer';
  if (temporalTypes.has(type)) return 'temporal';
  if (type === 0 || type === 246) return 'decimal';
  if (type === 4 || type === 5) return 'float';
  if (type === 6) return 'null';
  if (type === 16) return 'bit';
  if (type === 245) return 'json-text';
  if (type === 255) return 'geometry-preview';
  if (stringTypes.has(type)) return field.characterSet === binaryCharSet ? 'binary-hex' : 'text';
  return 'unknown';
}

function numberText(value) {
  return Object.is(value, -0) ? '-0' : String(value);
}

function validateResult(result) {
  if (!result || !Array.isArray(result.columns) || !result.columns.length || !Array.isArray(result.rows) ||
      result.columns.some(name => typeof name !== 'string')) throw Error('Select a completed result with columns to export.');
  for (const row of result.rows) {
    if (!Array.isArray(row) || row.length !== result.columns.length ||
        row.some(value => value !== null && typeof value !== 'string' && typeof value !== 'boolean' && !Number.isFinite(value))) {
      throw Error('The result contains a value without an exact export representation.');
    }
  }
}

function joinRows(prefix, rows, format, delimiter, suffix) {
  const chunks = [prefix];
  let length = Buffer.byteLength(prefix + suffix);
  for (const [index, row] of rows.entries()) {
    const line = (index ? delimiter : '') + format(row);
    length += Buffer.byteLength(line);
    if (length > formattedLimit) throw Error('This result exceeds the 20 MiB export limit. Export a smaller page.');
    chunks.push(line);
  }
  return chunks.join('') + suffix;
}

function jsonExport(result) {
  const columns = result.columns.map((name, index) => {
    const field = result.fields?.[index];
    return field ? { name, kind: columnKind(field), protocolType: field.type, originalName: field.originalName,
      originalTable: field.originalTable, schema: field.schema } : { name, kind: 'unknown' };
  });
  const metadata = { columns, rowCount: result.rows.length, truncated: result.truncated === true,
    ...(result.browse ? { page: result.browse.page + 1, pageSize: result.browse.pageSize, hasNext: result.browse.hasNext } : {}) };
  const heading = JSON.stringify(metadata, null, 2).replace(/\n}$/, ',\n  "rows": [\n');
  const row = values => '    [' + values.map(value => typeof value === 'number' ? numberText(value) : JSON.stringify(value)).join(', ') + ']';
  return joinRows(heading, result.rows, row, ',\n', '\n  ]\n}\n');
}

function identifier(value) {
  if (typeof value !== 'string' || !value || value.length > 64 || /[\x00-\x1f\x7f\ud800-\udfff]/.test(value) || value.endsWith(' ')) {
    throw Error('Use a non-empty MySQL/MariaDB identifier of at most 64 BMP characters without control characters or trailing spaces.');
  }
  return '`' + value.replaceAll('`', '``') + '`';
}

function sqlName(value) {
  if (typeof value === 'string' && /[.\\/]/.test(value)) throw Error('Enter schema and table names separately, without path separators.');
  return identifier(value);
}

function losslessUtf8Hex(value) {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.toString('utf8') !== value) throw Error('A result value cannot be represented as valid UTF-8.');
  return bytes.toString('hex');
}

function sqlValue(value, kind) {
  if (value === null) return 'NULL';
  if (kind === 'integer' && (Number.isSafeInteger(value) || typeof value === 'string' && integerSyntax.test(value))) return numberText(value);
  if (kind === 'decimal' && typeof value === 'string' && decimalSyntax.test(value)) return value;
  if (kind === 'float' && typeof value === 'number') {
    const literal = numberText(value);
    return literal.includes('e') ? literal : literal + 'e0';
  }
  if ((kind === 'bit' || kind === 'binary-hex') && typeof value === 'string' && /^0x(?:[0-9a-f]{2})*$/i.test(value)) {
    const hex = value.slice(2);
    if (kind === 'binary-hex') return "X'" + hex + "'";
    const digits = [...hex].map(digit => Number.parseInt(digit, 16).toString(2).padStart(4, '0')).join('').replace(/^0+(?=\d)/, '');
    if (digits.length && digits.length <= 64) return "b'" + digits + "'";
  }
  if (['text', 'json-text', 'temporal'].includes(kind) && typeof value === 'string') {
    return "CONVERT(X'" + losslessUtf8Hex(value) + "' USING utf8mb4)";
  }
  throw Error('A result column lacks a supported lossless INSERT literal. Use JSON to preserve the displayed value.');
}

function insertExport(result, target) {
  if (!Array.isArray(result.fields) || result.fields.length !== result.columns.length) {
    throw Error('INSERT export requires MySQL or MariaDB result column metadata.');
  }
  const table = (target?.schema ? sqlName(target.schema) + '.' : '') + sqlName(target?.table);
  const columns = target?.columns ?? result.columns;
  if (!Array.isArray(columns) || columns.length !== result.columns.length ||
      new Set(columns.filter(name => typeof name === 'string').map(name => name.toLowerCase())).size !== columns.length) {
    throw Error('Enter one unique destination column per result column, in the original order.');
  }
  const kinds = result.fields.map(columnKind);
  const insert = 'INSERT INTO ' + table + ' (' + columns.map(identifier).join(', ') + ') VALUES (';
  const page = result.browse ? ' (table page ' + (result.browse.page + 1) + ')' : '';
  const note = '-- ' + result.rows.length + ' captured result rows' + page + '. Review against the destination schema before running.\n';
  const partial = result.truncated || (result.browse && (result.browse.hasPrevious || result.browse.hasNext !== false));
  const limit = partial ? '-- The preview may omit rows.\n' : '';
  return joinRows(note + limit, result.rows, row => insert + row.map((value, index) => sqlValue(value, kinds[index])).join(', ') + ');', '\n', '\n');
}

function createResultExport(result, format = 'csv', target) {
  const file = formats.get(format);
  if (!file) throw Error('Select a supported export format.');
  validateResult(result);
  const data = format === 'xlsx' ? workbook(result.columns, result.rows) : Buffer.from(
    format === 'csv' ? toCsv(result) : format === 'json' ? jsonExport(result) : insertExport(result, target), 'utf8');
  return { ...file, data };
}

module.exports = { createResultExport };
