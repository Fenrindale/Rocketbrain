'use strict';

const {AST, key, parseView} = require('./schema-dependency-graph');

const fail = message => Object.assign(new Error(message), {code: 'ROCKETBRAIN_REBUILD_COLUMN_MAPPING'});
const unresolved = () => fail('A mapped view column reference could not be resolved exactly.');
const obsolete = () => fail('The selected view must replace mapped source references with the reviewed destination.');
const fold = name => name.toLowerCase();
const word = (token, value) => token?.kind === 'word' && token.value.toUpperCase() === value;
const symbol = (token, value) => token?.kind === 'punct' && token.value === value;
const named = token => token?.kind === 'word' || token?.kind === 'id';
const structuralWords = new Set('SELECT FROM WHERE JOIN INNER LEFT RIGHT CROSS OUTER ON AS AND OR XOR NOT IS NULL TRUE FALSE BETWEEN IN LIKE EXISTS GROUP BY HAVING ORDER LIMIT DISTINCT UNION USING CASE WHEN THEN ELSE ASC DESC'.split(' '));

function relationColumns(plan, bundle, relationKey, phase) {
  const fields = new Map();
  for (const snapshot of bundle.tableSnapshots || []) {
    fields.set(relationKey({schema: snapshot.schema, table: snapshot.name}), snapshot.columns);
  }
  for (const step of plan.steps) {
    fields.set(relationKey({schema: plan.database, table: step.table}), step[phase]?.columns);
  }
  return fields;
}

function relationDeclarations(tokens, bindings) {
  const starts = new Map(tokens.map((token, index) => [token.start, index]));
  const ends = new Map(tokens.map((token, index) => [token.end, index]));
  const ignored = new Set();
  for (const binding of bindings) {
    const start = starts.get(binding.start), end = ends.get(binding.end);
    if (start === undefined || end === undefined || start > end) throw unresolved();
    for (let index = start; index <= end; index++) ignored.add(index);
    if (binding.alias === null) continue;
    const aliasIndex = word(tokens[end + 1], 'AS') ? end + 2 : end + 1;
    if (tokens[aliasIndex]?.name !== binding.alias) throw unresolved();
    ignored.add(aliasIndex);
  }
  return ignored;
}

function projectionAliases(tokens, ignored) {
  const aliases = new Set();
  let depth = 0;
  for (let index = 1; index < tokens.length; index++) {
    const token = tokens[index];
    if (symbol(token, '(')) depth++;
    if (symbol(token, ')')) depth--;
    if (depth) continue;
    if (word(token, 'FROM') && !symbol(tokens[index - 1], '.')) break;
    if (word(token, 'AS') && named(tokens[index + 1])) {
      aliases.add(fold(tokens[index + 1].name));
      ignored.add(index + 1);
    }
  }
  return aliases;
}

function qualifiedBinding(parts, bindings, sameRelationName) {
  const matches = bindings.filter(binding => {
    if (parts.length === 1) return sameRelationName(binding.alias ?? binding.table, parts[0]);
    return parts.length === 2 && binding.alias === null && sameRelationName(binding.schema, parts[0]) &&
      sameRelationName(binding.table, parts[1]);
  });
  if (matches.length !== 1) throw unresolved();
  return matches[0];
}

function columnBinding(parts, bindings, phase, sameRelationName) {
  const column = fold(parts.at(-1));
  if (parts.length > 1) return qualifiedBinding(parts.slice(0, -1), bindings, sameRelationName);
  if (bindings.some(binding => !binding.columns)) throw unresolved();
  const candidates = bindings.filter(binding => binding.columns.has(column));
  if (!candidates.length && phase === 'after' && bindings.some(binding => binding.pairs.some(pair => pair.from === column))) {
    throw obsolete();
  }
  if (candidates.length !== 1) throw unresolved();
  return candidates[0];
}

