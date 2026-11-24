'use strict';

const { tokenize } = require('./sql-policy');
const { analyzeSql, statementRanges } = require('./sql-analysis');

const quote = value => '`' + value.replaceAll('`', '``') + '`';
const identifier = value => typeof value === 'string' &&
  value.length > 0 && value.length <= 64 && !/[\x00-\x1f\x7f]/.test(value);
const compatibleJoin = new Set(['INNER', 'LEFT', 'RIGHT', 'OUTER', 'CROSS', 'NATURAL']);

function joinPosition(text, offset, options) {
  const { statements, unknown } = statementRanges(text, options);
  const statement = statements[0];
  if (!statement || unknown.length || offset > statement.end || offset <= statement.start) return null;
  const before = text.slice(statement.start, offset);
  const after = text.slice(offset, statement.end);
  if (!/^(?:\s*(?:;\s*)?$|\s+(?:WHERE|GROUP\s+BY|ORDER\s+BY|HAVING|LIMIT)\b)/i.test(after)) return null;

  let tokens;
  try {
    tokens = tokenize(before, false, options);
  } catch {
    return null;
  }
  if (tokens[0]?.upper !== 'SELECT') return null;
  let index = tokens.length - 1;
  if (tokens[index]?.upper !== 'JOIN') index--;
  const join = tokens[index];
  if (join?.kind !== 'word' || join.upper !== 'JOIN') return null;
  const partial = tokens[index + 1];
  if (partial && (partial.kind !== 'word' || partial.end !== before.length)) return null;
  if (tokens.length !== index + (partial ? 2 : 1)) return null;
  const gap = before.slice(join.end, partial?.start ?? before.length);
  if (!/^\s+$/.test(gap)) return null;

  let start = index;
  while (compatibleJoin.has(tokens[start - 1]?.upper) && tokens[start - 1]?.kind === 'word') start--;
  const modifiers = tokens.slice(start, index).map(token => token.upper).join(' ');
  if (!['', 'INNER', 'LEFT', 'RIGHT', 'LEFT OUTER', 'RIGHT OUTER'].includes(modifiers)) return null;
  let depth = 0;
  let from = false;
  for (const token of tokens.slice(0, start)) {
    if (token.kind === 'symbol') {
      if (token.value === '(') depth++;
      if (token.value === ')') depth--;
    }
    if (depth !== 0 || token.kind !== 'word') continue;
    if (token.upper === 'FROM') from = true;
    if (['WHERE', 'GROUP', 'ORDER', 'HAVING', 'LIMIT', 'UNION', 'INTERSECT', 'EXCEPT', 'FOR', 'LOCK'].includes(token.upper)) return null;
  }
  if (depth !== 0 || !from) return null;
  return { base: before.slice(0, tokens[start].start), prefix: partial?.value || '',
    replacementStart: statement.start + (partial?.start ?? before.length) };
}

function foreignKeyJoins(text, offset, catalog, options = {}) {
  if (!identifier(catalog?.database) || !['tables', 'columns', 'foreignKeys'].every(area => catalog.coverage?.[area] === 'loaded')) return [];
  const position = joinPosition(text, offset, options);
  if (!position) return [];
  const model = analyzeSql(position.base, catalog, { ...options, catalogComplete: true });
  if (model.state !== 'known' || model.scopes.length !== 1) return [];
  const { relations } = model.scopes[0];
  if (!relations.length || relations.some(item => item.kind !== 'catalog' ||
    item.catalog?.database !== catalog.database || !identifier(item.alias))) return [];

  const tables = new Map(catalog.tables.filter(table => table.kind === 'table' && identifier(table.name))
    .map(table => [table.name, table]));
  if (relations.some(relation => !tables.has(relation.catalog.table))) return [];
  const aliasNames = new Set(relations.map(relation => relation.alias.toLowerCase()));
  let nextAlias = 'rb_join';
  for (let suffix = 2; aliasNames.has(nextAlias); suffix++) nextAlias = 'rb_join_' + suffix;
  const results = new Map();
  function add(relation, child, parent, fk, inbound) {
    const target = inbound ? child : parent;
    if (!identifier(fk.name) || !target.name.toLowerCase().startsWith(position.prefix.toLowerCase()) ||
      !Array.isArray(fk.columns) || !fk.columns.length || fk.columns.length > 16) return;
    const columns = [...fk.columns].sort((a, b) => a.ordinal - b.ordinal);
    const predicates = [];
    const needsAlias = aliasNames.has(target.name.toLowerCase());
    const targetRef = quote(needsAlias ? nextAlias : target.name);
    const sourceRef = quote(relation.alias);
    for (const [index, column] of columns.entries()) {
      if (column.ordinal !== index + 1 || !identifier(column.name) || !identifier(column.referencedColumn) ||
        !child.columns.some(value => value.name === column.name) || !parent.columns.some(value => value.name === column.referencedColumn)) return;
      const childRef = inbound ? targetRef : sourceRef;
      const parentRef = inbound ? sourceRef : targetRef;
      predicates.push(childRef + '.' + quote(column.name) + ' = ' + parentRef + '.' + quote(column.referencedColumn));
    }
    const insertText = quote(catalog.database) + '.' + quote(target.name) +
      (needsAlias ? ' AS ' + targetRef : '') + ' ON ' + predicates.join(' AND ');
    results.set(insertText, {
      label: target.name + ' via ' + fk.name + ' (' + relation.alias + ')',
      detail: child.name + ' → ' + parent.name + ' · verified foreign key',
      insertText, start: position.replacementStart, end: offset
    });
  }
  for (const child of tables.values()) {
    for (const fk of child.foreignKeys || []) {
      if (fk.referencedSchema !== catalog.database) continue;
      const parent = tables.get(fk.referencedTable);
      if (!parent) continue;
      for (const relation of relations) {
        if (relation.catalog.table === child.name) add(relation, child, parent, fk, false);
        if (relation.catalog.table === parent.name) add(relation, child, parent, fk, true);
      }
      if (results.size >= 30) return [...results.values()].slice(0, 30);
    }
  }
  return [...results.values()];
}

module.exports = { foreignKeyJoins };
