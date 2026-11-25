'use strict';

const { validName } = require('./join-catalog');

const statements = new Set(['INSERT', 'REPLACE', 'DELETE', 'UPDATE']);
const modifiers = {
  INSERT: new Set(['LOW_PRIORITY', 'HIGH_PRIORITY', 'DELAYED', 'IGNORE']),
  REPLACE: new Set(['LOW_PRIORITY', 'DELAYED']),
  DELETE: new Set(['LOW_PRIORITY', 'QUICK', 'IGNORE']),
  UPDATE: new Set(['LOW_PRIORITY', 'IGNORE'])
};
const clauseWords = new Set(['SELECT', 'WITH', 'WHERE', 'ORDER', 'LIMIT', 'USING', 'FROM', 'INTO', 'SET', 'VALUE', 'VALUES', 'AS',
  'PARTITION', 'JOIN', 'INNER', 'OUTER', 'LEFT', 'RIGHT', 'STRAIGHT_JOIN', 'CROSS', 'NATURAL', 'ON', 'GROUP', 'HAVING', 'FOR',
  'UNION', 'INTERSECT', 'EXCEPT', 'RETURNING', 'BY', 'WINDOW', 'OFFSET', 'WHEN', 'THEN', 'ELSE', 'AND', 'OR']);
const outputExclusions = new Set(['WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'SELECT', 'FROM', 'INTO', 'JOIN', 'ON',
  'USING', 'UNION', 'INTERSECT', 'EXCEPT', 'WINDOW', 'FOR', 'RETURNING', 'AND', 'OR']);
const operandLeads = new Set(['IS','NOT','IN','EXISTS','BETWEEN','LIKE','RLIKE','REGEXP','DIV','MOD',
  'XOR','COLLATE','ESCAPE','CASE','INTERVAL','BINARY','DISTINCT']);
const aggregates = new Set(['AVG', 'COUNT', 'SUM', 'MIN', 'MAX', 'GROUP_CONCAT', 'JSON_ARRAYAGG', 'JSON_OBJECTAGG', 'BIT_AND',
  'BIT_OR', 'BIT_XOR', 'STD', 'STDDEV', 'STDDEV_POP', 'STDDEV_SAMP', 'VARIANCE', 'VAR_POP', 'VAR_SAMP']);
const word = (token, value) => token?.kind === 'word' && token.upper === value;
const symbol = (token, value) => token?.kind === 'symbol' && token.value === value;
const name = token => Boolean(token && validName(token.value) &&
  (token.kind === 'identifier' || token.kind === 'word' && !clauseWords.has(token.upper) && !statements.has(token.upper)));
const validTail = token => token && (token.kind === 'symbol' ? [')', '*'].includes(token.value) :
  token.kind !== 'word' || !clauseWords.has(token.upper) && !operandLeads.has(token.upper));
const position = value => ({ start: value.start, end: value.end });
const quote = value => String.fromCharCode(96) + value.replaceAll(String.fromCharCode(96), String.fromCharCode(96).repeat(2)) + String.fromCharCode(96);

function topLevel(tokens, start, end, predicate) {
  const indexes = [];
  for (let at = start; at < end; at++) {
    const token = tokens[at];
    if (symbol(token, '(') && token.close < end) at = token.close;
    else if (predicate(token)) indexes.push(at);
  }
  return indexes;
}

function segments(start, end, separators) {
  const cuts = [start - 1, ...separators, end];
  return cuts.slice(1).map((next, index) => [cuts[index] + 1, next]);
}

function assignments(tokens, start, end) {
  const parts = segments(start, end, topLevel(tokens, start, end, token => symbol(token, ',')));
  return parts.length <= 128 && parts.every(([begin, last]) => {
    let value = begin + 1;
    if (symbol(tokens[value], '.') && name(tokens[value + 1])) value += 2;
    return name(tokens[begin]) && symbol(tokens[value], '=') && value + 1 < last && validTail(tokens[last - 1]);
  });
}

