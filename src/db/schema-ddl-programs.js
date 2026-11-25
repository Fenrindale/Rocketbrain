'use strict';

const { createHash } = require('node:crypto');
const { identifier } = require('./schema-rename');
const { loadSource } = require('./object-source');
const { tokenize } = require('./sql-policy');
const { shownBody } = require('./schema-programs');
const { scalarFunction } = require('./object-editor-function');
const { renderTypes } = require('./schema-diff');
const AST = require('./schema-trigger-ast');

const maxPrograms = 100;
const maxSourceBytes = 128 * 1024;
const maxTotalBytes = 8 * 1024 * 1024;
const reserved = /^__rb_/iu;
const word = (token, value) => token?.kind === 'word' && token.upper === value;
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const unsupported = reason => Object.assign(Error(reason), { code: 'ROCKETBRAIN_DDL_PROGRAM_UNSUPPORTED' });
const programId = (kind, name) => kind + '/' + (kind === 'trigger' ? name : name.toLowerCase());
const name = value => identifier(value, { table: true });
const asciiName = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;
const noClientDirectives = /(?:^|[\r\n])[\t ]*(?:\\|(?:DELIMITER|SOURCE|SYSTEM|CONNECT|QUIT|EXIT|TEE|NOTEE|PAGER|NOPAGER|CHARSET|STATUS|REHASH|PROMPT|EDIT)(?:\s|$))/iu;
const unsupportedDefinitionCodes = new Set(['ROCKETBRAIN_DEPENDENCY', 'ROCKETBRAIN_DIFF_UNSUPPORTED', 'ROCKETBRAIN_OBJECT_SOURCE',
  'ROCKETBRAIN_PROGRAM', 'ROCKETBRAIN_SCHEMA_NAME', 'ROCKETBRAIN_SQL_POLICY']);

function supportedContext(row, shown) {
  const { sqlMode, charset, collation, databaseCollation } = row;
  if (typeof sqlMode !== 'string' || !/^[A-Z0-9_,]*$/u.test(sqlMode) || sqlMode.split(',').includes('ORACLE') ||
      !/^(?:utf8|utf8mb3|utf8mb4)$/u.test(charset) || !asciiName.test(collation) || !asciiName.test(databaseCollation)) {
    throw unsupported('Creation settings are outside the supported UTF-8 SQL/PSM profile.');
  }
  const sourceSettings = shown.settings;
  if (sourceSettings.sql_mode !== sqlMode || sourceSettings.character_set_client !== charset ||
      sourceSettings.collation_connection !== collation || sourceSettings['database collation'] !== databaseCollation) {
    throw unsupported('SHOW CREATE did not confirm the catalog creation settings.');
  }
  return { sqlMode, charset, collation, databaseCollation };
}

function target(tokens, index, database) {
  const first = tokens[index];
  if (!['word', 'identifier'].includes(first?.kind)) throw unsupported('An object identity could not be confirmed in SHOW CREATE.');
  if (tokens[index + 1]?.value !== '.') return { schema: database, name: name(first.value), next: index + 1 };
  const second = tokens[index + 2];
  if (!['word', 'identifier'].includes(second?.kind)) throw unsupported('A qualified object identity is incomplete.');
  return { schema: name(first.value), name: name(second.value), next: index + 3 };
}

function sourceParts(row, shown, database) {
  const sql = shown.source.trim().replace(/;$/u, '').trimEnd(), body = row.body.trim().replace(/;$/u, '').trimEnd();
  if (!body || !sql.endsWith(body) || Buffer.byteLength(sql) > maxSourceBytes || noClientDirectives.test(sql)) {
    throw unsupported('The complete bounded source could not be reconciled with the catalog or includes a client directive.');
  }
  const prefix = sql.slice(0, -body.length);
  if (!/\s$/u.test(prefix)) throw unsupported('The definition has an ambiguous body boundary.');
  const tokens = tokenize(prefix, false, { sqlMode: row.sqlMode.split(',').filter(Boolean), allowOptimizerHints: false });
  const keyword = tokens.findIndex(token => word(token, row.kind.toUpperCase()));
  if (!word(tokens[0], 'CREATE') || keyword < 1) throw unsupported('SHOW CREATE did not contain the expected definition type.');
  const identity = target(tokens, keyword + 1, database);
  if (identity.schema !== database || identity.name !== row.name) throw unsupported('SHOW CREATE did not identify the captured object.');
  return { sql, body, tokens, start: identity.next };
}

function parameterRows(rows, kind) {
  const first = kind === 'function' ? 1 : 0;
  if (rows.length > 32 + first || (first && (rows[0]?.[1] !== null || rows[0]?.[2] !== null)) ||
      rows.some(([ordinal], index) => Number(ordinal) !== index + 1 - first)) {
    throw unsupported('The visible routine signature is incomplete or exceeds 32 parameters.');
  }
  const parameters = rows.slice(first).map(([, mode, parameter, type]) => {
    if (!['IN', 'OUT', 'INOUT'].includes(mode) || typeof type !== 'string') throw unsupported('The routine parameter mode or type is unavailable.');
    return { mode, name: name(parameter), type: renderTypes.typeSql(type) };
  });
  return { parameters, returnType: first ? rows[0][3] : undefined };
}

