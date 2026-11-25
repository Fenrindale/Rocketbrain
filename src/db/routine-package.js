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
  if (typeof mode !== 'string' || mode.split(',').includes('ORACLE')) {
    throw fail('MODE', 'Reviewed package calls currently support MariaDB SQL/PSM package definitions.');
  }
  let tokens;
  try { tokens = sourceTokens(loaded.source, { dialect: 'mariadb', sqlMode: mode.split(',') }); }
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
  return { tokens, start: characteristics(tokens, at + 1) };
}

function parameter(source, tokens, start, end, ordinal) {
  let at = start, mode = 'IN';
  if (word(tokens[at], 'IN') && word(tokens[at + 1], 'OUT')) { mode = 'INOUT'; at += 2; }
  else if (['IN', 'OUT', 'INOUT'].some(value => word(tokens[at], value))) mode = tokens[at++].upper;
  if (!isName(tokens[at]) || end - at < 2) return null;
  let name;
  try { name = identifier(tokens[at].value); } catch { return null; }
  const type = source.slice(tokens[at + 1].start, tokens[end - 1].end).toUpperCase().replace(/\s+/gu, ' ')
    .replace(/\s*([(),])\s*/gu, '$1').trim();
  const kind = scalar.test(type) && typeKind(type);
  return kind ? { ordinal, name, mode, type, kind } : null;
}

function parametersOf(source, tokens, afterName) {
  if (!symbol(tokens[afterName], '(')) return { after: afterName, parameters: [] };
  const close = tokens[afterName].close;
  if (!Number.isInteger(close)) throw fail('SOURCE', 'A package member signature has an unclosed parameter list.');
  let start = afterName + 1;
  const parameters = [];
  for (let at = start; at <= close && start < close; at++) {
    if (symbol(tokens[at], '(')) { at = tokens[at].close; continue; }
    if (at === close || symbol(tokens[at], ',')) {
      if (parameters.length >= 32 || at === start || at + 1 === close && at !== close) return { after: close + 1, parameters: null };
      parameters.push(parameter(source, tokens, start, at, parameters.length + 1));
      start = at + 1;
    }
  }
  const unique = new Set(parameters.map(value => value?.name.toLowerCase()));
  return { after: close + 1, parameters: parameters.every(Boolean) && unique.size === parameters.length ? parameters : null };
}

function specificationMembers(loaded) {
  const { tokens, start } = header(loaded);
  const members = [];
  let at = start;
  while (at < tokens.length && !word(tokens[at], 'END')) {
    const kind = ['procedure', 'function'].find(value => word(tokens[at], value.toUpperCase()));
    if (!kind || !isName(tokens[at + 1]) || members.length >= 64) throw fail('SOURCE', 'The public package declaration exceeds its supported shape or member limit.');
    const name = identifier(tokens[at + 1].value, { table: true });
    const { after, parameters } = parametersOf(loaded.source, tokens, at + 2);
    const end = tokens.findIndex((token, index) => index >= after && symbol(token, ';'));
    if (end < 0) throw fail('SOURCE', 'A public package declaration is incomplete.');
    const supported = kind === 'procedure' && parameters !== null && characteristics(tokens, after) === end;
    members.push({ kind, name, parameters: supported ? parameters : null, supported });
    at = end + 1;
  }
  if (!word(tokens[at], 'END') || tokens.slice(at + 1).some(token => !symbol(token, ';'))) {
    throw fail('SOURCE', 'The public package declaration has an unsupported end boundary.');
  }
  const counts = new Map();
  for (const member of members) counts.set(member.name.toLowerCase(), (counts.get(member.name.toLowerCase()) || 0) + 1);
  return members.map(member => counts.get(member.name.toLowerCase()) === 1 ? member : { ...member, supported: false, parameters: null });
}

function sameSignature(left, right) {
  const signature = parameters => parameters.map(({ name, mode, type }) => [name.toLowerCase(), mode, type]);
  return left !== null && right !== null && JSON.stringify(signature(left)) === JSON.stringify(signature(right));
}

function implementedMembers(body, members) {
  const { tokens, start } = header(body);
  const byName = new Map(members.filter(member => member.supported).map(member => [member.name.toLowerCase(), []]));
  for (let at = start; at < tokens.length; at++) {
    if (!word(tokens[at], 'PROCEDURE') || !isName(tokens[at + 1])) continue;
    const matches = byName.get(tokens[at + 1].value.toLowerCase());
    if (!matches) continue;
    const { after, parameters } = parametersOf(body.source, tokens, at + 2);
    const next = tokens[characteristics(tokens, after)];
    if (!symbol(next, ';')) matches.push(word(next, 'BEGIN') ? parameters : null);
  }
  return members.map(member => {
    const implementations = byName.get(member.name.toLowerCase());
    const supported = member.supported && implementations?.length === 1 && sameSignature(member.parameters, implementations[0]);
    return supported ? member : { ...member, supported: false, parameters: null };
  });
}

async function inspectPackage(query, context, target) {
  requirePackageEngine(context);
  const object = namesOf(target, context.database);
  const spec = await loadSource(query, context, object);
  const body = await loadSource(query, context, { ...object, kind: 'package-body' });
  const members = implementedMembers(body, specificationMembers(spec));
  return { object, spec, body, members };
}

module.exports = { listPackages, inspectPackage, specificationMembers, implementedMembers };