function insertBody(tokens, start, end, command) {
  if (symbol(tokens[start], '(')) {
    const close = tokens[start].close;
    if (!Number.isInteger(close) || close >= end) return;
    const columns = segments(start + 1, close, topLevel(tokens, start + 1, close, token => symbol(token, ',')));
    if (columns.length > 128 || !columns.every(([a,b]) => b === a + 1 && name(tokens[a]))) return;
    start = close + 1;
  }
  if (word(tokens[start], 'SELECT') || word(tokens[start], 'WITH')) {
    if (start + 1 < end && validTail(tokens[end - 1])) return 'query';
    return;
  }
  if (word(tokens[start], 'SET')) return assignments(tokens, start + 1, end) ? 'set' : undefined;
  if (!word(tokens[start], 'VALUES') && !word(tokens[start], 'VALUE')) return;

  let at = start + 1;
  for (let row = 0; row < 128 && at < end; row++) {
    if (!symbol(tokens[at], '(') || !Number.isInteger(tokens[at].close) || tokens[at].close >= end) return;
    at = tokens[at].close + 1;
    if (at === end) return 'values';
    if (word(tokens[at], 'ON') && word(tokens[at + 1], 'DUPLICATE') && word(tokens[at + 2], 'KEY') &&
        word(tokens[at + 3], 'UPDATE') && command === 'INSERT') {
      return assignments(tokens, at + 4, end) ? 'upsert' : undefined;
    }
    if (!symbol(tokens[at++], ',')) return;
  }
}

function mutationPrefix(tokens, end, command) {
  let at = 1;
  while (tokens[at]?.kind === 'word' && modifiers[command].has(tokens[at].upper)) at++;
  if (command === 'DELETE' && !word(tokens[at], 'FROM')) return;
  if (word(tokens[at], 'FROM') && command === 'DELETE' || word(tokens[at], 'INTO') && ['INSERT','REPLACE'].includes(command)) at++;
  const first = tokens[at++];
  if (!name(first) || at > end) return;
  const qualified = symbol(tokens[at], '.') && name(tokens[at + 1]);
  const table = qualified ? tokens[at + 1] : first;
  if (qualified) at += 2;
  const schema = qualified ? first : undefined;
  let alias, hasAs = false;
  if (['UPDATE','DELETE'].includes(command) && at < end) {
    hasAs = word(tokens[at], 'AS');
    if (hasAs) at++;
    if (name(tokens[at])) alias = tokens[at++];
    else if (hasAs) return;
  }
  const target = { table, schema, alias };
  if (['INSERT','REPLACE'].includes(command)) {
    const bodyKind = insertBody(tokens, at, end, command);
    return bodyKind && { ...target, bodyKind };
  }
  const points = topLevel(tokens, at, end, token => ['WHERE','ORDER','LIMIT'].some(key => word(token, key)));
  const boundaries = [...points, end];
  if (command === 'DELETE' ? boundaries[0] !== at :
      !word(tokens[at], 'SET') || !assignments(tokens, at + 1, boundaries[0])) return;
  let rank = -1;
  for (let index = 0; index < points.length; index++) {
    const start = points[index], stop = boundaries[index + 1], key = tokens[start].upper;
    const nextRank = ['WHERE','ORDER','LIMIT'].indexOf(key);
    const operand = start + (key === 'ORDER' && word(tokens[start + 1], 'BY') ? 2 : 1);
    if (nextRank <= rank || operand >= stop || !validTail(tokens[stop - 1]) ||
        key === 'ORDER' && !word(tokens[start + 1], 'BY')) return;
    rank = nextRank;
  }
  const joins = topLevel(tokens, at, end, token => word(token, 'JOIN') || word(token, 'USING'));
  if (!joins.length) return { ...target, bodyKind:'single' };
}

function returningShape(tokens, options, isJoined) {
  const command = tokens[0]?.upper;
  if (tokens[0]?.kind !== 'word' || !statements.has(command)) return;
  const end = tokens.length - Number(symbol(tokens.at(-1), ';'));
  if (tokens.slice(0, end).some(token => symbol(token, ';'))) return;
  for (const point of topLevel(tokens, 1, end, token => word(token, 'RETURNING'))) {
    const after = tokens[point + 1];
    if (after && point + 1 < end && (after.kind === 'word' && outputExclusions.has(after.upper) || symbol(after, ',') ||
        symbol(after, '=') || symbol(after, '.'))) continue;
    const target = mutationPrefix(tokens, point, command);
    const multi = !target && isJoined && ['DELETE','UPDATE'].includes(command) && isJoined(tokens.slice(0, point));
    if (!target && !multi) continue;
    // A trailing unquoted identifier can be a SELECT alias in Oracle MySQL.
    if (options.dialect !== 'mariadb' && target?.bodyKind === 'query' && point + 1 === end) continue;
    return { command, token:tokens[point], target, multi:Boolean(multi), projectionStart:point + 1, end };
  }
}

