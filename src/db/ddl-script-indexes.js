'use strict';

const { tokenize } = require('./sql-policy');
const same = (left, right) => left.toLowerCase() === right.toLowerCase();
const word = (token, value) => token?.kind === 'word' && token.upper === value;
const symbol = (token, value) => token?.kind === 'symbol' && token.value === value;
const nameToken = token => ['word', 'identifier'].includes(token?.kind) && typeof token.value === 'string' &&
  token.value.length > 0 && token.value.length <= 64 && !/[\x00-\x1f\x7f]/u.test(token.value);
const quote = name => '`' + name.replaceAll('`', '``') + '`';
const indexWord = token => word(token, 'INDEX') || word(token, 'KEY');
const reservedAliases = new Set(['AS', 'WHERE', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'CROSS', 'ON', 'GROUP', 'BY',
  'ORDER', 'HAVING', 'LIMIT', 'OFFSET', 'UNION', 'INTERSECT', 'EXCEPT', 'FOR', 'LOCK', 'PARTITION', 'USE', 'FORCE', 'IGNORE']);
const aliasToken = token => nameToken(token) && (token.kind === 'identifier' || !reservedAliases.has(token.upper));

function indexName(token) {
  if (!nameToken(token) || same(token.value, 'PRIMARY')) throw Error('Choose an explicit secondary index name.');
  return token.value;
}

function addedIndex(tokens, columns) {
  const unique = word(tokens[0], 'UNIQUE'), start = unique ? 1 : 0;
  if (!indexWord(tokens[start]) || !symbol(tokens[start + 2], '(') || !symbol(tokens.at(-1), ')')) {
    throw Error('Use a named secondary index with an explicit column list.');
  }
  const name = indexName(tokens[start + 1]), keys = tokens.slice(start + 3, -1), seen = new Set();
  if (!keys.length || keys.length % 2 !== 1 || keys.length > 31) throw Error('Use one to sixteen plain secondary index columns.');
  const definition = [];
  for (const [index, token] of keys.entries()) {
    if (index % 2) {
      if (!symbol(token, ',')) throw Error('Indexed prefixes, expressions and options require separate review.');
      continue;
    }
    const column = nameToken(token) && columns.find(item => same(item.name, token.value));
    if (!column || seen.has(column.name) || /GENERATED/i.test(column.extra ?? '') ||
        !/^(?:tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|char|varchar|binary|varbinary|date|time|datetime|timestamp|year)\b/i.test(column.type)) {
      throw Error('Choose distinct plain index columns visible in this script.');
    }
    seen.add(column.name);
    definition.push({ name: column.name, ordinal: definition.length + 1, prefixLength: null, collation: 'A' });
  }
  return { name, unique, type: 'BTREE', primaryKey: false, columns: definition, scriptIndex: true };
}

function isIndexAlter(tokens) {
  return indexWord(tokens[1]) || word(tokens[0], 'ADD') && word(tokens[1], 'UNIQUE') && indexWord(tokens[2]);
}

function alterIndex(tokens, table, used) {
  const indexes = table.indexes;
  const find = name => indexes.findIndex(index => same(index.name, name));
  const reserve = name => {
    if (used.has(name.toLowerCase())) throw Error('Use separate ALTER statements when changing the same index twice.');
    used.add(name.toLowerCase());
  };
  if (word(tokens[0], 'ADD')) {
    const index = addedIndex(tokens.slice(1), table.columns);
    reserve(index.name);
    if (find(index.name) >= 0 || indexes.length >= 64) throw Error('Choose a distinct index name within the 64-index script limit.');
    indexes.push(index);
    return { action: 'add', name: index.name, columns: index.columns.map(column => column.name) };
  }
  const name = indexName(tokens[2]), index = find(name);
  reserve(name);
  if (index < 0 || !indexes[index].scriptIndex) throw Error('Rename or drop a secondary index introduced earlier in this script.');
  if (word(tokens[0], 'DROP') && tokens.length === 3) {
    indexes.splice(index, 1);
    return { action: 'drop', name };
  }
  if (word(tokens[0], 'RENAME') && word(tokens[3], 'TO') && tokens.length === 5) {
    const next = indexName(tokens[4]);
    reserve(next);
    if (find(next) >= 0) throw Error('The replacement index name is already present.');
    indexes[index] = { ...indexes[index], name: next };
    return { action: 'rename', name, to: next };
  }
  throw Error('Use ADD INDEX, RENAME INDEX old TO new or DROP INDEX name.');
}

