'use strict';

const {identifier} = require('./schema-rename');
const {tokenize} = require('./sql-policy');
const {parseView} = require('./schema-dependency-graph');

const algorithms = new Set(['UNDEFINED', 'MERGE', 'TEMPTABLE']);
const securityModes = new Set(['DEFINER', 'INVOKER']);
const bodyKeywords = new Set('SELECT FROM JOIN INNER LEFT RIGHT CROSS OUTER ON AS WHERE AND OR NOT IS NULL TRUE FALSE IN BETWEEN LIKE GROUP BY HAVING ORDER LIMIT DISTINCT'.split(' '));
const unsupportedBodyWords = new Set('WITH UNION INTERSECT EXCEPT INTO OUTFILE DUMPFILE FOR LOCK PROCEDURE LOAD_FILE SLEEP BENCHMARK GET_LOCK RELEASE_LOCK RELEASE_ALL_LOCKS'.split(' '));
const fail = message => Object.assign(new Error(message), {code: 'ROCKETBRAIN_REBUILD_VIEW'});
const word = (token, upper) => token?.kind === 'word' && token.upper === upper;
const symbol = (token, value) => token?.kind === 'symbol' && token.value === value;
const named = token => token?.kind === 'word' || token?.kind === 'identifier';
const sameOrder = (left, right) => left.length === right.length && left.every((value, index) => value === right[index]);

function exactTokens(sql, sqlMode) {
  if (typeof sqlMode !== 'string') throw fail('The view SQL mode is unavailable.');
  let tokens;
  try {
    tokens = tokenize(sql, false, {sqlMode: sqlMode.split(',').filter(Boolean), allowOptimizerHints: false});
  } catch {
    throw fail('Use one bounded view definition without comments, statement separators or ambiguous quotes.');
  }
  if (tokens.length > 20000) throw fail('The reviewed view definition exceeds the SQL token limit.');
  let end = 0;
  for (const token of tokens) {
    if (!/^[\t\n\r ]*$/u.test(sql.slice(end, token.start))) {
      throw fail('Comments and statement separators are outside selected view rebuilds.');
    }
    end = token.end;
  }
  if (!/^[\t\n\r ]*$/u.test(sql.slice(end))) {
    throw fail('Comments and statement separators are outside selected view rebuilds.');
  }
  return tokens;
}

function bodyTokens(tokens) {
  // Some SHOW CREATE VIEW versions wrap the entire SELECT in parentheses.
  if (symbol(tokens[0], '(')) {
    let depth = 0;
    const close = tokens.findIndex(token => {
      if (symbol(token, '(')) depth++;
      return symbol(token, ')') && --depth === 0;
    });
    if (close !== tokens.length - 1) {
      throw fail('Only a complete outer SELECT wrapper is supported for the reviewed view.');
    }
    tokens = tokens.slice(1, -1);
  }
  if (!word(tokens[0], 'SELECT')) throw fail('Selected view rebuilds require a single SELECT body.');
  let depth = 0;
  for (const [index, token] of tokens.entries()) {
    if (symbol(token, '(')) depth++;
    if (symbol(token, ')') && --depth < 0) throw fail('The view SELECT parentheses are unbalanced.');
    if (token.kind === 'variable' ||
        token.kind === 'symbol' && !/^[0-9().,=<>!+*/%\-]$/u.test(token.value) ||
        token.kind === 'word' && unsupportedBodyWords.has(token.upper) ||
        named(token) && symbol(tokens[index - 1], '.') && symbol(tokens[index + 1], '(')) {
      throw fail('Unsupported SQL in the selected view SELECT.');
    }
  }
  if (depth) throw fail('The view SELECT parentheses are unbalanced.');
  return tokens;
}

function joinsPrevious(previous, token) {
  if (!previous || previous.end !== token.start) return false;
  const digit = candidate => candidate.kind === 'symbol' && /^\d$/u.test(candidate.value);
  const operator = candidate => candidate.kind === 'symbol' && /^[=<>!+*/%\-]$/u.test(candidate.value);
  return operator(previous) && operator(token) ||
    digit(previous) && (digit(token) || symbol(token, '.') || named(token)) ||
    digit(token) && symbol(previous, '.') ||
    named(previous) && token.kind === 'string' ||
    previous.kind === 'word' && !bodyKeywords.has(previous.upper) && symbol(token, '(');
}

function viewBodyKey(definition, sqlMode = '') {
  const tokens = bodyTokens(exactTokens(definition, sqlMode));
  return JSON.stringify(tokens.map((token, index) => {
    const previous = tokens[index - 1];
    if (token.kind === 'word' && bodyKeywords.has(token.upper) && !symbol(previous, '.')) {
      return ['keyword', token.upper];
    }
    const value = token.kind === 'string' ? definition.slice(token.start, token.end) : token.value;
    return [named(token) ? 'identifier' : token.kind, value, joinsPrevious(previous, token)];
  }));
}

function exposedColumns(object) {
  if (!Array.isArray(object.columns) || !object.columns.length || object.columns.length > 500 ||
      object.columns.some((column, index) => column?.ordinal !== index + 1)) {
    throw fail('Complete ordered view column metadata is required.');
  }
  const names = object.columns.map(column => identifier(column.name));
  if (new Set(names.map(name => name.toLowerCase())).size !== names.length) {
    throw fail('View column names must be unambiguous.');
  }
  return names;
}