function observedVersion(options) {
  if (!['mysql','mariadb'].includes(options.dialect) || typeof options.serverVersion !== 'string') return;
  const maria = options.dialect === 'mariadb';
  if (maria !== /mariadb/i.test(options.serverVersion)) return;
  const release = /^(?:5\.5\.5-)?(\d+)\.(\d+)\.(\d+)/.exec(options.serverVersion);
  if (!release) return;
  const version = release.slice(1).map(Number);
  // Keep unknown future Oracle release families as uncertain.
  if (!maria && !(version[0] >= 5 && version[0] <= 9 || version[0] === 26 && version[1] <= 10)) return;
  return version;
}

function supportedVersion(version, minimum) {
  for (let index = 0; index < minimum.length; index++) {
    if (version[index] !== minimum[index]) return version[index] > minimum[index];
  }
  return true;
}

function capability(shape, options) {
  const version = observedVersion(options);
  if (!version) return { code:'sql.returning.serverUnknown', message:'A matching observed database release is required to resolve this RETURNING clause.', severity:'information' };
  if (options.dialect === 'mysql') return { code:'sql.returning.dialect', message:'Oracle MySQL does not support DML RETURNING on this release.' };
  const { command, target, multi } = shape;
  const minimum = command === 'DELETE' ? [10,0,5] : command === 'UPDATE' ? [13,0,0] : [10,5,0];
  if (!supportedVersion(version, minimum)) {
    return { code:'sql.returning.version', message:command + ' RETURNING requires MariaDB ' + minimum.join('.') + ' or later.' };
  }
  if (multi) return { code:'sql.returning.singleTable', message:'MariaDB RETURNING applies to a single target table in this statement.' };
  if (command === 'DELETE' && target.alias && !supportedVersion(version, [11,6,0])) {
    return { code:'sql.returning.deleteAlias', message:'Single-table DELETE aliases require MariaDB 11.6 or later.' };
  }
  if (command === 'UPDATE') {
    return { code:'sql.returning.updateCoverage', message:'This release supports UPDATE RETURNING. Static OLD and NEW row binding is outside the verified editor scope.', severity:'information' };
  }
}

function relationFor(target, catalog, options) {
  const database = options.database || catalog?.database;
  const requested = { schema: target.schema?.value || database, table:target.table.value };
  if (!validName(requested.schema)) return {};
  const equal = (left, right) => typeof left === 'string' &&
    (options.tableNameCaseSensitive === false ? left.toLowerCase() === right.toLowerCase() : left === right);
  const local = equal(database, requested.schema);
  const localTables = Array.isArray(catalog) ? catalog : [...(catalog?.tables || []), ...(catalog?.views || [])];
  const observed = (local ? localTables : (options.joinTables || []).filter(table => equal(table.schema, requested.schema)))
    .filter(table => equal(table.name, requested.table));
  const complete = local ? options.catalogComplete === true || catalog?.coverage?.tables === 'loaded' && catalog?.coverage?.columns === 'loaded' :
    Boolean((options.joinTables || []).length);
  if (observed.length !== 1 || !complete || !Array.isArray(observed[0].columns)) return { requested, pending:!local && !observed.length };
  return { requested, observed:observed[0], schema:local ? database : observed[0].schema };
}

function aggregateInProjection(tokens, first, end) {
  for (let index = first; index < end; index++) {
    const token = tokens[index];
    if (symbol(token, '(') && (word(tokens[index + 1], 'SELECT') || word(tokens[index + 1], 'WITH'))) {
      index = token.close;
    } else if (token.kind === 'word' && aggregates.has(token.upper) && symbol(tokens[index + 1], '(') && !symbol(tokens[index - 1], '.')) {
      return token;
    }
  }
}