function tableForHint(before, catalog) {
  let depth = 0, from = -1;
  for (const [index, token] of before.entries()) {
    if (symbol(token, '(')) depth++;
    else if (symbol(token, ')')) depth--;
    else if (depth === 0 && word(token, 'FROM')) from = index;
  }
  if (from < 0 || depth !== 0) return;
  const relation = before.slice(from + 1), qualified = symbol(relation[1], '.'), at = qualified ? 2 : 0;
  const tableName = relation[at], alias = relation.slice(at + 1);
  const equivalent = catalog.tableNameCaseSensitive === false ? same : (left, right) => left === right;
  if (!nameToken(tableName) || qualified && (!nameToken(relation[0]) || !equivalent(relation[0].value, catalog.database)) ||
      alias.length && !(alias.length === 1 && aliasToken(alias[0]) || alias.length === 2 && word(alias[0], 'AS') && aliasToken(alias[1]))) return;
  const matches = catalog.tables.filter(table => equivalent(table.name, tableName.value));
  if (matches.length === 1) return matches[0];
}

const isHint = token => ['USE', 'FORCE', 'IGNORE'].some(keyword => word(token, keyword));
const mentionsHint = /\b(?:USE|FORCE|IGNORE)\s+(?:INDEX|KEY)\b/i;

function indexHintCompletions(text, offset, catalog) {
  if (!mentionsHint.test(text)) return [];
  let tokens;
  try { tokens = tokenize(text, false, { sqlMode: catalog.sqlMode }); }
  catch { return []; }
  if (!word(tokens[0], 'SELECT') || tokens.some(token => token.kind === 'string' && token.start < offset && offset < token.end)) return [];
  const current = tokens.find(token => token.start < offset && offset <= token.end && nameToken(token));
  const start = current?.start ?? offset, end = current?.end ?? offset;
  const before = tokens.filter(token => token.end <= start), after = tokens.filter(token => token.start >= end);
  const hint = before.at(-3);
  if (!symbol(before.at(-1), '(') || !indexWord(before.at(-2)) || !isHint(hint) ||
      !/^\s*$/u.test(text.slice(before.at(-1).end, start)) || after[0] && !symbol(after[0], ')')) return [];
  const table = tableForHint(before.slice(0, -3), catalog);
  const prefix = current ? text.slice(start, offset).replace(/^[`"]/, '').toLowerCase() : '';
  return (table?.indexes || []).filter(index => index.scriptIndex && index.name.toLowerCase().startsWith(prefix)).map(index => ({
    label: index.name, insertText: quote(index.name), detail: `Script index · ${index.columns.map(column => column.name).join(', ')}`, start, end
  }));
}

function maskModeledHint(text, catalog) {
  if (!mentionsHint.test(text)) return text;
  let tokens;
  try { tokens = tokenize(text, false, { sqlMode: catalog.sqlMode }); }
  catch { return text; }
  if (!word(tokens[0], 'SELECT')) return text;
  const hits = tokens.flatMap((token, at) => isHint(token) && indexWord(tokens[at + 1]) && symbol(tokens[at + 2], '(') &&
    nameToken(tokens[at + 3]) && symbol(tokens[at + 4], ')') ? [at] : []);
  if (hits.length !== 1) return text;
  const at = hits[0], table = tableForHint(tokens.slice(0, at), catalog);
  if (!table?.indexes?.some(index => index.scriptIndex && same(index.name, tokens[at + 3].value))) return text;
  const start = tokens[at].start, end = tokens[at + 4].end;
  const hint = text.slice(start, end);
  if (/\/\*|--|#/.test(hint)) return text;
  // Keep original source offsets for aliases, columns, diagnostics and completion ranges.
  return text.slice(0, start) + hint.replace(/[^\r\n]/g, ' ') + text.slice(end);
}

module.exports = { addedIndex, isIndexAlter, alterIndex, indexHintCompletions, maskModeledHint };
