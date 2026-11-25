'use strict';

const jsonSortTypes = new Set(['integer', 'boolean', 'text']);
const maxTextBytes = 256;
const maxPath = 128;
const integerDigits = 20;
const step = /\.[A-Za-z_][A-Za-z_0-9]{0,31}|\[(?:0|[1-9]\d{0,3})\]/gy;

function sortError(message) {
  return Object.assign(Error(message), { code: 'ROCKETBRAIN_GRID_QUERY' });
}

function parsePath(path) {
  if (typeof path !== 'string' || path.length > maxPath || path[0] !== '$') {
    throw sortError('Enter a JSON path starting with $, using member names and nonnegative array indexes.');
  }
  const arrayParents = [];
  let offset = 1, count = 0;
  while (offset < path.length) {
    step.lastIndex = offset;
    const part = step.exec(path)?.[0];
    if (!part || ++count > 8) throw sortError('Use up to eight JSON member or array steps without wildcards or quoted names.');
    if (part[0] === '[') arrayParents.push(path.slice(0, offset));
    offset += part.length;
  }
  return arrayParents;
}

function jsonScalarSort(column, path, type) {
  if (!jsonSortTypes.has(type)) throw sortError('Choose Integer, Boolean or UTF-8 text for the JSON sort key.');
  const parents = parsePath(path);
  const document = 'CASE WHEN JSON_VALID(' + column + ') = 1 THEN ' + column + ' END';
  const extract = name => "JSON_EXTRACT(" + document + ",'" + name + "')";
  const value = extract(path), unquoted = 'JSON_UNQUOTE(' + value + ')';
  const matches = parents.map(parent => 'JSON_TYPE(' + extract(parent) + ") = 'ARRAY'");
  const kind = 'JSON_TYPE(' + value + ')';
  let converted;
  if (type === 'integer') {
    matches.push(kind + " IN ('INTEGER','UNSIGNED INTEGER')", unquoted + " REGEXP '^-?[0-9]{1," + integerDigits + "}$'");
    converted = 'CAST(' + unquoted + ' AS DECIMAL(' + integerDigits + ',0))';
  } else if (type === 'boolean') {
    matches.push(kind + " = 'BOOLEAN'");
    converted = "CASE WHEN " + unquoted + " = 'true' THEN 1 ELSE 0 END";
  } else {
    const bytes = 'CAST(CONVERT(' + unquoted + ' USING utf8mb4) AS BINARY)';
    matches.push(kind + " = 'STRING'", 'OCTET_LENGTH(' + bytes + ') <= ' + maxTextBytes);
    converted = bytes;
  }
  return { sql: '(CASE WHEN ' + matches.join(' AND ') + ' THEN ' + converted + ' END)', cursorKind: type };
}

function jsonCursorBound(value, kind) {
  const text = String(value);
  if (kind === 'integer' && /^-?\d{1,20}$/u.test(text)) {
    return { sql: 'CAST(? AS DECIMAL(' + integerDigits + ',0))', parameter: text };
  }
  if (kind === 'boolean' && ['0', '1'].includes(text)) {
    return { sql: 'CAST(? AS UNSIGNED)', parameter: Number(text) };
  }
  if (kind === 'text' && text.length <= 2 + maxTextBytes * 2 && /^0x(?:[0-9a-f]{2})*$/iu.test(text)) {
    return { sql: 'CAST(? AS BINARY)', parameter: Buffer.from(text.slice(2), 'hex') };
  }
  throw sortError('The observed JSON continuation value no longer matches its declared type.');
}

module.exports = { jsonScalarSort, jsonCursorBound };
