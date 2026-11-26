'use strict';

const AST = require('./schema-trigger-ast');
const { identifier } = require('./schema-rename');

const joinedFormat = 'RocketbrainPreparedJoinUpdate';
const valueLimit = 64 * 1024;
const integer = /^(TINYINT|SMALLINT|MEDIUMINT|INT|INTEGER|BIGINT)(?:\(\d{1,3}\))?( UNSIGNED)?$/iu;
const word = token => token?.kind === 'word' ? token.value.toUpperCase() : undefined;
const fail = message => Object.assign(new Error(message), { code: 'ROCKETBRAIN_PROGRAM' });

function joinedUpdate(tokens, database) {
  let cursor = 0;
  const at = keyword => word(tokens[cursor]) === keyword || tokens[cursor]?.value === keyword;
  const take = keyword => {
    if (!at(keyword)) throw fail('Expected ' + keyword + ' in the reviewed prepared UPDATE JOIN.');
    cursor++;
  };
  function name() {
    const token = tokens[cursor++];
    if (!token?.name || token.kind === 'user') throw fail('Use explicit table aliases and alias-qualified columns in a prepared UPDATE JOIN.');
    return identifier(token.name, { table: true });
  }
  function relation() {
    const ref = AST.reference(tokens, cursor, database);
    cursor = ref.end;
    take('AS');
    return { table: { schema: ref.schema, table: ref.table }, alias: name() };
  }
  function column() {
    const alias = name();
    take('.');
    return { alias, column: name() };
  }
  function value() {
    if (at('?')) {
      take('?');
      return { kind: 'parameter' };
    }
    const negative = at('-');
    if (negative) take('-');
    const token = tokens[cursor++];
    if (token?.kind !== 'number' || !/^\d+$/u.test(token.value) || !Number.isSafeInteger(Number(token.value))) {
      throw fail('Use an integer literal or a value parameter in a prepared UPDATE JOIN.');
    }
    return { kind: 'integer', value: (negative ? '-' : '') + token.value };
  }
  function operand() {
    return tokens[cursor + 1]?.value === '.' ? { kind: 'column', ...column() } : value();
  }

  take('UPDATE');
  const target = relation();
  if (at('INNER')) take('INNER');
  take('JOIN');
  const lookup = relation();
  if (target.alias.toLowerCase() === lookup.alias.toLowerCase() ||
      AST.refKey(target.table).toLowerCase() === AST.refKey(lookup.table).toLowerCase()) {
    throw fail('Use distinct physical tables and distinct aliases in a prepared UPDATE JOIN.');
  }
  take('ON');
  const keys = [];
  do {
    if (keys.length) take('AND');
    const first = column();
    take('=');
    const second = column();
    if (![first.alias, second.alias].includes(target.alias) || ![first.alias, second.alias].includes(lookup.alias)) {
      throw fail('Join key predicates must pair the explicit write and lookup aliases.');
    }
    const left = first.alias === target.alias ? first : second, right = first.alias === lookup.alias ? first : second;
    if (keys.some(key => key.target.toLowerCase() === left.column.toLowerCase() || key.lookup.toLowerCase() === right.column.toLowerCase())) {
      throw fail('Join key predicates must use distinct columns on both relations.');
    }
    keys.push({ target: left.column, lookup: right.column });
    if (keys.length > 8) throw fail('Review at most eight key predicates in a prepared UPDATE JOIN.');
  } while (at('AND'));
  take('SET');
  const assignment = column();
  if (assignment.alias !== target.alias) throw fail('Only the first table may be written by a prepared UPDATE JOIN.');
  take('=');
  const source = operand();
  let adjustment = null;
  if (at('+') || at('-')) {
    const operator = tokens[cursor++].value;
    adjustment = { operator, value: value() };
  }
  take('WHERE');
  const filter = column();
  if (filter.alias !== target.alias) throw fail('The prepared UPDATE JOIN filter must use the write alias.');
  take('=');
  const filterValue = value();
  if (cursor !== tokens.length) throw fail('Review one bounded UPDATE JOIN with one assignment and one equality filter.');
  const targets = [target.table, lookup.table].sort((one, two) => AST.refKey(one).localeCompare(AST.refKey(two)));
  return { format: joinedFormat, formatVersion: 1, target, lookup, keys, assignment: assignment.column, source, adjustment,
    filter: { column: filter.column, value: filterValue }, targets, readTargets: targets, writeTargets: [target.table] };
}

