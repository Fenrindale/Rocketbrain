'use strict';

const { tokenize } = require('./sql-policy');

const connectionMessage = 'This connection profile is locked to read-only mode.';
const scopedWrites = new Set(['INSERT', 'REPLACE', 'UPDATE', 'DELETE']);
const readCommands = new Set(['SELECT', 'WITH', 'SHOW', 'DESC', 'DESCRIBE', 'EXPLAIN']);
const writeWords = new Set(['INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'INTO', 'CALL']);
const writeOptions = new Set(['LOW_PRIORITY', 'HIGH_PRIORITY', 'DELAYED', 'IGNORE', 'QUICK']);
const ambiguousMutation = 'Identify one base table in a direct INSERT, REPLACE, UPDATE or DELETE when this profile protects tables.';
const sqlSyntaxBeforeParen = new Set(['IN', 'EXISTS', 'NOT', 'AS', 'FROM', 'WHERE', 'AND', 'OR', 'BETWEEN', 'VALUES',
  'WHEN', 'THEN', 'ELSE', 'SELECT', 'ON', 'HAVING', 'ALL', 'ANY', 'OVER', 'USING']);
const scalarFunctions = new Set(['ABS', 'AVG', 'CAST', 'CEIL', 'CEILING', 'CHAR_LENGTH', 'COALESCE', 'CONCAT', 'CONCAT_WS',
  'COUNT', 'CURRENT_DATE', 'CURRENT_TIMESTAMP', 'CURRENT_USER', 'DATABASE', 'DATE', 'FLOOR', 'IF', 'IFNULL',
  'JSON_EXTRACT', 'JSON_OBJECT', 'JSON_VALID', 'LEFT', 'LENGTH', 'LOWER', 'MAX', 'MIN', 'NOW', 'NULLIF', 'ROUND', 'RIGHT',
  'SUBSTRING', 'SUM', 'TRIM', 'UPPER', 'VERSION']);

function protectionError(message) {
  return Object.assign(new Error(message), { code: 'ROCKETBRAIN_WRITE_PROTECTION' });
}

function identifier(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 && !/[\x00-\x1f\x7f]/u.test(value);
}

function tableKey(schema, name) {
  return JSON.stringify([schema.toLowerCase(), name.toLowerCase()]);
}

function normalizeWriteProtection(value) {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['connectionReadOnly', 'tables'].includes(key))
    || (value.connectionReadOnly !== undefined && typeof value.connectionReadOnly !== 'boolean')
    || (value.tables !== undefined && (!Array.isArray(value.tables) || value.tables.length > 64))) {
    throw protectionError('Set a read-only connection or enter at most 64 protected schema and table pairs.');
  }
  const entries = new Map();
  for (const table of value.tables || []) {
    if (!table || Object.keys(table).length !== 2 || !identifier(table.schema) || !identifier(table.name)) {
      throw protectionError('Each protected table needs its exact schema and table name.');
    }
    const key = tableKey(table.schema, table.name);
    if (entries.has(key)) throw protectionError('Choose each protected table only once.');
    entries.set(key, { schema: table.schema, name: table.name });
  }
  if (!value.connectionReadOnly && !entries.size) return;
  const tables = [...entries].sort(([left], [right]) => left.localeCompare(right)).map(([, table]) => table);
  return { connectionReadOnly: value.connectionReadOnly === true, tables };
}

function tableProtection(policy, schema, name) {
  if (policy?.connectionReadOnly) return connectionMessage;
  if (policy?.tables.some(table => tableKey(table.schema, table.name) === tableKey(schema, name))) {
    return 'The connection profile protects this table from writes.';
  }
  return '';
}

function requireConnectionMode(policy, readOnly) {
  if (policy?.connectionReadOnly && !readOnly) throw protectionError(connectionMessage);
}

function directTarget(tokens, command, database) {
  let index = 1;
  while (tokens[index]?.kind === 'word' && writeOptions.has(tokens[index].upper)) index++;
  if (command === 'DELETE' || command === 'INSERT' || command === 'REPLACE') {
    const introducer = command === 'DELETE' ? 'FROM' : 'INTO';
    if (tokens[index]?.kind !== 'word' || tokens[index].upper !== introducer) throw protectionError(ambiguousMutation);
    index++;
  }
  const identifierAt = i => ['word', 'identifier'].includes(tokens[i]?.kind) && identifier(tokens[i].value);
  if (!identifierAt(index)) throw protectionError(ambiguousMutation);
  let schema = database, name = tokens[index++].value;
  if (tokens[index]?.value === '.') {
    if (!identifierAt(index + 1)) throw protectionError(ambiguousMutation);
    schema = name;
    name = tokens[index + 1].value;
    index += 2;
  }
  const tableEnd = index - 1;
  if (tokens[index]?.upper === 'AS' && tokens[index].kind === 'word' && identifierAt(index + 1)) index += 2;
  const head = tokens[index]?.kind === 'word' && tokens[index].upper;
  if (command === 'UPDATE' && head !== 'SET'
    || command === 'DELETE' && tokens[index] && !['WHERE', 'ORDER', 'LIMIT', 'RETURNING'].includes(head)
    || ['INSERT', 'REPLACE'].includes(command) && tokens[index]?.value !== '('
      && !['VALUES', 'VALUE', 'SET', 'SELECT'].includes(head)) throw protectionError(ambiguousMutation);
  return { schema, name, tableEnd };
}

function verifyCallableScope(tokens, tableEnd) {
  for (const [index, token] of tokens.entries()) {
    if (tokens[index + 1]?.value !== '(' || index === tableEnd || !['word', 'identifier'].includes(token.kind)) continue;
    const isKnown = token.kind === 'word' && tokens[index - 1]?.value !== '.'
      && (scalarFunctions.has(token.upper) || sqlSyntaxBeforeParen.has(token.upper));
    if (!isKnown) throw protectionError('Use a read-only console for unverified SQL functions while this profile protects tables.');
  }
}

function requireStatementScope(policy, sql, database, { mayWrite, readOnly, userSql = false, sqlMode } = {}) {
  if (!policy) return;
  if (!mayWrite && (!userSql || !policy.tables.length || readOnly)) return;
  const tokens = tokenize(sql, false, { sqlMode });
  const first = tokens[0]?.kind === 'word' ? tokens[0].upper : '';
  const knownRead = readCommands.has(first) && !tokens.some(token => token.kind === 'word' && writeWords.has(token.upper));
  if (knownRead) {
    if (userSql && !readOnly) {
      // A view can reference a stored function even when the query spells no function.
      if (tokens.some(token => token.kind === 'word' && ['FROM', 'JOIN'].includes(token.upper))) {
        throw protectionError('Use a read-only console for queries that read tables or views while this profile protects tables.');
      }
      verifyCallableScope(tokens);
    }
    return;
  }
  if (policy.connectionReadOnly) throw protectionError(connectionMessage);
  if (!scopedWrites.has(first)) throw protectionError(ambiguousMutation);
  const target = directTarget(tokens, first, database);
  const reason = tableProtection(policy, target.schema, target.name);
  if (reason) throw protectionError(reason);
  if (tokens.some(token => token.kind === 'word' && token.upper === 'SELECT')) throw protectionError(ambiguousMutation);
  if (userSql) verifyCallableScope(tokens, target.tableEnd);
  return target;
}

module.exports = { normalizeWriteProtection, protectionError, requireConnectionMode, requireStatementScope, tableProtection };