function bindingFields(tokens, bindings, phase, sameRelationName) {
  const ignored = relationDeclarations(tokens, bindings);
  const aliases = projectionAliases(tokens, ignored);
  const pertinent = new Set(bindings.flatMap(binding => binding.pairs.flatMap(pair => [pair.from, pair.to])));
  const used = new Set();
  let depth = 0, ordering = false;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (symbol(token, '(')) depth++;
    if (symbol(token, ')')) depth--;
    if (!depth && word(token, 'ORDER') && word(tokens[index + 1], 'BY')) ordering = true;
    if (!depth && word(token, 'LIMIT')) ordering = false;
    if (word(token, 'NATURAL') || word(token, 'STRAIGHT_JOIN') || word(token, 'LATERAL')) throw unresolved();
    if (ignored.has(index)) continue;
    if (word(token, 'USING') && symbol(tokens[index + 1], '(')) {
      const end = tokens.findIndex((candidate, offset) => offset > index && symbol(candidate, ')'));
      if (end < 0 || tokens.slice(index + 2, end).some(item => named(item) && pertinent.has(fold(item.name)))) {
        throw unresolved();
      }
      index = end;
      continue;
    }
    if (symbol(token, '*') && !depth && (word(tokens[index + 1], 'FROM') ||
        word(tokens[index + 1], 'AS') || symbol(tokens[index + 1], ','))) throw unresolved();
    if (!named(token)) continue;
    const start = index, parts = [token.name];
    while (symbol(tokens[index + 1], '.') && named(tokens[index + 2])) {
      parts.push(tokens[index + 2].name);
      index += 2;
    }
    if (symbol(tokens[index + 1], '.') && symbol(tokens[index + 2], '*')) {
      const binding = qualifiedBinding(parts, bindings, sameRelationName);
      if (binding.pairs.length) throw unresolved();
      index += 2;
      continue;
    }
    const column = fold(parts.at(-1));
    if (!pertinent.has(column) || symbol(tokens[index + 1], '(')) continue;
    if (parts.length === 1 && token.kind === 'word' && structuralWords.has(token.name.toUpperCase())) continue;
    const last = tokens[index + 1];
    // An explicit alias used as a bare ORDER BY item denotes an output slot.
    if (ordering && !depth && parts.length === 1 && aliases.has(column) &&
        (word(tokens[start - 1], 'BY') || symbol(tokens[start - 1], ',')) &&
        (!last || symbol(last, ',') || word(last, 'ASC') || word(last, 'DESC') || word(last, 'LIMIT'))) continue;
    const binding = columnBinding(parts, bindings, phase, sameRelationName);
    for (const pair of binding.pairs) {
      if (phase === 'after' && pair.from === column) throw obsolete();
      if (pair[phase === 'before' ? 'from' : 'to'] === column) {
        if (!binding.columns?.has(column)) throw unresolved();
        used.add(pair);
      }
    }
  }
  return used;
}

function assertMappedViewReferences(plan, bundle) {
  if (!plan.columnMappings || !bundle.before.views.length) return;
  const caseSensitive = plan.currentServer?.tableNameCaseSensitive !== false;
  const nameKey = caseSensitive ? name => name : fold;
  const sameRelationName = (left, right) => nameKey(left) === nameKey(right);
  const relationKey = relation => caseSensitive ? key(relation) : fold(key(relation));
  const mappings = new Map(Object.entries(plan.columnMappings).map(([table, pairs]) => [
    relationKey({schema: plan.database, table}), pairs.map(pair => ({from: fold(pair.from), to: fold(pair.to)}))
  ]));
  const selected = new Set((plan.selectedViews || []).map(({before}) => key({schema: before.schema, table: before.name})));
  const after = new Map(bundle.after.views.map(view => [key({schema: view.schema, table: view.name}), view]));
  const catalogs = {
    before: relationColumns(plan, bundle, relationKey, 'before'),
    after: relationColumns(plan, bundle, relationKey, 'after')
  };
  function usedPairs(view, phase) {
    const {refs} = parseView(view.definition, view.schema, {sqlMode: view.sqlMode});
    const bindings = refs.map(ref => {
      const owner = relationKey(ref), columns = catalogs[phase].get(owner);
      return {...ref, pairs: mappings.get(owner) || [], columns: columns && new Set(columns.map(column => fold(column.name)))};
    });
    if (!bindings.some(binding => binding.pairs.length)) return new Set();
    return bindingFields(AST.lex(view.definition, {sqlMode: view.sqlMode}), bindings, phase, sameRelationName);
  }
  for (const view of bundle.before.views) {
    const identity = key({schema: view.schema, table: view.name});
    const usedBefore = usedPairs(view, 'before');
    if (usedBefore.size && !selected.has(identity)) {
      throw fail('Select each dependent view that references a mapped source column.');
    }
    const target = after.get(identity);
    if (!target) throw unresolved();
    const usedAfter = usedPairs(target, 'after');
    if ([...usedBefore].some(pair => !usedAfter.has(pair))) throw obsolete();
  }
}

module.exports = {assertMappedViewReferences};
