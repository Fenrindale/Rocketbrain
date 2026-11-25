'use strict';

const { analyzeSql, statementRanges } = require('./sql-analysis');
const { tokenize } = require('./sql-policy');

const insertModifiers = new Set(['LOW_PRIORITY', 'DELAYED', 'HIGH_PRIORITY', 'IGNORE']);
const aggregate = /^(?:COUNT|SUM|AVG|MIN|MAX|GROUP_CONCAT|JSON_ARRAYAGG|JSON_OBJECTAGG|STDDEV|VARIANCE)\s*\(/i;
const quote = value => '`' + value.replaceAll('`', '``') + '`';
const identifier = token => token && (token.kind === 'identifier' || token.kind === 'word');
const word = (token, value) => token?.kind === 'word' && token.upper === value;
const symbol = (token, value) => token?.kind === 'symbol' && token.value === value;
const equal = (left, right, caseSensitive = false) => typeof left === 'string' && typeof right === 'string' &&
  (caseSensitive ? left === right : left.toLowerCase() === right.toLowerCase());
const complete = catalog => catalog?.coverage?.columns === 'loaded' && catalog.coverage.tables === 'loaded';

function section(scope, before, after, options, catalog, sql) {
  const last = before.at(-1);
  if ((word(last, 'SELECT') || word(last, 'DISTINCT') && word(before.at(-2), 'SELECT')) && word(after[0], 'FROM')) {
    if (!scope || !scope.relations.length || scope.partial || scope.relations.some(relation => !relation.complete)) return;
    const terms = scope.relations.flatMap(relation =>
      relation.columns.map(column => quote(relation.alias) + '.' + quote(column.name)));
    return { kind:'select', label:'Visible SELECT columns', terms };
  }
  if (word(last, 'BY') && word(before.at(-2), 'GROUP') &&
      (!after.length || ['HAVING', 'ORDER', 'LIMIT'].some(clause => word(after[0], clause)))) {
    if (!scope?.projections.length || scope.partial || scope.relations.some(relation => !relation.complete)) return;
    const terms = new Set();
    for (const projection of scope.projections) {
      if (typeof projection.start !== 'number' || typeof projection.end !== 'number') return;
      const text = sql.slice(projection.start, projection.end);
      if (aggregate.test(text)) continue;
      const projected = tokenize(text, false, { sqlMode:options.sqlMode });
      const name = projected[0];
      const qualified = identifier(name) && symbol(projected[1], '.') && identifier(projected[2]);
      const column = qualified ? projected[2] : name;
      const tail = projected.slice(qualified ? 3 : 1);
      if (!projection.physicalColumn || !identifier(column) ||
          tail.length && !(tail.length === 2 && word(tail[0], 'AS') && identifier(tail[1]))) return;
      const relations = scope.relations.filter(relation => equal(qualified ? relation.alias : projection.physicalColumn.table, relation.alias) ||
        !qualified && equal(projection.physicalColumn.table, relation.name, options.tableNameCaseSensitive));
      if (relations.length !== 1) return;
      terms.add(quote(relations[0].alias) + '.' + quote(column.value));
    }
    return { kind:'group', label:'Projected GROUP BY columns', terms:[...terms] };
  }
  if (!word(before[0], 'INSERT')) return;
  let end = 1;
  while (before[end]?.kind === 'word' && insertModifiers.has(before[end].upper)) end++;
  if (!word(before[end], 'INTO')) return;
  const target = before.slice(end + 1), parenthesized = symbol(target.at(-1), '(');
  if (parenthesized) target.pop();
  if (parenthesized ? after.length && !symbol(after[0], ')') :
      after.length && !word(after[0], 'VALUES') && !word(after[0], 'VALUE')) return;
  const qualified = target.length === 3 && identifier(target[0]) && symbol(target[1], '.');
  if (target.length !== 1 && !qualified || !identifier(target.at(-1)) ||
      qualified && !equal(target[0].value, catalog.database, options.tableNameCaseSensitive)) return;
  const tables = catalog.tables.filter(table => table.kind === 'table' &&
    equal(table.name, target.at(-1).value, options.tableNameCaseSensitive));
  if (tables.length !== 1 || !tables[0].columns.every(column => typeof column.extra === 'string')) return;
  const terms = [...tables[0].columns].sort((a, b) => a.ordinal - b.ordinal).filter(column =>
    !/\b(?:AUTO_INCREMENT|(?:VIRTUAL|STORED|PERSISTENT)\s+GENERATED)\b/i.test(column.extra)).map(column => quote(column.name));
  return { kind:'insert', label:'Observed writable INSERT columns', terms, wrap:!parenthesized };
}

function sqlFieldLists(text, offset, catalog, options = {}) {
  if (!complete(catalog) || !Array.isArray(catalog.tables) || offset < 0 || offset > text.length) return [];
  const ranges = statementRanges(text, options);
  const part = ranges.statements.find(range => range.start <= offset && offset <= range.end);
  if (!part || ranges.unknown.some(item => item.start <= offset && item.start >= part.start)) return [];
  const sql = text.slice(part.start, part.end), local = offset - part.start;
  let tokens;
  try { tokens = tokenize(sql, false, { sqlMode:options.sqlMode }); } catch { return []; }
  if (tokens.some(token => token.start < local && local < token.end)) return [];
  const before = tokens.filter(token => token.end <= local), after = tokens.filter(token => token.start >= local);
  if (!before.length || /\S/.test(sql.slice(before.at(-1).end, local))) return [];
  const analysis = analyzeSql(sql, catalog, { ...options, catalogComplete:true });
  const anchor = before.at(-1).start;
  if (analysis._nonCode?.some(range => range.start <= local && local < range.end)) return [];
  const scope = analysis.scopes.filter(entry => entry.start <= anchor && anchor < entry.end)
    .sort((a, b) => b.depth - a.depth)[0];
  let value;
  try { value = section(scope, before, after, options, catalog, sql); } catch { return []; }
  if (!value?.terms.length || value.terms.length > 128 || new Set(value.terms).size !== value.terms.length) return [];
  const fields = value.terms.join(', ');
  const prefix = /[\p{L}\p{N}_$`]/u.test(text[offset - 1] || '') ? ' ' : '';
  const suffix = /[\p{L}\p{N}_$`]/u.test(text[offset] || '') ? ' ' : '';
  const count = value.terms.length;
  const provenance = catalog.cachedMetadata ? ' · cached catalog' : ' · observed catalog';
  return [{ label:value.label, kind:value.kind, detail:count + (count === 1 ? ' column' : ' columns') + provenance,
    insertText:prefix + (value.wrap ? '(' + fields + ')' : fields) + suffix, start:offset, end:offset }];
}

module.exports = { sqlFieldLists };
