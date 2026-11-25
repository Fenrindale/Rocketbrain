'use strict';

const { createHash } = require('node:crypto');
const { tokenize } = require('./sql-policy');

const word = (token, value) => token?.kind === 'word' && token.upper === value;
const symbol = (token, value) => token?.kind === 'symbol' && token.value === value;
const identifier = token => ['word', 'identifier'].includes(token?.kind) && token.value.length > 0 && token.value.length <= 64;
const sameName = (a, b) => a.toLowerCase() === b.toLowerCase();

function qualified(tokens, index) {
  if (!identifier(tokens[index])) return;
  let name = tokens[index++].value, qualifier;
  if (symbol(tokens[index], '.')) {
    if (!identifier(tokens[index + 1])) return;
    qualifier = name;
    name = tokens[index + 1].value;
    index += 2;
  }
  return { name, qualifier, next: index };
}

function parameterTokens(statement, parameters, mode) {
  const tokens = tokenize(statement.sql, true, { sqlMode: mode });
  const positions = new Map(parameters.map(parameter => [parameter.start - statement.start, parameter]));
  const combined = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index], parameter = positions.get(token.start);
    if (!parameter) combined.push(token);
    else {
      combined.push({ kind: 'parameter', key: parameter.key });
      while (tokens[index + 1]?.end <= parameter.end - statement.start) index++;
    }
  }
  return combined;
}

function equalityTargets(tokens, database) {
  const from = tokens.findIndex(token => word(token, 'FROM'));
  if (from <= 1 || !tokens.slice(1, from).every(token => identifier(token) || ['*', ',', '.'].some(value => symbol(token, value)))) return [];
  const table = qualified(tokens, from + 1);
  if (!table) return [];
  let index = table.next, alias = table.name;
  const markedAlias = word(tokens[index], 'AS');
  if (markedAlias) index++;
  if (markedAlias || !word(tokens[index], 'WHERE')) {
    if (!identifier(tokens[index]) || word(tokens[index], 'WHERE')) return [];
    alias = tokens[index++].value;
  }
  if (!word(tokens[index++], 'WHERE')) return [];
  const targets = [];
  while (index < tokens.length) {
    const column = qualified(tokens, index);
    if (!column || column.qualifier && !sameName(column.qualifier, alias) ||
      !symbol(tokens[column.next], '=') || tokens[column.next + 1]?.kind !== 'parameter') return [];
    targets.push({ key: tokens[column.next + 1].key, schema: table.qualifier || database, table: table.name, column: column.name });
    index = column.next + 2;
    if (index === tokens.length) return targets;
    if (!word(tokens[index++], 'AND')) return [];
  }
  return [];
}

function insertTargets(tokens, database) {
  if (!word(tokens[1], 'INTO')) return [];
  const table = qualified(tokens, 2);
  if (!table || !symbol(tokens[table.next], '(')) return [];
  let index = table.next + 1;
  const columns = [];
  while (true) {
    if (!identifier(tokens[index])) return [];
    columns.push(tokens[index++].value);
    if (!symbol(tokens[index], ',')) break;
    index++;
  }
  if (!symbol(tokens[index++], ')') || !word(tokens[index++], 'VALUES')) return [];
  const targets = [];
  while (true) {
    if (!symbol(tokens[index++], '(')) return [];
    for (const [offset, column] of columns.entries()) {
      const parameter = tokens[index++];
      if (parameter?.kind !== 'parameter' || !symbol(tokens[index++], offset === columns.length - 1 ? ')' : ',')) return [];
      targets.push({ key: parameter.key, schema: table.qualifier || database, table: table.name, column });
    }
    if (!symbol(tokens[index], ',')) break;
    index++;
  }
  return index === tokens.length ? targets : [];
}

function typeKind(columnType) {
  const type = columnType.toLowerCase().split(/[\s(]/u)[0];
  if (['tinyint', 'smallint', 'mediumint', 'int', 'integer', 'bigint', 'year'].includes(type)) return 'integer';
  if (['decimal', 'numeric'].includes(type)) return 'decimal';
  if (['float', 'double', 'real'].includes(type)) return 'number';
  if (['date', 'datetime', 'timestamp'].includes(type)) return 'date';
  if (['binary', 'varbinary', 'tinyblob', 'blob', 'mediumblob', 'longblob'].includes(type)) return 'binary';
  if (type === 'json') return 'json';
  if (['char', 'varchar', 'tinytext', 'text', 'mediumtext', 'longtext', 'enum', 'set'].includes(type)) return 'text';
}

async function inferScriptParameters(script, database, readColumns) {
  const observations = [], tables = new Map();
  const parametersByStatement = new Map();
  let statementIndex = 0;
  for (const parameter of script.parameters) {
    while (script.statements[statementIndex].end <= parameter.start) statementIndex++;
    const entries = parametersByStatement.get(statementIndex) || [];
    entries.push(parameter);
    parametersByStatement.set(statementIndex, entries);
  }
  for (const [index, parameters] of parametersByStatement) {
    const statement = script.statements[index];
    if (statement.first !== 'SELECT' && statement.first !== 'INSERT') continue;
    const tokens = parameterTokens(statement, parameters, script.sqlMode);
    const targets = statement.first === 'SELECT' ? equalityTargets(tokens, database) : insertTargets(tokens, database);
    for (const target of targets) {
      const identity = JSON.stringify([target.schema, target.table]);
      if (!tables.has(identity) && tables.size < 16) {
        try { tables.set(identity, await readColumns(target.schema, target.table)); }
        catch { tables.set(identity, []); }
      }
      const column = tables.get(identity)?.find(([name]) => sameName(name, target.column));
      observations.push([target.key, target.schema, target.table, target.column, column?.[1] ?? null, ...(column?.slice(2) || [])]);
    }
  }
  const byKey = new Map();
  for (const row of observations) {
    if (!byKey.has(row[0])) byKey.set(row[0], []);
    byKey.get(row[0]).push(row);
  }
  const parameterHints = script.parameterDefinitions.flatMap(parameter => {
    const rows = byKey.get(parameter.key);
    if (!rows || rows.length !== parameter.occurrences || typeof rows[0][4] !== 'string' ||
      !rows.every(row => row[4] === rows[0][4])) return [];
    const [key, schema, table, column, columnType] = rows[0], kind = typeKind(columnType);
    return kind ? [{ key, kind, schema, table, column, columnType }] : [];
  });
  return { parameterHints, parameterEvidence: createHash('sha256').update(JSON.stringify(observations)).digest('hex') };
}

module.exports = { inferScriptParameters, typeKind };
