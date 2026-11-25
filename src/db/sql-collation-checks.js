'use strict';

const { analyzeSql, sourceTokens, statementRanges } = require('./sql-analysis');

const maxRows = 4096;
const maxStatements = 100;
const maxDiagnostics = 160;
const name = value => typeof value === 'string' && /^[a-z0-9_]{1,64}$/iu.test(value);
const lower = value => value.toLowerCase();
const isWord = (token, text) => token?.kind === 'word' && token.upper === text;
const isSymbol = (token, text) => token?.kind === 'symbol' && token.value === text;
const identifier = token => ['word','identifier'].includes(token?.kind) && name(token.value);
const compareOps = new Set(['=', '<=>', '<>', '!=', '<', '>', '<=', '>=']);
const leftWords = new Set(['SELECT','DISTINCT','WHERE','ON','HAVING','AND','OR','WHEN','THEN','ELSE']);
const rightWords = new Set(['AS','FROM','WHERE','HAVING','AND','OR','GROUP','ORDER','LIMIT','THEN','ELSE','END']);

function compileRegistry(dialect, rows, applicability = []) {
  if (!['mysql','mariadb'].includes(dialect) || !Array.isArray(rows) || !rows.length || rows.length > maxRows ||
      !Array.isArray(applicability) || applicability.length > maxRows) throw Error('The collation catalog could not be observed within its limit.');
  const collations = new Map(), charsets = new Set();
  function entry(label, charset, id) {
    if (!name(label) || charset != null && (!name(charset) || !Number.isSafeInteger(Number(id)) || Number(id) < 1))
      throw Error('The collation catalog has unsupported metadata.');
    label = lower(label);
    if (!collations.has(label)) collations.set(label, new Map());
    if (charset == null) return;
    charset = lower(charset);
    charsets.add(charset);
    const ids = collations.get(label);
    const previous = ids.get(charset);
    if (previous !== undefined && previous !== Number(id)) throw Error('A collation has conflicting identities for the same character set.');
    ids.set(charset, Number(id));
  }
  for (const [label, charset, id] of rows) entry(label, charset, id);
  for (const [label, charset, fullName, id] of applicability) {
    entry(label, charset, id);
    entry(fullName, charset, id);
  }
  return { dialect, collations, charsets };
}

async function observeCollationRegistry(read, dialect) {
  const rows = await read('SELECT COLLATION_NAME,CHARACTER_SET_NAME,ID FROM information_schema.COLLATIONS LIMIT ' + (maxRows + 1));
  const applicability = dialect === 'mariadb'
    ? await read('SELECT COLLATION_NAME,CHARACTER_SET_NAME,FULL_COLLATION_NAME,ID FROM information_schema.COLLATION_CHARACTER_SET_APPLICABILITY LIMIT ' + (maxRows + 1))
    : [];
  return compileRegistry(dialect, rows, applicability);
}

function castCharset(tokens, closing) {
  const open = tokens[closing]?.open, first = open - 1;
  if (!Number.isInteger(open) || !isWord(tokens[first], 'CAST') ||
      isSymbol(tokens[first - 1], '.')) return undefined;
  for (let at = open + 1; at < closing; at++) {
    if (Number.isInteger(tokens[at].close)) { at = tokens[at].close; continue; }
    if (!isWord(tokens[at], 'AS') || !isWord(tokens[at + 1], 'CHAR')) continue;
    let index = at + 2;
    if (isSymbol(tokens[index], '(') && tokens[index].close === index + 2 && tokens[index + 1]?.kind === 'number') index += 3;
    if (!isWord(tokens[index], 'CHARACTER') || !isWord(tokens[index + 1], 'SET') || !identifier(tokens[index + 2]) ||
        index + 3 !== closing) return undefined;
    return { charset: lower(tokens[index + 2].value), start: first };
  }
  return undefined;
}

function operand(tokens, before, columns, references, registry) {
  const token = tokens[before], prefix = tokens[before - 1];
  if (isSymbol(token, ')')) return castCharset(tokens, before);
  if (token?.kind === 'string' && prefix?.kind === 'word' && prefix.value.startsWith('_')) {
    const charset = lower(prefix.value.slice(1));
    return registry.charsets.has(charset) ? { charset, start: before - 1 } : undefined;
  }
  if (!identifier(token)) return undefined;
  const bound = references.get(token.start);
  if (!bound || bound.end !== token.end || bound.origins.size !== 1) return undefined;
  const base = columns.get(bound.origins.values().next().value);
  if (!base?.charset) return undefined;
  let start = before;
  while (isSymbol(tokens[start - 1], '.') && identifier(tokens[start - 2])) start -= 2;
  return { charset: base.charset, start };
}

function catalogColumns(catalog) {
  const columns = new Map();
  for (const relation of [...catalog.tables, ...catalog.views]) {
    for (const column of relation.columns || []) {
      if (!name(column.charset)) continue;
      const identity = JSON.stringify([catalog.database, relation.name, column.name]);
      columns.set(identity, columns.has(identity) ? null : { charset: lower(column.charset) });
    }
  }
  return columns;
}

