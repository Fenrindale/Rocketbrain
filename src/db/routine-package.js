'use strict';

const { identifier } = require('./schema-rename');
const { loadSource, listNames } = require('./object-source');
const { sourceTokens } = require('./sql-analysis');
const { typeKind } = require('./parameter-inference');

const fail = (code, message) => Object.assign(Error(message), { code: 'ROCKETBRAIN_ROUTINE_PACKAGE_' + code });
const word = (token, value) => token?.kind === 'word' && token.upper === value;
const symbol = (token, value) => token?.kind === 'symbol' && token.value === value;
const isName = token => token?.kind === 'word' || token?.kind === 'identifier';
const scalar = /^(?:(?:TINYINT|SMALLINT|MEDIUMINT|INT|INTEGER|BIGINT)(?:\(\d{1,3}\))?(?: UNSIGNED)?|(?:DECIMAL|NUMERIC)\(\d{1,2},\d{1,2}\)(?: UNSIGNED)?|(?:FLOAT|DOUBLE|REAL)(?:\(\d{1,2}(?:,\d{1,2})?\))?|(?:VAR)?(?:CHAR|BINARY)\(\d{1,5}\)|(?:TINY|MEDIUM|LONG)?(?:TEXT|BLOB)|(?:DATETIME|TIMESTAMP)(?:\([0-6]\))?|DATE|JSON)$/u;

function requirePackageEngine(context) {
  const release = /^(?:5\.5\.5-)?(\d+)\.(\d+)\./u.exec(context.version || '');
  if (context.dialect !== 'mariadb' || !release || (+release[1] < 11 || +release[1] === 11 && +release[2] < 4)) {
    throw fail('ENGINE', 'Reviewed package calls require MariaDB 11.4 or later.');
  }
}

function listPackages(query, context, { prefix, after } = {}) {
  requirePackageEngine(context);
  return listNames(query, context, { kind: 'package', schema: context.database, prefix, after });
}

function namesOf(target, database) {
  const schema = identifier(target?.schema ?? database, { table: true });
  const name = identifier(target?.name, { table: true });
  if (schema !== database || target?.kind !== 'package') {
    throw fail('TARGET', 'Choose a package in the connected database.');
  }
  return { schema, name, kind: 'package' };
}

function characteristics(tokens, at) {
  while (true) {
    if (word(tokens[at], 'COMMENT') && tokens[at + 1]?.kind === 'string') at += 2;
    else if (word(tokens[at], 'SQL') && word(tokens[at + 1], 'SECURITY') && ['DEFINER', 'INVOKER'].some(value => word(tokens[at + 2], value))) at += 3;
    else if ((word(tokens[at], 'LANGUAGE') || word(tokens[at], 'CONTAINS') || word(tokens[at], 'NO')) && word(tokens[at + 1], 'SQL')) at += 2;
    else if ((word(tokens[at], 'READS') || word(tokens[at], 'MODIFIES')) && word(tokens[at + 1], 'SQL') && word(tokens[at + 2], 'DATA')) at += 3;
    else return at;
  }
}

function header(loaded) {
  const mode = loaded.settings.sql_mode;
  if (typeof mode !== 'string') throw fail('MODE', 'This package does not report a stored SQL mode.');
  const sqlMode = mode.split(','), syntax = sqlMode.includes('ORACLE') ? 'oracle' : 'psm';
  let tokens;
  try { tokens = sourceTokens(loaded.source, { dialect: 'mariadb', sqlMode }); }
  catch { throw fail('SOURCE', 'This package source cannot be reviewed unambiguously within the supported SQL lexer.'); }
  let at = tokens.findIndex(token => word(token, 'PACKAGE'));
  if (!word(tokens[0], 'CREATE') || at < 1) throw fail('SOURCE', 'The package header could not be confirmed.');
  at++;
  if (loaded.object.kind === 'package-body') {
    if (!word(tokens[at], 'BODY')) throw fail('SOURCE', 'The returned source is not a package body.');
    at++;
  }
  if (word(tokens[at], 'IF') && word(tokens[at + 1], 'NOT') && word(tokens[at + 2], 'EXISTS')) at += 3;
  if (symbol(tokens[at + 1], '.')) {
    if (!isName(tokens[at]) || tokens[at].value !== loaded.object.schema) throw fail('SOURCE', 'The package header names a different database.');
    at += 2;
  }
  if (!isName(tokens[at]) || tokens[at].value !== loaded.object.name) throw fail('SOURCE', 'The source names a different package.');
  let start = characteristics(tokens, at + 1);
  if (syntax === 'oracle') {
    if (!word(tokens[start], 'AS') && !word(tokens[start], 'IS')) throw fail('SOURCE', 'The Oracle package declaration is missing AS or IS.');
    start++;
  }
  return { tokens, start, syntax };
}

