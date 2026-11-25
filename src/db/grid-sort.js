'use strict';

const { jsonScalarSort } = require('./grid-json-sort');

const QUOTE = String.fromCharCode(96);
const quote = name => QUOTE + name.replaceAll(QUOTE, QUOTE + QUOTE) + QUOTE;
const safeCollation = value => typeof value === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(value);
const error = message => Object.assign(Error(message), { code: 'ROCKETBRAIN_GRID_QUERY' });
const numeric = new Set(['integer', 'decimal', 'float']);
const maxExpression = 256;
const maxCharsets = 64;
const maxCollations = 2048;

function sortMode(column) {
  if (column.kind === 'json') return 'json';
  if (column.kind === 'binary') {
    if (/^bit\([1-9]\d?\)$/i.test(column.type)) return 'plain';
    const size = /^(?:var)?binary\((\d+)\)$/i.exec(column.type);
    return size && Number(size[1]) <= 512 ? 'plain' : 'bytes';
  }
  if (column.kind === 'text' || column.kind === 'datetime' || numeric.has(column.kind)) return 'plain';
}

function sortOptions(columns, collations, snapshot = false) {
  return {
    columns: columns.flatMap(column => {
      const mode = sortMode(column);
      if (!mode || snapshot && mode === 'bytes') return [];
      const charset = column.kind === 'text' && safeCollation(column.charset) ? column.charset : undefined;
      const reference = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(column.name) ? column.name : quote(column.name);
      const expression = mode === 'json' ? 'JSON_TEXT(' + reference + ')' : mode === 'bytes' ? 'BYTE_PREFIX(' + reference + ')' : undefined;
      return [{ name: column.name, ...(charset && { charset }), ...(expression && !snapshot && { expression }),
        ...(mode === 'json' && { jsonScalar: true }) }];
    }),
    collations,
    ...(snapshot && { snapshot: true })
  };
}

async function observeSortCollations(columns, read) {
  const charsets = [...new Set(columns.filter(column => column.kind === 'text').map(column => column.charset).filter(safeCollation))].slice(0, maxCharsets);
  const compatible = Object.create(null);
  if (!charsets.length) return compatible;
  const sql = 'SELECT COLLATION_NAME,CHARACTER_SET_NAME FROM information_schema.COLLATIONS WHERE CHARACTER_SET_NAME IN (' +
    charsets.map(() => '?').join(',') + ') ORDER BY CHARACTER_SET_NAME,COLLATION_NAME LIMIT ' + (maxCollations + 1);
  let rows;
  try { rows = await read(sql, charsets, maxCollations + 1); }
  catch { return compatible; }
  // An incomplete observation is never treated as a complete list of compatible collations.
  if (!Array.isArray(rows) || rows.length > maxCollations) return compatible;
  for (const [name, charset] of rows) {
    if (charsets.includes(charset) && safeCollation(name)) (compatible[charset] ??= []).push(name);
  }
  for (const charset of Object.keys(compatible)) compatible[charset] = [...new Set(compatible[charset])];
  return compatible;
}

const binaryPrefix = sql => 'LEFT(CAST(' + sql + ' AS BINARY),512)';
const tokenPattern = new RegExp('\\s+|\\d{1,12}(?:\\.\\d{1,6})?|[A-Za-z_$][A-Za-z0-9_$]*|' +
  QUOTE + '(?:[^' + QUOTE + '\\x00-\\x1f\\x7f]|' + QUOTE + QUOTE + ')+' + QUOTE + '|[()+*/%,-]', 'gy');
const typed = (kind, sql, charset, collation) => ({ kind, sql, charset, collation });
const number = sql => typed('number', sql);

function expressionError() {
  return error('Enter a bounded sort expression using exact column names, numeric literals, arithmetic, or ABS, LOWER, UPPER, TRIM, CHAR_LENGTH, JSON_TEXT and BYTE_PREFIX.');
}

function tokensFor(text) {
  const tokens = [];
  tokenPattern.lastIndex = 0;
  while (tokenPattern.lastIndex < text.length) {
    const previous = tokenPattern.lastIndex, token = tokenPattern.exec(text)?.[0];
    if (!token || tokenPattern.lastIndex <= previous) throw expressionError();
    if (!/^\s+$/.test(token)) tokens.push(token);
    if (tokens.length > 96) throw expressionError();
  }
  return tokens;
}