function provenReferences(model) {
  const bindings = new Map(), blocked = new Set();
  const partial = new Set(model.scopes.filter(scope => scope.partial).map(scope => scope.id));
  for (const ref of model.references) {
    if (ref.kind !== 'column' || ref.implicit) continue;
    const origin = ref.joinOrigin;
    if (!origin || partial.has(ref.scopeId)) { blocked.add(ref.start);continue; }
    const bound = bindings.get(ref.start) || { end: ref.end, origins: new Set() };
    bound.origins.add(JSON.stringify([origin.database, origin.table, origin.column]));
    bindings.set(ref.start, bound);
  }
  for (const position of blocked) bindings.delete(position);
  return bindings;
}

function priorBoundary(token) {
  return !token || token.kind === 'word' && leftWords.has(token.upper) || isSymbol(token, '(') || isSymbol(token, ',');
}
function nextBoundary(token) {
  return !token || token.kind === 'word' && rightWords.has(token.upper) || [')', ',', ';'].some(value => isSymbol(token, value));
}

function queryIssues(sql, tokens, catalog, registry, columns, options) {
  const issues = [], postfix = [];
  if (!isWord(tokens[0], 'SELECT') && !isWord(tokens[0], 'WITH')) return issues;
  if (!tokens.some(token => isWord(token, 'COLLATE'))) return issues;
  const model = analyzeSql(sql, catalog, { ...options, joinOrigins: true });
  const references = provenReferences(model);
  for (let index = 1; index + 1 < tokens.length && issues.length < maxDiagnostics; index++) {
    if (!isWord(tokens[index], 'COLLATE') || !identifier(tokens[index + 1])) continue;
    const target = tokens[index + 1], label = lower(target.value), allowed = registry.collations.get(label);
    if (!allowed) {
      // Legacy utf8 collation aliases are accepted by some modes and omitted from the dictionary.
      if (!label.startsWith('utf8_')) issues.push({ code: 'sql.collation.unknown', start: target.start, end: target.end,
        message: 'Collation ' + target.value + ' is absent from the observed server catalog.' });
      continue;
    }
    const value = operand(tokens, index - 1, columns, references, registry);
    if (!value || !registry.charsets.has(value.charset) || !allowed.size) continue;
    if (!allowed.has(value.charset)) {
      issues.push({ code: 'sql.collation.charset', start: target.start, end: target.end,
        message: 'Collation ' + target.value + ' cannot be applied to observed character set ' + value.charset + '.' });
      continue;
    }
    postfix.push({ ...value, end: index + 1, label, id: allowed.get(value.charset) });
  }
  const leftByEnd = new Map(postfix.map(entry => [entry.end, entry]));
  for (const right of postfix) {
    if (issues.length >= maxDiagnostics) break;
    const op = tokens[right.start - 1], left = leftByEnd.get(right.start - 2);
    if (!left || left.charset !== right.charset || left.id === right.id || op?.kind !== 'symbol' || !compareOps.has(op.value) ||
        !priorBoundary(tokens[left.start - 1]) || !nextBoundary(tokens[right.end + 1])) continue;
    // MariaDB's MySQL-compatible UCA names can share weights with native catalog IDs.
    if (registry.dialect === 'mariadb' && [left.label, right.label].some(label => label.includes('_0900_'))) continue;
    issues.push({ code: 'sql.collation.explicitConflict', start: op.start, end: op.end,
      message: 'This comparison selects two different explicit collations for ' + right.charset + '.' });
  }
  return issues;
}

function inspectCollations(text, catalog, registry) {
  if (!catalog || catalog.cachedMetadata || !catalog.semanticContextObserved || registry?.dialect !== catalog.dialect ||
      !Array.isArray(catalog.sqlMode) || !Array.isArray(catalog.tables) || !Array.isArray(catalog.views) ||
      catalog.coverage?.tables !== 'loaded' || catalog.coverage?.columns !== 'loaded') return [];
  const options = { database: catalog.database, dialect: catalog.dialect, sqlMode: catalog.sqlMode,
    tableNameCaseSensitive: catalog.tableNameCaseSensitive };
  const layout = statementRanges(text, options);
  if (layout.unknown.length || layout.statements.length > maxStatements) return [];
  const columns = catalogColumns(catalog), issues = [];
  for (const part of layout.statements) {
    const sql = text.slice(part.start, part.end), tokens = sourceTokens(sql, options);
    if (tokens.length && !['SELECT','WITH'].includes(tokens[0].upper)) break;
    // A WITH-prefixed statement may still change data. Keep this editor check on query blocks.
    if (tokens.some(token => token.kind === 'word' && ['INSERT','UPDATE','DELETE','REPLACE','INTO','RECURSIVE'].includes(token.upper))) break;
    for (const found of queryIssues(sql, tokens, catalog, registry, columns, options)) {
      issues.push({ ...found, start: part.start + found.start, end: part.start + found.end });
    }
    if (issues.length >= maxDiagnostics) break;
  }
  return issues.slice(0, maxDiagnostics);
}

module.exports = { compileRegistry, observeCollationRegistry, inspectCollations };