function projectionNames(tokens) {
  const names = [];
  let depth = 0;
  let start = 1;
  for (let index = 1; index < tokens.length; index++) {
    const token = tokens[index];
    if (symbol(token, '(')) depth++;
    if (symbol(token, ')')) depth--;
    const from = word(token, 'FROM');
    if (depth || (!from && !symbol(token, ','))) continue;
    const item = tokens.slice(start, index);
    if (item.length > 2 && word(item.at(-2), 'AS') && named(item.at(-1))) {
      names.push(identifier(item.at(-1).value));
    } else if (item.length > 0 && item.length <= 5 && item.length % 2 === 1 &&
        item.every((part, offset) => offset % 2 ? symbol(part, '.') : named(part))) {
      names.push(identifier(item.at(-1).value));
    } else {
      throw fail('Each selected view output needs an exact column name or explicit AS label.');
    }
    if (from) return names;
    start = index + 1;
  }
  throw fail('Selected view rebuilds require a statically named SELECT relation.');
}

function parseSnapshotView(snapshot, object) {
  if (object?.kind !== 'view' || !snapshot?.server || snapshot.server.database !== snapshot.database) {
    throw fail('Use a captured view in the exact snapshot schema.');
  }
  const schema = identifier(snapshot.database, {table: true});
  const name = identifier(object.name, {table: true});
  const sqlMode = snapshot.server.sqlMode;
  const sql = object.createSql;
  const tokens = exactTokens(sql, sqlMode);
  const exposed = exposedColumns(object);
  let at = 0;
  const expectWord = keyword => {
    if (!word(tokens[at++], keyword)) throw fail('The captured view does not use the supported SHOW CREATE header.');
  };
  const expectSymbol = punctuation => {
    if (!symbol(tokens[at++], punctuation)) throw fail('The captured view does not use the supported SHOW CREATE header.');
  };
  const readName = () => {
    const token = tokens[at++];
    if (!named(token)) throw fail('The captured view name or account is unavailable.');
    return token.value;
  };
  expectWord('CREATE');
  expectWord('ALGORITHM');
  expectSymbol('=');
  const algorithm = tokens[at++]?.upper;
  if (!algorithms.has(algorithm) || !word(tokens[at - 1], algorithm)) throw fail('Unsupported view algorithm.');
  expectWord('DEFINER');
  expectSymbol('=');
  const user = readName();
  const separator = tokens[at++];
  if (separator?.kind !== 'variable' || separator.system) throw fail('The captured view needs an exact account definer.');
  const host = separator.value === '@' ? readName() : separator.value.slice(1);
  if (!host || /[@\u0000-\u001f\u007f]/u.test(host) || /[\u0000-\u001f\u007f]/u.test(user)) {
    throw fail('The captured view needs an exact account definer.');
  }
  const definer = user + '@' + host;
  expectWord('SQL');
  expectWord('SECURITY');
  const security = tokens[at++]?.upper;
  if (!securityModes.has(security) || !word(tokens[at - 1], security)) throw fail('Unsupported view SQL security.');
  expectWord('VIEW');
  const target = readName();
  if (symbol(tokens[at], '.')) {
    at++;
    if (target !== schema || readName() !== name) throw fail('The view definition names a different schema or object.');
  } else if (target !== name) {
    throw fail('The view definition names a different schema or object.');
  }
  if (symbol(tokens[at], '(')) {
    const namedColumns = [];
    do {
      at++;
      namedColumns.push(readName());
    } while (symbol(tokens[at], ','));
    expectSymbol(')');
    if (!sameOrder(namedColumns, exposed)) throw fail('The explicit view column list disagrees with the snapshot.');
  }
  expectWord('AS');
  let checkOption = 'NONE';
  let end = tokens.length;
  if (word(tokens.at(-1), 'OPTION') && word(tokens.at(-2), 'CHECK')) {
    const explicit = word(tokens.at(-3), 'LOCAL') || word(tokens.at(-3), 'CASCADED');
    const withOffset = explicit ? 4 : 3;
    if (!word(tokens.at(-withOffset), 'WITH')) throw fail('The view CHECK OPTION clause is invalid.');
    checkOption = explicit ? tokens.at(-3).upper : 'CASCADED';
    end -= withOffset;
  }
  const body = bodyTokens(tokens.slice(at, end));
  if (!sameOrder(projectionNames(body), exposed)) throw fail('The view SELECT outputs disagree with the snapshot column order.');
  const definition = sql.slice(body[0].start, body.at(-1).end);
  parseView(definition, schema, {sqlMode});
  return {schema, name, definition, algorithm, security, definer, checkOption, sqlMode};
}

function assertSelectedViewPair(current, proposed, before, after) {
  const original = parseSnapshotView(current, before);
  const target = parseSnapshotView(proposed, after);
  if (original.schema !== target.schema || original.name !== target.name ||
      current.server.dialect !== proposed.server.dialect || current.server.currentUser !== proposed.server.currentUser) {
    throw fail('Select the same view in snapshots of the active logical schema and account.');
  }
  if (original.definer !== current.server.currentUser ||
      ['algorithm', 'security', 'definer', 'checkOption', 'sqlMode'].some(key => original[key] !== target[key])) {
    throw fail('A selected view must retain its exact current-account definer, algorithm, security, SQL mode and CHECK OPTION.');
  }
  if (!sameOrder(exposedColumns(before), exposedColumns(after))) {
    throw fail('Select a view change that retains its exposed column names and order.');
  }
  return {before: original, after: target};
}

module.exports = {parseSnapshotView, assertSelectedViewPair, viewBodyKey};