function compileExpression(expression, columns, anchor) {
  if (typeof expression !== 'string' || expression.length > maxExpression || !expression.trim()) throw expressionError();
  const tokens = tokensFor(expression);
  const references = new Set();
  let cursor = 0;
  const peek = () => tokens[cursor];
  const take = () => tokens[cursor++];
  const expect = token => { if (take() !== token) throw expressionError(); };
  const precedence = new Map([['+', 1], ['-', 1], ['*', 2], ['/', 2], ['%', 2]]);
  function functionCall(name, depth) {
    expect('(');
    const argument = parse(1, depth + 1);
    expect(')');
    if (name === 'ABS' && argument.kind === 'number') return number('ABS(' + argument.sql + ')');
    if (name === 'CHAR_LENGTH' && argument.kind === 'text') return number('CHAR_LENGTH(' + argument.sql + ')');
    if (['LOWER', 'UPPER', 'TRIM'].includes(name) && argument.kind === 'text') {
      return typed('text', name + '(' + argument.sql + ')', argument.charset, argument.collation);
    }
    if (name === 'JSON_TEXT' && argument.kind === 'json' || name === 'BYTE_PREFIX' && argument.kind === 'binary') {
      return typed('bytes', binaryPrefix(argument.sql));
    }
    throw expressionError();
  }
  function atom(depth) {
    if (depth > 12) throw expressionError();
    const token = take();
    if (token === '+' || token === '-') {
      const value = atom(depth + 1);
      if (value.kind !== 'number') throw expressionError();
      return number('(' + token + ' ' + value.sql + ')');
    }
    if (token === '(') {
      const value = parse(1, depth + 1);
      expect(')');
      return value;
    }
    if (/^\d/.test(token || '')) return number(token);
    if (/^[A-Za-z_$]/.test(token || '') && peek() === '(') return functionCall(token.toUpperCase(), depth);
    const identifier = token?.startsWith(QUOTE) ? token.slice(1, -1).replaceAll(QUOTE + QUOTE, QUOTE) : token;
    const column = columns.get(identifier);
    if (!column || !sortMode(column)) throw expressionError();
    references.add(column.name);
    const kind = numeric.has(column.kind) ? 'number' : column.kind;
    return typed(kind, quote(identifier), column.charset, column.collation);
  }
  function parse(minimum, depth) {
    let left = atom(depth);
    while ((precedence.get(peek()) || 0) >= minimum) {
      const operator = take();
      const right = parse(precedence.get(operator) + 1, depth + 1);
      if (left.kind !== 'number' || right.kind !== 'number') throw expressionError();
      left = number('(' + left.sql + ' ' + operator + ' ' + right.sql + ')');
    }
    return left;
  }
  const result = parse(1, 0);
  if (cursor !== tokens.length || !references.has(anchor) || result.kind === 'json' || result.kind === 'binary') throw expressionError();
  return { ...result, references };
}

function compileGridSort(columns, rules, collations = {}) {
  if (!Array.isArray(rules) || rules.length > 8) throw error('Use at most 8 sort columns.');
  const catalog = new Map(columns.map(column => [column.name, column]));
  const seen = new Set(), plain = new Set(), references = new Set(), order = [], fragments = [], keys = [];
  for (const item of rules) {
    const column = catalog.get(item?.column);
    const mode = column && sortMode(column);
    if (!mode || seen.has(column.name) || !['asc', 'desc'].includes(item.direction) ||
        Object.keys(item).some(key => !['column', 'direction', 'nulls', 'collation', 'expression', 'jsonPath', 'jsonType'].includes(key)) ||
        (item.nulls !== undefined && !['first', 'last'].includes(item.nulls))) {
      throw error('Select distinct supported sort columns, a direction and an optional NULL placement.');
    }
    seen.add(column.name);
    references.add(column.name);
    const { expression, jsonPath, jsonType } = item;
    const json = jsonPath !== undefined || jsonType !== undefined;
    if (json && (mode !== 'json' || expression !== undefined || item.collation !== undefined)) {
      throw error('A typed JSON path applies to one JSON column without a second expression or collation.');
    }
    if (!json && expression === undefined && mode !== 'plain') throw expressionError();
    const name = quote(column.name);
    const key = json ? jsonScalarSort(name, jsonPath, jsonType) : expression === undefined
      ? typed(column.kind, name, column.charset, column.collation)
      : compileExpression(expression, catalog, column.name);
    for (const name of key.references || []) references.add(name);
    const collation = item.collation;
    if (collation !== undefined && (key.kind !== 'text' || !safeCollation(collation) || !Object.hasOwn(collations, key.charset) ||
        !collations[key.charset]?.includes(collation))) throw error('Select a collation observed by this server for the sort expression’s character set.');
    const sql = collation === undefined ? key.sql : '(' + key.sql + ' COLLATE ' + collation + ')';
    if (item.nulls !== undefined) fragments.push('(' + sql + ' IS NULL) ' + (item.nulls === 'first' ? 'DESC' : 'ASC'));
    fragments.push(sql + ' ' + item.direction.toUpperCase());
    const rule = {
      column: column.name,
      direction: item.direction,
      ...(item.nulls !== undefined && { nulls: item.nulls }),
      ...(collation !== undefined && { collation }),
      ...(expression !== undefined && { expression: expression.trim() }),
      ...(json && { jsonPath, jsonType })
    };
    order.push(rule);
    keys.push({ ...rule, sql, cursorKind: key.cursorKind });
    if (!json && expression === undefined && collation === undefined) plain.add(column.name);
  }
  const sort = [...order];
  for (const column of columns) {
    if (!column.primaryKey || plain.has(column.name)) continue;
    references.add(column.name);
    const rule = { column: column.name, direction: 'asc' }, sql = quote(column.name);
    order.push(rule);
    keys.push({ ...rule, sql });
    fragments.push(sql + ' ASC');
  }
  return { sort, order, fragments, keys, references: [...references].map(name => catalog.get(name)) };
}

module.exports = { compileGridSort, observeSortCollations, sortOptions };
