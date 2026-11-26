'use strict';

const valueLimit = 64 * 1024;
const kinds = new Set(['NULL', 'INTEGER', 'REAL', 'TEXT', 'BLOB']);
const minimum = -9223372036854775808n, maximum = 9223372036854775807n;
const typeError = message => Object.assign(Error(message), { code: 'VALUE' });

function integer(value) {
  if (typeof value !== 'string' || !/^-?(?:0|[1-9][0-9]{0,18})$/u.test(value)) throw typeError('Enter a signed 64-bit integer in decimal.');
  const exact = BigInt(value);
  if (exact < minimum || exact > maximum) throw typeError('The SQLite integer is outside the signed 64-bit range.');
  return exact.toString();
}

function normalizeCell(input) {
  if (!input || !kinds.has(input.kind) || Object.keys(input).some(key => !['kind', 'value'].includes(key))) throw typeError('Choose one exact SQLite storage type.');
  const { kind, value } = input;
  if (kind === 'NULL') {
    if (value !== null) throw typeError('Use a typed SQLite NULL.');
    return { kind, value: null };
  }
  if (typeof value !== 'string') throw typeError('Enter the exact SQLite value as text for review.');
  if (kind === 'INTEGER') return { kind, value: integer(value) };
  if (kind === 'REAL') {
    if (value.length > 32 || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu.test(value) || !Number.isFinite(Number(value))) {
      throw typeError('Enter a finite SQLite real number.');
    }
    const number = Number(value);
    return { kind, value: Object.is(number, -0) ? '-0' : String(number) };
  }
  if (kind === 'TEXT') {
    if (!value.isWellFormed() || Buffer.byteLength(value, 'utf8') > valueLimit) throw typeError('Enter valid Unicode text of at most 64 KiB.');
    return { kind, value };
  }
  const hex = value.replace(/^0x/iu, '');
  if (hex.length > 2 * valueLimit || !/^(?:[0-9a-f]{2})*$/iu.test(hex)) throw typeError('Enter whole hexadecimal byte pairs, up to 64 KiB of SQLite BLOB data.');
  return { kind, value: hex.toLowerCase() };
}

function binding(cell) {
  if (cell.kind === 'INTEGER') return BigInt(cell.value);
  if (cell.kind === 'REAL') return Number(cell.value);
  if (cell.kind === 'BLOB') return Buffer.from(cell.value, 'hex');
  return cell.value;
}

const acceptsCell = (column, cell) => Boolean(column?.editable && (cell.kind === 'NULL' ? column.nullable :
  column.type === 'ANY' || column.type === cell.kind));
const quoteIdentifier = value => '"' + value.replaceAll('"', '""') + '"';
const cellUpdateSql = (table, column, key) => 'UPDATE OR ABORT main.' + quoteIdentifier(table) + ' SET ' +
  quoteIdentifier(column) + '=? WHERE ' + quoteIdentifier(key) + '=?';

module.exports = { integer, normalizeCell, binding, valueLimit, acceptsCell, cellUpdateSql, quoteIdentifier };