function inspectPreparedTemplate(text, schema, sqlMode = '') {
  if (typeof text !== 'string') throw fail('PREPARE source is not a finite resolved string for every analyzed invocation path.');
  if (Buffer.byteLength(text) > valueLimit) throw fail('Prepared SQL template exceeds 64 KiB.');
  const tokens = AST.programLex(text, { sqlMode });
  if (tokens.length > AST.LIMITS.tokens) throw fail('The prepared SQL template exceeds the token limit.');
  if (!tokens.length || tokens.some(token => token.value === ';') ||
      !['SELECT', 'INSERT', 'UPDATE', 'DELETE'].includes(word(tokens[0]))) {
    throw fail('Prepared templates support one statically named SELECT/INSERT/UPDATE/DELETE only.');
  }
  const assignment = tokens.findIndex(token => word(token) === 'SET');
  const hasJoin = word(tokens[0]) === 'UPDATE' && tokens.slice(1, assignment < 0 ? undefined : assignment).some(token => word(token) === 'JOIN');
  const ast = hasJoin ? joinedUpdate(tokens, schema) :
    AST.parseProgram(text, schema, undefined, { kind: 'procedure', sqlMode, parameters: [], allowRows: true, allowDynamic: false, placeholders: true });
  return { text, ast, placeholders: tokens.filter(token => token.value === '?').length,
    returnsRows: !hasJoin && ast.statements[0].statements.some(node => node.kind === 'select' && !node.into.length) };
}

function tableFor(ref, tables) {
  const table = tables.find(entry => entry.schema === ref.schema && entry.name === ref.table);
  if (table?.kind !== 'table' || String(table.engine).toUpperCase() !== 'INNODB') {
    throw fail('Use visible, canonically named InnoDB base tables in a prepared UPDATE JOIN.');
  }
  return table;
}

function integerColumn(table, name) {
  const entry = table.columns.find(column => column.name === name);
  const parts = integer.exec(entry?.type || '');
  if (!parts || entry.generationExpression || /\bgenerated\b/iu.test(entry.extra || '')) {
    throw fail('Prepared UPDATE JOIN columns require observed, ordinary integer types.');
  }
  const family = parts[1].toUpperCase();
  return { entry, type: (family === 'INTEGER' ? 'INT' : family) + (parts[2] ? ' UNSIGNED' : '') };
}

function validateJoinedUpdate(ast, tables) {
  const target = tableFor(ast.target.table, tables), lookup = tableFor(ast.lookup.table, tables);
  for (const key of ast.keys) {
    const write = integerColumn(target, key.target), read = integerColumn(lookup, key.lookup);
    if (write.type !== read.type || read.entry.nullable !== false) {
      throw fail('A prepared UPDATE JOIN requires matching integer key types and a non-null lookup key.');
    }
  }
  const lookupNames = new Set(ast.keys.map(key => key.lookup));
  if (!lookup.indexes?.some(index => index.unique && String(index.type).toUpperCase() === 'BTREE' &&
      index.columns.length === lookupNames.size && new Set(index.columns.map(column => column.name)).size === lookupNames.size &&
      index.columns.every(column => lookupNames.has(column.name) && column.prefixLength == null && !column.expression))) {
    throw fail('A prepared UPDATE JOIN must match every column of one observed unique lookup key.');
  }
  const write = integerColumn(target, ast.assignment);
  if (target.indexes?.some(index => index.columns.some(column => column.name === ast.assignment || column.expression)) ||
      target.foreignKeys?.some(key => key.columns.some(column => column.name === ast.assignment)) ||
      target.columns.some(column => column.generationExpression) || /\bauto_increment\b/iu.test(write.entry.extra || '')) {
    throw fail('A prepared UPDATE JOIN may write an ordinary unindexed value column without generated dependencies.');
  }
  integerColumn(target, ast.filter.column);
  if (ast.source.kind === 'column') {
    const tablesByAlias = new Map([[ast.target.alias, target], [ast.lookup.alias, lookup]]);
    const from = tablesByAlias.get(ast.source.alias);
    if (!from) throw fail('Prepared UPDATE JOIN value references need one of the reviewed aliases.');
    if (integerColumn(from, ast.source.column).type !== write.type) {
      throw fail('Use matching integer source and write value types in a prepared UPDATE JOIN.');
    }
  }
}

function validatePreparedTemplate(template, context) {
  const compiled = inspectPreparedTemplate(template.text, context.database, context.sqlMode);
  if (JSON.stringify(template) !== JSON.stringify(compiled)) throw fail('The reviewed prepared template changed.');
  if (compiled.ast.format === joinedFormat) validateJoinedUpdate(compiled.ast, context.tables);
  else AST.validate(compiled.ast, context);
}

module.exports = { inspectPreparedTemplate, validatePreparedTemplate };
