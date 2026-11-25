'use strict';

const { analyzeSql } = require('./sql-analysis');
const { quickFixContext } = require('./sql-fix-context');
const { endpointKey, validName, maxParts, maxSources } = require('./join-catalog');

const tail = new Set(['WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'WINDOW', 'FOR', 'LOCK', 'INTO', 'PROCEDURE', 'QUALIFY']);
const excluded = new Set(['CROSS', 'NATURAL', 'FULL', 'STRAIGHT_JOIN', 'USING', 'UNION', 'INTERSECT', 'EXCEPT']);
const modifiers = new Set(['LEFT', 'RIGHT', 'INNER', 'OUTER']);
const allowed = new Set(['', 'LEFT', 'RIGHT', 'INNER', 'LEFT OUTER', 'RIGHT OUTER']);
const word = (token, value) => token?.kind === 'word' && token.upper === value;
const keyword = (token, words) => token?.kind === 'word' && words.has(token.upper);
const quote = value => '`' + value.replaceAll('`', '``') + '`';
const endpoint = relation => relation.catalog ? { schema: relation.catalog.database, table: relation.catalog.table } : relation.requested;
const matchingEndpoint = (left, right) => endpointKey(left) === endpointKey(right);

function segments(tokens, source) {
  const top = [];
  for (let i = 0; i < tokens.length; i++) {
    top.push(tokens[i]);
    if (tokens[i].close !== undefined) i = tokens[i].close;
  }
  if (top.some(token => keyword(token, excluded))) return [];
  const from = top.findIndex(token => word(token, 'FROM'));
  if (from < 0) return [];
  const end = top.findIndex((token, i) => i > from && (token.kind === 'symbol' && token.value === ';' || keyword(token, tail)));
  const list = top.slice(from + 1, end === -1 ? undefined : end);
  if (list.some(token => token.kind === 'symbol' && token.value === ',')) return [];
  const joins = [];
  for (const [index, token] of list.entries()) {
    if (!word(token, 'JOIN')) continue;
    let prefix = index;
    while (keyword(list[prefix - 1], modifiers)) prefix--;
    if (!allowed.has(list.slice(prefix, index).map(item => item.upper).join(' '))) return [];
    joins.push({ token, prefix, index });
  }
  return joins.map(({ token, index }, i) => {
    const next = joins[i + 1]?.prefix ?? list.length;
    const predicate = list.slice(index + 1, next);
    const on = predicate.findIndex(item => word(item, 'ON'));
    return { token, on: predicate[on], needsPredicate: on === -1 || on === predicate.length - 1,
      boundary: list[next]?.start ?? top[end]?.start ?? source.length };
  });
}

function joinGap(text, offset, catalog) {
  if (catalog?.cachedMetadata) return null;
  const context = quickFixContext(text, offset, catalog);
  if (!context || !word(context.tokens[0], 'SELECT')) return null;
  const { source, local, tokens, nonCode, options, part } = context;
  const joins = segments(tokens, source);
  const missing = joins.filter(join => join.needsPredicate);
  if (missing.length !== 1) return null;
  const gap = missing[0], index = joins.indexOf(gap);
  if (local < gap.token.end || local > gap.boundary) return null;
  const blank = gap.on ? source.slice(0, gap.on.start) + ' '.repeat(gap.on.end - gap.on.start) + source.slice(gap.on.end) : source;
  const model = analyzeSql(blank, catalog, options);
  if (model.scopes.length !== 1 || model.scopes[0].partial || model.relations.length !== joins.length + 1 ||
      model.relations.length > maxSources) return null;
  const relations = model.relations;
  if (relations.some(relation => relation.kind !== 'catalog' || !validName(relation.alias) ||
      !validName(endpoint(relation)?.schema) || !validName(endpoint(relation)?.table)) ||
      new Set(relations.map(relation => relation.alias.toLowerCase())).size !== relations.length) return null;
  const right = relations[index + 1];
  if (local < right.start || right.start < gap.token.end || right.end > gap.boundary ||
      nonCode.some(span => span.start < gap.boundary && span.end > right.end)) return null;
  const endpoints = [...new Map(relations.map(relation => [endpointKey(endpoint(relation)), endpoint(relation)])).values()];
  return { source, blank, options, start: gap.on?.end ?? right.end, statementStart: part.start, right,
    prior: relations.slice(0, index + 1), endpoints, joins, hasOn: Boolean(gap.on) };
}

function completeModel(text, catalog, options) {
  const model = analyzeSql(text, catalog, options);
  return model.state === 'known' && !model.diagnostics.length && model.scopes.length === 1 && model.scopes[0].complete ? model : null;
}

function orderedPredicates(edge, left, right, leftColumns, rightColumns, reversed) {
  const used = { left: new Set(), right: new Set() }, predicates = [];
  for (const [index, part] of edge.parts.entries()) {
    const lhs = reversed ? part.parentColumn : part.column, rhs = reversed ? part.column : part.parentColumn;
    if (part.ordinal !== index + 1 || !validName(lhs) || !validName(rhs) || used.left.has(lhs) || used.right.has(rhs) ||
        !leftColumns.some(item => item.name === lhs) || !rightColumns.some(item => item.name === rhs)) return [];
    used.left.add(lhs);
    used.right.add(rhs);
    predicates.push(quote(left.alias) + '.' + quote(lhs) + ' = ' + quote(right.alias) + '.' + quote(rhs));
  }
  return predicates;
}

function livePredicates(gap, catalog, inventory) {
  const tables = new Map(inventory.tables.filter(item => item.kind === 'table').map(item =>
    [endpointKey({ schema: item.schema, table: item.name }), item]));
  if (gap.endpoints.some(value => !tables.has(endpointKey(value)))) return [];
  const observed = [...tables.values()];
  const options = { ...gap.options, joinTables: observed };
  const live = { ...catalog, views: [], tables: observed.filter(item => item.schema === catalog.database) };
  const model = completeModel(gap.blank, live, options);
  if (!model) return [];
  const relations = new Map(model.relations.map(relation => [relation.id, relation]));
  // The binder resolves a block's aliases collectively. Exclude an already
  // open predicate that refers to a relation only introduced by a later JOIN.
  if (gap.joins.some(join => join.on && model.references.some(ref =>
    ref.start > join.on.end && ref.start < join.boundary && relations.get(ref.relationId)?.start >= join.boundary))) return [];
  const right = gap.right, rightEndpoint = endpoint(right);
  const rightColumns = tables.get(endpointKey(rightEndpoint)).columns;
  const fixes = new Map();
  for (const left of gap.prior) {
    const leftEndpoint = endpoint(left), leftColumns = tables.get(endpointKey(leftEndpoint)).columns;
    if (matchingEndpoint(leftEndpoint, rightEndpoint)) continue;
    for (const edge of inventory.edges) {
      if (edge.kind !== 'physical' || !validName(edge.name) || !Array.isArray(edge.parts) || !edge.parts.length ||
          edge.parts.length > maxParts || !edge.parent || !edge.child) continue;
      const reversed = matchingEndpoint(edge.parent, leftEndpoint) && matchingEndpoint(edge.child, rightEndpoint);
      if (!reversed && !(matchingEndpoint(edge.child, leftEndpoint) && matchingEndpoint(edge.parent, rightEndpoint))) continue;
      const predicates = orderedPredicates(edge, left, right, leftColumns, rightColumns, reversed);
      if (!predicates.length) continue;
      const replacement = (gap.hasOn ? ' ' : ' ON ') + predicates.join(' AND ');
      if (fixes.has(replacement)) continue;
      if (!completeModel(gap.source.slice(0, gap.start) + replacement + gap.source.slice(gap.start), live, options)) continue;
      const start = gap.statementStart + gap.start;
      const aliases = gap.joins.length > 1 ? ' (' + left.alias + ' → ' + right.alias + ')' : '';
      fixes.set(replacement, { title: 'Complete JOIN using ' + edge.name + aliases, start, end: start, replacement, edge });
      if (fixes.size === 20) return [...fixes.values()];
    }
  }
  return [...fixes.values()];
}

async function sqlJoinFixes(text, offset, catalog, observe) {
  if (typeof observe !== 'function') return [];
  try {
    const gap = joinGap(text, offset, catalog);
    if (!gap) return [];
    const inventory = await observe({ endpoints: gap.endpoints });
    return livePredicates(gap, catalog, inventory);
  } catch { return []; }
}

module.exports = { sqlJoinFixes };