function references(ast) {
  return [
    ...ast.targets.map(ref => ({ schema: ref.schema, name: ref.table, kind: 'relation' })),
    ...(ast.calls || []).map(ref => ({ schema: ref.schema, name: ref.table, kind: 'procedure' }))
  ];
}

function validateStaticCallSyntax(body, sqlMode) {
  const tokens = AST.programLex(body, { sqlMode });
  if (tokens.some((token, index) => token.kind === 'word' && token.value.toUpperCase() === 'CALL' && tokens[index + 2]?.value === '.')) {
    throw unsupported('Qualified CALL targets may resolve to a package or an external schema.');
  }
}

function triggerProgram(row, source, context, database) {
  const { tokens, start, body } = source;
  if (!word(tokens[start], row.timing) || !word(tokens[start + 1], row.event) || !word(tokens[start + 2], 'ON')) {
    throw unsupported('Trigger event and timing disagree between SHOW CREATE and the catalog.');
  }
  const subject = target(tokens, start + 3, database);
  const position = subject.next;
  if (subject.schema !== database || subject.name !== row.table || !word(tokens[position], 'FOR') ||
      !word(tokens[position + 1], 'EACH') || !word(tokens[position + 2], 'ROW')) {
    throw unsupported('The trigger does not name the observed table.');
  }
  const orderToken = tokens[position + 3];
  if (orderToken && (!(word(orderToken, 'FOLLOWS') || word(orderToken, 'PRECEDES')) ||
      !['word', 'identifier'].includes(tokens[position + 4]?.kind) || tokens.length !== position + 5)) {
    throw unsupported('The trigger has an unsupported action-order clause.');
  }
  validateStaticCallSyntax(body, context.sqlMode);
  const ast = AST.parse(body, database, row.table, { sqlMode: context.sqlMode, allowDynamic: false, allowRows: false });
  // Current ACTION_ORDER, not the original FOLLOWS/PRECEDES clause, determines replay order.
  const sql = orderToken ? source.sql.slice(0, orderToken.start).trimEnd() + '\n' + body : source.sql;
  return { sql, dependencies: [{ schema: database, name: row.table, kind: 'table' }, ...references(ast)] };
}

function routineProgram(row, source, context, signature, database) {
  const { tokens, start, sql, body } = source;
  if (tokens[start]?.value !== '(' || tokens.some(token => ['TYPE', 'ROW', 'DEFAULT', 'AGGREGATE'].some(value => word(token, value)))) {
    throw unsupported('Anchored types, defaults and aggregate routines are outside the restorable signature subset.');
  }
  if (row.kind === 'function') {
    scalarFunction({ ...row, ...signature }, body);
    return { sql, dependencies: [] };
  }
  if (shownBody(sql, database, row.name, context.sqlMode).trim() !== body) {
    throw unsupported('The full procedure header and body boundary could not be confirmed.');
  }
  validateStaticCallSyntax(body, context.sqlMode);
  const ast = AST.parseProgram(body, database, undefined, { kind: 'procedure', sqlMode: context.sqlMode,
    parameters: signature.parameters, allowRows: true, allowDynamic: false });
  return { sql, dependencies: references(ast) };
}