function scalarType(source, tokens, start, end, syntax) {
  if (start >= end || tokens[start]?.kind !== 'word') return null;
  const type = source.slice(tokens[start].start, tokens[end - 1].end).toUpperCase().replace(/\s+/gu, ' ')
    .replace(/\s*([(),])\s*/gu, '$1').trim();
  let compatible = type;
  if (syntax === 'oracle') {
    if (/^NUMBER(?:\(\d{1,2}(?:,\d{1,2})?\))?$/u.test(type)) return { type, kind: 'decimal' };
    else if (/^VARCHAR2\(\d{1,5}\)$/u.test(type)) compatible = type.replace('VARCHAR2', 'VARCHAR');
    else if (type === 'DATE') compatible = 'DATETIME';
  }
  const kind = scalar.test(compatible) && typeKind(compatible);
  return kind ? { type, kind } : null;
}

function direction(tokens, at) {
  if (word(tokens[at], 'IN') && word(tokens[at + 1], 'OUT')) return { mode: 'INOUT', next: at + 2 };
  if (['IN', 'OUT', 'INOUT'].some(value => word(tokens[at], value))) return { mode: tokens[at].upper, next: at + 1 };
  return { mode: 'IN', next: at };
}

function parameter(source, tokens, start, end, ordinal, syntax) {
  const placement = direction(tokens, syntax === 'oracle' ? start + 1 : start);
  const nameToken = tokens[syntax === 'oracle' ? start : placement.next];
  if (!isName(nameToken)) return null;
  let name;
  try { name = identifier(nameToken.value); } catch { return null; }
  const shape = scalarType(source, tokens, placement.next + (syntax === 'oracle' ? 0 : 1), end, syntax);
  return shape ? { ordinal, name, mode: placement.mode, ...shape } : null;
}

function parametersOf(source, tokens, afterName, syntax) {
  if (!symbol(tokens[afterName], '(')) return { after: afterName, parameters: [] };
  const close = tokens[afterName].close;
  if (!Number.isInteger(close)) throw fail('SOURCE', 'A package member signature has an unclosed parameter list.');
  let start = afterName + 1;
  const parameters = [];
  for (let at = start; at <= close && start < close; at++) {
    if (symbol(tokens[at], '(')) { at = tokens[at].close; continue; }
    if (at === close || symbol(tokens[at], ',')) {
      if (parameters.length >= 32 || at === start || at + 1 === close && at !== close) return { after: close + 1, parameters: null };
      parameters.push(parameter(source, tokens, start, at, parameters.length + 1, syntax));
      start = at + 1;
    }
  }
  const unique = new Set(parameters.map(value => value?.name.toLowerCase()));
  return { after: close + 1, parameters: parameters.every(Boolean) && unique.size === parameters.length ? parameters : null };
}

function memberSignature(loaded, tokens, at, kind, syntax) {
  let { after, parameters } = parametersOf(loaded.source, tokens, at + 2, syntax);
  let returns = null;
  if (kind === 'function') {
    if (!word(tokens[after], syntax === 'oracle' ? 'RETURN' : 'RETURNS')) return { after, parameters: null };
    const start = ++after;
    after++;
    if (symbol(tokens[after], '(')) after = tokens[after].close + 1;
    if (word(tokens[after], 'UNSIGNED')) after++;
    returns = scalarType(loaded.source, tokens, start, after, syntax);
    if (!returns || parameters?.some(parameter => parameter.mode !== 'IN')) parameters = null;
    if (word(tokens[after], 'DETERMINISTIC')) after++;
    else if (word(tokens[after], 'NOT') && word(tokens[after + 1], 'DETERMINISTIC')) after += 2;
  }
  return { after: characteristics(tokens, after), parameters, returns };
}