function analyzeReturning(text, catalog, options, tokens, { analyzeSql, sourceRange, isJoined }) {
  const shape = returningShape(tokens, options, isJoined);
  if (!shape) return;
  const { command, target, token, projectionStart, end } = shape;
  const returning = { command, ...position(token), rowImage:command === 'DELETE' ? 'deleted' : 'written' };
  const result = { returning, state:'unknown', diagnostics:[], references:[], projections:[],
    coverage:{ supported:[], unknown:[] }, executedSql:false };
  const error = (code, message, location = token, severity = 'error') => {
    const range = position(location);
    result.diagnostics.push({ code, message, severity, ...range, range:sourceRange(text, range.start, range.end) });
    if (severity === 'error') result.state = 'invalid';
    else result.coverage.unknown.push({ reason:message, start:range.start });
    return result;
  };
  const limited = capability(shape, options);
  if (limited) return error(limited.code, limited.message, token, limited.severity);

  const relation = relationFor(target, catalog, options);
  if (!relation.observed) {
    if (relation.pending) result.pending = [relation.requested];
    result.possibleTokens = tokens.filter(name).map(position);
    return error('sql.returning.catalog', 'Complete observed metadata for the mutation target is required to resolve RETURNING.', token, 'information');
  }

  const tableName = relation.observed.name;
  const origin = { database:relation.schema, table:tableName };
  result.target = origin;
  const targetRef = { ...position(target.table), kind:'table', name:target.table.value, catalog:origin, usage:'write', command };
  const aliasRef = target.alias && { ...position(target.alias), kind:'relation-definition', name:target.alias.value,
    definition:position(target.alias), command };
  result.references.push({ ...targetRef, range:sourceRange(text,targetRef.start,targetRef.end) });
  if (aliasRef) result.references.push({ ...aliasRef, range:sourceRange(text,aliasRef.start,aliasRef.end) });
  const start = token.end, last = end === tokens.length ? text.length : tokens[end].start;
  const syntheticPrefix = 'SELECT ';
  const select = syntheticPrefix + text.slice(start, last) + '\nFROM ' + quote(relation.schema) + '.' + quote(tableName) +
    (target.alias ? ' AS ' + quote(target.alias.value) : '');
  const projection = analyzeSql(select, catalog, { ...options, sourceNavigation:true, joinOrigins:true });
  const delta = start - syntheticPrefix.length, limit = syntheticPrefix.length + last - start;
  const map = span => span && syntheticPrefix.length <= span.start && span.end <= limit &&
    { start:span.start + delta, end:span.end + delta };
  const remap = value => {
    const range = map(value);
    return range && { ...value, ...range, range:sourceRange(text, range.start, range.end) };
  };
  result.completion = { start, end:last, projection, delta, tokens:tokens.slice(projectionStart,end) };
  if (projectionStart === end) return error('sql.returning.projection', 'Complete the list of RETURNING expressions.', token, 'information');
  const aggregate = aggregateInProjection(tokens, projectionStart, end);
  if (aggregate) return error('sql.returning.aggregate', 'Aggregate functions cannot be used in the outer RETURNING projection.', aggregate);

  for (const ref of projection.references) {
    const exactRef = remap(ref);
    if (!exactRef) continue;
    const definition = map(ref.definition) || (ref.kind === 'relation' && aliasRef && ref.name.toLowerCase() === aliasRef.name.toLowerCase()
      ? aliasRef.definition : undefined);
    result.references.push({ ...exactRef, definition, usage:'read', command, returning:true });
  }
  result.diagnostics = projection.diagnostics.map(remap).filter(Boolean);
  result.projections = projection.projections.map(item => {
    const exactProjection = remap(item);
    const inputs = item.physicalColumn ? [item.physicalColumn] : result.references.filter(ref => exactProjection &&
      exactProjection.start <= ref.start && ref.end <= exactProjection.end).map(ref => ref.physicalColumn).filter(Boolean);
    return { ...item, ...(exactProjection || {}), definition:map(item.definition) || undefined,
      inputs:[...new Map(inputs.map(input => [JSON.stringify(input), input])).values()] };
  });
  result.state = projection.state;
  result.coverage = { supported:['dml-returning', ...projection.coverage.supported], unknown:projection.coverage.unknown.map(item =>
    ({ reason:item.reason, ...(Number.isInteger(item.start) && map({ start:item.start,end:item.start }) && { start:item.start + delta }) })) };
  result.references = result.references.map(ref => ({ ...ref, range:sourceRange(text, ref.start, ref.end) }));
  return result;
}

function completionsForReturning(model, offset, complete) {
  const context = model._returningCompletion;
  if (offset < context.start || offset > context.end || model.diagnostics.some(diagnostic => diagnostic.code === 'sql.returning.aggregate')) return [];
  const editing = context.tokens.find(token => token.start < offset && offset <= token.end && name(token));
  const start = editing?.start ?? offset;
  const preceding = context.tokens.filter(token => token.end <= start);
  const prior = preceding.at(-1);
  if (symbol(prior,'*') && (preceding.length === 1 || ['.',','].some(value=>symbol(preceding.at(-2),value)))) return [];
  if (prior && !['SELECT','WHERE','AND','OR','WHEN','THEN','ELSE'].some(key => word(prior,key)) &&
      !(prior.kind === 'symbol' && ['.','(',',','+','-','*','/','%','=','<','>','<=','>='].includes(prior.value))) return [];
  return complete(context.projection, offset - context.delta).filter(item => item.kind === 'column').map(item => ({
    ...item, start:Number.isInteger(item.start) ? item.start+context.delta : start,
    end:Number.isInteger(item.end) ? item.end+context.delta : editing?.end ?? offset,
    detail:'RETURNING · ' + item.detail
  }));
}

module.exports = { analyzeReturning, completionsForReturning };
