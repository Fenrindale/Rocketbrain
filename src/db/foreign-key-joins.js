'use strict';

const { analyzeSql, sourceLayout } = require('./sql-analysis');
const { endpointKey, validName, maxSources, maxParts } = require('./join-catalog');

const QUOTE = String.fromCharCode(96);
const quote = value => QUOTE + value.replaceAll(QUOTE, QUOTE + QUOTE) + QUOTE;
const modifiers = new Set(['INNER', 'LEFT', 'RIGHT', 'OUTER', 'CROSS', 'NATURAL']);
const joinTypes = new Set(['', 'INNER', 'LEFT', 'RIGHT', 'LEFT OUTER', 'RIGHT OUTER']);
const queryTail = new Set(['WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'WINDOW', 'FOR', 'LOCK', 'UNION', 'INTERSECT', 'EXCEPT']);
const queryHead = token => ['SELECT', 'WITH'].includes(token?.upper);
const matchesName = (left, right) => left.toLowerCase() === right.toLowerCase();
const catalogReady = catalog => validName(catalog?.database) &&
  ['tables', 'columns'].every(area => catalog.coverage?.[area] === 'loaded');

function statementAt(tokens, offset, textLength) {
  let start = 0, first = 0;
  for (const [index, token] of tokens.entries()) {
    if (token.value !== ';' || token.kind !== 'symbol') continue;
    if (token.start >= offset) return { start, end: token.start, first, last: index };
    if (index > first && !queryHead(tokens[first])) return null;
    start = token.end;
    first = index + 1;
  }
  return { start, end: textLength, first, last: tokens.length };
}

function selectForJoin(tokens, start, first) {
  let from = false;
  for (let index = start - 1; index >= first; index--) {
    const token = tokens[index];
    if (token.kind === 'symbol' && token.value === ')' && token.open !== undefined) {
      index = token.open;
      continue;
    }
    if (token.kind === 'symbol' && token.value === '(') return null;
    if (token.kind !== 'word') continue;
    if (token.upper === 'SELECT') return from ? token.start : null;
    if (queryTail.has(token.upper) || ['INTO', 'USING', 'PROCEDURE', 'QUALIFY'].includes(token.upper)) return null;
    if (token.upper === 'FROM') from = true;
  }
  return null;
}

function joinPosition(text, offset, options) {
  if (typeof text !== 'string' || !Number.isInteger(offset) || offset < 1 || offset > text.length) return null;
  let layout;
  try { layout = sourceLayout(text, options); }
  catch { return null; }
  const { tokens, nonCode } = layout;
  if (nonCode.some(span => offset >= span.start && offset < span.end)) return null;
  const statement = statementAt(tokens, offset, text.length);
  if (!statement || !queryHead(tokens[statement.first])) return null;
  let after = statement.first;
  while (after < statement.last && tokens[after].end <= offset) after++;
  const next = after < statement.last ? tokens[after] : null;
  if (next && (next.start < offset || next.value !== ')' && !queryTail.has(next.upper))) return null;
  let index = after - 1;
  const word = tokens[index];
  const prefix = word?.kind === 'word' && word.end === offset && word.upper !== 'JOIN' ? word : null;
  if (prefix) index--;
  let schema;
  if (tokens[index]?.value === '.') {
    const candidate = tokens[index - 1];
    if (!['word', 'identifier'].includes(candidate?.kind) || !validName(candidate.value)) return null;
    schema = candidate;
    index -= 2;
  }
  const join = tokens[index];
  if (join?.kind !== 'word' || join.upper !== 'JOIN') return null;
  const replacementStart = schema?.start ?? prefix?.start ?? offset;
  if (!/^\s+$/.test(text.slice(join.end, replacementStart)) ||
      nonCode.some(span => span.start < offset && replacementStart < span.end && replacementStart < offset)) return null;
  let start = index;
  while (start > statement.first && tokens[start - 1].kind === 'word' && modifiers.has(tokens[start - 1].upper)) start--;
  if (!joinTypes.has(tokens.slice(start, index).map(token => token.upper).join(' '))) return null;
  const select = selectForJoin(tokens, start, statement.first), begin = tokens[start].start;
  if (select == null) return null;
  const removed = text.slice(begin, offset).replace(/[^\r\n]/g, ' ');
  return { source: text.slice(statement.start, begin) + removed + text.slice(offset, statement.end),
    original: text.slice(statement.start, statement.end), statementStart: statement.start,
    selectStart: select - statement.start, prefix: prefix?.value || '', schema: schema?.value, replacementStart, offset };
}

function scopeModel(position, catalog, options, remote = []) {
  return analyzeSql(position.source, catalog, { ...options, catalogComplete: true, joinOrigins: true, joinTables: remote });
}

function isBound(model) {
  return model.state === 'known' && model.scopes.every(scope => scope.complete);
}

function sourceScope(position, model) {
  if (!isBound(model)) return null;
  const scope = model.scopes.find(entry => entry.start === position.selectStart);
  if (!scope?.relations.length || scope.relations.some(relation => !validName(relation.alias))) return null;
  const names = scope.relations.map(relation => relation.alias.toLowerCase());
  return new Set(names).size === names.length ? scope : null;
}

function uniqueEndpoints(endpoints) {
  return [...new Map(endpoints.map(endpoint => [endpointKey(endpoint), endpoint])).values()];
}

function localTables(catalog) {
  return catalog.tables.filter(table => table.kind === 'table' && validName(table.name)).map(table => ({ ...table, schema: catalog.database }));
}

function physicalEdges(catalog, tables) {
  if (catalog.coverage?.foreignKeys !== 'loaded') return [];
  return tables.flatMap(table => (table.foreignKeys || []).map(relation => ({
    kind: 'physical', name: relation.name,
    child: { schema: catalog.database, table: table.name },
    parent: { schema: relation.referencedSchema, table: relation.referencedTable },
    parts: relation.columns?.map(part => ({ column: part.name, parentColumn: part.referencedColumn, ordinal: part.ordinal }))
  })));
}

function logicalRelationships(catalog, configured) {
  return configured.map(relation => ({
    kind: 'logical', name: relation.name,
    child: { schema: catalog.database, table: relation.child },
    parent: { schema: catalog.database, table: relation.parent },
    parts: relation.pairs.map((pair, index) => ({ column: pair.child, parentColumn: pair.parent, ordinal: index + 1 }))
  }));
}

function exposedColumn(relation, endpoint, column) {
  const projected = relation.columns.filter(({ joinOrigin }) => joinOrigin?.database === endpoint.schema &&
    joinOrigin.table === endpoint.table && joinOrigin.column === column);
  if (projected.length !== 1 || !validName(projected[0].name)) return null;
  const name = projected[0].name;
  return relation.columns.filter(candidate => matchesName(candidate.name, name)).length === 1 ? name : null;
}

function candidates(position, catalog, model, scope, live, logical, options, remote = []) {
  const local = localTables(catalog);
  const tableMap = inventory => new Map(inventory.filter(table => table.kind === 'table').map(table =>
    [endpointKey({ schema: table.schema, table: table.name }), table]));
  const saved = tableMap(local), observed = live ? tableMap(live.tables) : saved;
  const edges = [...(live?.edges || physicalEdges(catalog, local)), ...logicalRelationships(catalog, logical)];
  const external = [...new Map([...remote, ...(live?.tables || [])].map(table =>
    [endpointKey({ schema: table.schema, table: table.name }), table])).values()];
  const aliases = new Set();
  for (let current = scope; current; current = model.scopes.find(entry => entry.id === current.parentId)) {
    for (const relation of current.relations) aliases.add(relation.alias.toLowerCase());
  }
  let nextAlias = 'rb_join';
  for (let suffix = 2; aliases.has(nextAlias); suffix++) nextAlias = 'rb_join_' + suffix;
  const results = new Map(), checked = new Set();
  function add(relation, edge, inbound) {
    const target = inbound ? edge.child : edge.parent, source = inbound ? edge.parent : edge.child;
    if (position.schema && position.schema !== target.schema && !(catalog.tableNameCaseSensitive === false && matchesName(position.schema, target.schema))) return;
    if (!target.table.toLowerCase().startsWith(position.prefix.toLowerCase()) || !validName(edge.name) ||
      !Array.isArray(edge.parts) || !edge.parts.length || edge.parts.length > maxParts) return;
    const tables = edge.kind === 'logical' ? saved : observed;
    const child = tables.get(endpointKey(edge.child)), parent = tables.get(endpointKey(edge.parent));
    if (!child || !parent) return;
    const needsAlias = aliases.has(target.table.toLowerCase()), targetRef = quote(needsAlias ? nextAlias : target.table);
    const sourceRef = quote(relation.alias), predicates = [], left = new Set(), right = new Set();
    for (const [index, part] of [...edge.parts].sort((a, b) => a.ordinal - b.ordinal).entries()) {
      const childColumn = child.columns.find(column => column.name === part.column);
      const parentColumn = parent.columns.find(column => column.name === part.parentColumn);
      if (part.ordinal !== index + 1 || !childColumn || !parentColumn || !validName(part.column) ||
        !validName(part.parentColumn) || left.has(part.column) || right.has(part.parentColumn)) return;
      if (edge.kind === 'logical' && (childColumn.type !== parentColumn.type ||
        childColumn.charset !== parentColumn.charset || childColumn.collation !== parentColumn.collation)) return;
      left.add(part.column);
      right.add(part.parentColumn);
      const exposed = exposedColumn(relation, source, inbound ? part.parentColumn : part.column);
      if (!exposed) return;
      const childRef = inbound ? targetRef + '.' + quote(part.column) : sourceRef + '.' + quote(exposed);
      const parentRef = inbound ? sourceRef + '.' + quote(exposed) : targetRef + '.' + quote(part.parentColumn);
      predicates.push(childRef + ' = ' + parentRef);
    }
    const insertText = quote(target.schema) + '.' + quote(target.table) +
      (needsAlias ? ' AS ' + targetRef : '') + ' ON ' + predicates.join(' AND ');
    if (checked.has(insertText) || checked.size >= 30) return;
    checked.add(insertText);
    const sourceWithJoin = position.original.slice(0, position.replacementStart - position.statementStart) + insertText +
      position.original.slice(position.offset - position.statementStart);
    if (!isBound(scopeModel({ source: sourceWithJoin }, catalog, options, external))) return;
    const name = target.schema === catalog.database ? target.table : target.schema + '.' + target.table;
    const detail = edge.kind === 'logical' ? 'configured workspace relationship' :
      catalog.cachedMetadata ? 'cached foreign key · current schema unverified' : 'verified foreign key';
    results.set(insertText, { label: name + ' via ' + edge.name + ' (' + relation.alias + ')',
      detail: edge.child.table + ' → ' + edge.parent.table + ' · ' + detail,
      insertText, start: position.replacementStart, end: position.offset });
  }
  for (const edge of edges) {
    for (const relation of scope.relations) {
      add(relation, edge, false);
      add(relation, edge, true);
    }
    if (checked.size >= 30) break;
  }
  return [...results.values()].slice(0, 30);
}

function foreignKeyJoins(text, offset, catalog, options = {}) {
  if (!catalogReady(catalog)) return [];
  const position = joinPosition(text, offset, options);
  if (!position) return [];
  const model = scopeModel(position, catalog, options), scope = sourceScope(position, model);
  return scope ? candidates(position, catalog, model, scope, null, options.logical || [], options) : [];
}

async function scopedForeignKeyJoins(text, offset, catalog, options = {}, observe, isCurrent = () => true) {
  if (!isCurrent() || !catalogReady(catalog)) return [];
  const position = joinPosition(text, offset, options);
  if (!position) return [];
  let model = scopeModel(position, catalog, options);
  let remote = [];
  const external = uniqueEndpoints(model.relations.filter(relation => relation.requested && !relation.catalog).map(relation => relation.requested));
  if (external.length && observe && !catalog.cachedMetadata && external.length <= maxSources) {
    try {
      const result = await observe({ endpoints: external, includeEdges: false });
      if (!isCurrent()) return [];
      remote = result.tables;
      model = scopeModel(position, catalog, options, remote);
    } catch { /* Local binding remains available when optional remote metadata cannot be read. */ }
  }
  if (!isCurrent()) return [];
  const scope = sourceScope(position, model);
  if (!scope) return [];
  const endpoints = uniqueEndpoints(scope.relations.flatMap(relation => relation.columns.flatMap(({ joinOrigin }) =>
    joinOrigin ? [{ schema: joinOrigin.database, table: joinOrigin.table }] : [])));
  let live;
  if (observe && !catalog.cachedMetadata && endpoints.length && endpoints.length <= maxSources) {
    try { live = await observe({ endpoints }); }
    catch { /* Preserve same-schema completion when live graph expansion is unavailable. */ }
  }
  if (!isCurrent()) return [];
  let logical = options.logical || [];
  if (!catalog.cachedMetadata && options.readLogical) {
    try { logical = options.readLogical(catalog); }
    catch { /* Invalid or outdated saved workspace relationships are omitted. */ }
  }
  return candidates(position, catalog, model, scope, live, logical, options, remote);
}

module.exports = { foreignKeyJoins, scopedForeignKeyJoins };