async function captureDdlPrograms(query, snapshot) {
  const { database, server, scope } = snapshot;
  const { dialect, version } = server;
  const base = { database, dialect, version };
  const read = async (sql, params) => (await query(sql, params)).rows;
  const serverVariable = dialect === 'mysql' ? '@@server_uuid' : '@@server_uid';
  const expectedIdentity = [[version, database, server.currentUser, server.sqlMode, server.serverUniqueId]];
  async function assertIdentity() {
    const current = await read('SELECT VERSION(),DATABASE(),CURRENT_USER(),@@SESSION.sql_mode,' + serverVariable);
    if (!equal(current, expectedIdentity)) throw Error('The server, account or connection context changed during schema DDL capture.');
  }
  const conditions = scope.kind === 'selected-tables' ? ' AND EVENT_OBJECT_TABLE IN (' + scope.tables.map(() => '?').join(',') + ')' : '';
  const triggers = () => read('SELECT TRIGGER_NAME,EVENT_OBJECT_TABLE,ACTION_TIMING,EVENT_MANIPULATION,ACTION_ORDER,' +
    'ACTION_STATEMENT,SQL_MODE,CHARACTER_SET_CLIENT,COLLATION_CONNECTION,DATABASE_COLLATION FROM information_schema.TRIGGERS ' +
    'WHERE BINARY TRIGGER_SCHEMA=BINARY ?' + conditions + ' ORDER BY BINARY EVENT_OBJECT_TABLE,ACTION_TIMING,EVENT_MANIPULATION,ACTION_ORDER LIMIT 101',
  [database, ...scope.tables]);
  const routines = () => read('SELECT ROUTINE_NAME,ROUTINE_TYPE,ROUTINE_DEFINITION,SQL_MODE,CHARACTER_SET_CLIENT,COLLATION_CONNECTION,' +
    'DATABASE_COLLATION,IS_DETERMINISTIC,SQL_DATA_ACCESS FROM information_schema.ROUTINES ' +
    "WHERE BINARY ROUTINE_SCHEMA=BINARY ? AND ROUTINE_TYPE IN ('PROCEDURE','FUNCTION') ORDER BY ROUTINE_TYPE,BINARY ROUTINE_NAME LIMIT 101", [database]);
  const signatures = row => read('SELECT ORDINAL_POSITION,PARAMETER_MODE,PARAMETER_NAME,DTD_IDENTIFIER FROM information_schema.PARAMETERS ' +
    'WHERE BINARY SPECIFIC_SCHEMA=BINARY ? AND BINARY SPECIFIC_NAME=BINARY ? AND ROUTINE_TYPE=? ORDER BY ORDINAL_POSITION LIMIT 34',
  [database, row.name, row.kind.toUpperCase()]);
  await assertIdentity();
  const [routineRows, triggerRows] = await Promise.all([routines(), triggers()]);
  if (routineRows.length + triggerRows.length > maxPrograms) {
    return { candidates: [], omitted: [], unavailable: true, observation: hash('over-limit') };
  }
  const items = [
    ...routineRows.filter(([label]) => !reserved.test(label)).map(([label, kind, body, sqlMode, charset, collation, databaseCollation, deterministic, dataAccess]) =>
      ({ name: name(label), kind: kind.toLowerCase(), body, sqlMode, charset, collation, databaseCollation, deterministic, dataAccess })),
    ...triggerRows.filter(([label]) => !reserved.test(label)).map(([label, table, timing, event, actionOrder, body, sqlMode, charset, collation, databaseCollation]) =>
      ({ name: name(label), table: name(table), kind: 'trigger', timing, event, actionOrder: Number(actionOrder), body, sqlMode, charset, collation, databaseCollation }))
  ];
  const candidates = [], omitted = [], exact = [];
  let bytes = 0;
  function omit({ kind, name, table, timing, event }, reason) { omitted.push({ kind, name, table, timing, event, reason }); }
  for (const row of items) {
    if (typeof row.body !== 'string') {
      omit(row, 'The current account cannot see the complete stored-program definition.');
      continue;
    }
    const object = { schema: database, name: row.name, kind: row.kind };
    let shown, signature;
    try {
      shown = await loadSource(query, base, object);
      if (row.kind !== 'trigger') signature = await signatures(row);
    } catch (cause) {
      if (cause.code?.startsWith('ROCKETBRAIN_OBJECT_SOURCE_')) {
        omit(row, cause.message);
        continue;
      }
      throw cause;
    }
    bytes += Buffer.byteLength(shown.source);
    if (bytes > maxTotalBytes) return { candidates: [], omitted: [], unavailable: true, observation: hash('over-size') };
    exact.push({ object, shown, signature });
    try {
      const context = supportedContext(row, shown), source = sourceParts(row, shown, database);
      const program = row.kind === 'trigger' ? triggerProgram(row, source, context, database)
        : routineProgram(row, source, context, parameterRows(signature, row.kind), database);
      candidates.push({ ...object, ...program, context, table: row.table, timing: row.timing, event: row.event, actionOrder: row.actionOrder });
    } catch (cause) {
      if (cause.code !== 'ROCKETBRAIN_DDL_PROGRAM_UNSUPPORTED' && !unsupportedDefinitionCodes.has(cause.code)) throw cause;
      omit(row, cause.code === 'ROCKETBRAIN_DDL_PROGRAM_UNSUPPORTED' ? cause.message
        : 'The stored program uses a definition, expression or dependency outside the supported static subset.');
    }
  }
  for (const entry of exact) {
    const latest = await loadSource(query, base, entry.object);
    if (!equal(latest, entry.shown) || entry.signature && !equal(entry.signature, await signatures(entry.object))) {
      throw Error('A stored-program definition changed during schema DDL capture. Prepare the export again.');
    }
  }
  const [latestRoutines, latestTriggers] = await Promise.all([routines(), triggers()]);
  if (!equal(routineRows, latestRoutines) || !equal(triggerRows, latestTriggers)) {
    throw Error('The visible stored-program inventory or trigger action order changed during capture. Prepare the export again.');
  }
  await assertIdentity();
  return { candidates, omitted, unavailable: false, observation: hash([routineRows, triggerRows, exact]) };
}

module.exports = { captureDdlPrograms, programId };