function specificationMembers(loaded) {
  const { tokens, start, syntax } = header(loaded);
  const members = [];
  let at = start;
  while (at < tokens.length && !word(tokens[at], 'END')) {
    const kind = ['procedure', 'function'].find(value => word(tokens[at], value.toUpperCase()));
    if (!kind || !isName(tokens[at + 1]) || members.length >= 64) throw fail('SOURCE', 'The public package declaration exceeds its supported shape or member limit.');
    const name = identifier(tokens[at + 1].value, { table: true });
    const { after, parameters, returns } = memberSignature(loaded, tokens, at, kind, syntax);
    const end = tokens.findIndex((token, index) => index >= after && symbol(token, ';'));
    if (end < 0) throw fail('SOURCE', 'A public package declaration is incomplete.');
    const supported = parameters !== null && after === end;
    members.push({ kind, name, parameters: supported ? parameters : null, ...(returns && { returns }), supported });
    at = end + 1;
  }
  const trailer = tokens[at + 1];
  const namedEnd = syntax === 'oracle' && isName(trailer) && trailer.value.toLowerCase() === loaded.object.name.toLowerCase();
  if (!word(tokens[at], 'END') || tokens.slice(at + (namedEnd ? 2 : 1)).some(token => !symbol(token, ';'))) {
    throw fail('SOURCE', 'The public package declaration has an unsupported end boundary.');
  }
  const counts = new Map();
  for (const member of members) counts.set(member.name.toLowerCase(), (counts.get(member.name.toLowerCase()) || 0) + 1);
  return members.map(member => counts.get(member.name.toLowerCase()) === 1 ? member : { ...member, supported: false, parameters: null });
}

function sameSignature(left, right) {
  const signature = parameters => parameters.map(({ name, mode, type }) => [name.toLowerCase(), mode, type]);
  return left.parameters !== null && right?.parameters != null &&
    JSON.stringify(signature(left.parameters)) === JSON.stringify(signature(right.parameters)) &&
    (left.returns?.type || null) === (right.returns?.type || null);
}

function implementedMembers(body, members, expectedSyntax) {
  const { tokens, start, syntax } = header(body);
  if (expectedSyntax && syntax !== expectedSyntax) throw fail('MODE', 'The package specification and body use different stored SQL dialects.');
  const declarations = new Map(members.filter(member => member.supported).map(member =>
    [member.kind + ':' + member.name.toLowerCase(), []]));
  for (let at = start; at < tokens.length; at++) {
    const kind = ['procedure', 'function'].find(value => word(tokens[at], value.toUpperCase()));
    if (!kind || !isName(tokens[at + 1])) continue;
    const matches = declarations.get(kind + ':' + tokens[at + 1].value.toLowerCase());
    if (!matches) continue;
    const heading = memberSignature(body, tokens, at, kind, syntax);
    const next = tokens[heading.after];
    if (symbol(next, ';')) continue;
    const implementation = syntax === 'oracle' ? word(next, 'IS') || word(next, 'AS')
      : word(next, 'BEGIN') || kind === 'function' && word(next, 'RETURN');
    matches.push(implementation ? heading : null);
  }
  return members.map(member => {
    const implementations = declarations.get(member.kind + ':' + member.name.toLowerCase());
    const supported = member.supported && implementations?.length === 1 && sameSignature(member, implementations[0]);
    return supported ? member : { ...member, supported: false, parameters: null };
  });
}

async function inspectPackage(query, context, target) {
  requirePackageEngine(context);
  const object = namesOf(target, context.database);
  const spec = await loadSource(query, context, object);
  const body = await loadSource(query, context, { ...object, kind: 'package-body' });
  const syntax = spec.settings.sql_mode?.split(',').includes('ORACLE') ? 'oracle' : 'psm';
  const members = implementedMembers(body, specificationMembers(spec), syntax);
  return { object, spec, body, members, syntax };
}

module.exports = { listPackages, inspectPackage, specificationMembers, implementedMembers };
