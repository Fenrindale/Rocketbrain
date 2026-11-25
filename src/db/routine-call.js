'use strict';

const { createHash } = require('node:crypto');
const { identifier } = require('./schema-rename');
const { loadSource, listNames } = require('./object-source');
const { typedParameter, LIMITS } = require('./sql-script');
const { typeKind } = require('./parameter-inference');

const maxParameters = 32;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const quote = value => '`' + value.replaceAll('`', '``') + '`';
const fail = (code, message) => Object.assign(Error(message), { code: 'ROCKETBRAIN_ROUTINE_' + code });

function targetOf(target, database) {
  const schema = identifier(target?.schema ?? database, { table: true });
  const name = identifier(target?.name);
  if (schema !== database || target?.kind !== 'procedure') throw fail('TARGET', 'Choose a standalone procedure in the connected database.');
  return { schema, name, kind: 'procedure' };
}

function listProcedures(query, context, { prefix, after } = {}) {
  return listNames(query, context, { kind: 'procedure', schema: context.database, prefix, after });
}

async function observeProcedure(query, context, target) {
  const object = targetOf(target, context.database);
  const uidField = context.dialect === 'mariadb' ? 'server_uid' : 'server_uuid';
  const { rows: ids } = await query("SHOW GLOBAL VARIABLES WHERE Variable_name = '" + uidField + "'");
  const { rows: accounts } = await query('SELECT CURRENT_USER(), CURRENT_ROLE(), @@hostname, @@port, @@server_id, @@session.time_zone, @@session.collation_connection, @@session.sql_mode');
  if (ids.length !== 1 || typeof ids[0][1] !== 'string' || !ids[0][1] || accounts.length !== 1 ||
    accounts[0].length !== 8 || !accounts[0][0] || !accounts[0][2] || typeof accounts[0][7] !== 'string') {
    throw fail('ACCOUNT', 'The physical server and acting database account could not be confirmed.');
  }
  if (context.dialect === 'mariadb' && accounts[0][7].split(',').includes('ORACLE')) {
    throw fail('MODE', 'Use standard SQL mode and a standalone procedure for a reviewed call.');
  }
  const definition = await loadSource(query, context, object);
  if (context.dialect === 'mariadb' && String(definition.settings.sql_mode || '').split(',').includes('ORACLE')) {
    throw fail('MODE', 'Stored procedures defined in Oracle compatibility mode require a separate invocation workflow.');
  }
  const { rows } = await query("SELECT ORDINAL_POSITION,PARAMETER_NAME,PARAMETER_MODE,DTD_IDENTIFIER,CHARACTER_SET_NAME,COLLATION_NAME FROM information_schema.PARAMETERS WHERE BINARY SPECIFIC_SCHEMA=BINARY ? AND BINARY SPECIFIC_NAME=BINARY ? AND ROUTINE_TYPE='PROCEDURE' ORDER BY ORDINAL_POSITION LIMIT " + (maxParameters + 1), [object.schema, object.name]);
  if (rows.length > maxParameters) throw fail('LIMIT', 'Use a procedure with at most 32 input parameters.');
  const names = new Set();
  const parameters = rows.map(([ordinal, rawName, mode, type], index) => {
    if (mode !== 'IN') throw fail('PARAMETER', 'This invocation supports IN parameters. OUT and INOUT require a different workflow.');
    const name = identifier(rawName);
    const kind = typeof type === 'string' && type.length <= 2048 && typeKind(type);
    if (Number(ordinal) !== index + 1 || !kind || names.has(name.toLowerCase())) {
      throw fail('PARAMETER', 'The server parameter signature contains unsupported or ambiguous inputs.');
    }
    names.add(name.toLowerCase());
    return { ordinal: index + 1, name, mode, type, kind };
  });
  const fingerprint = digest([object, context.dialect, context.version, ids[0][1], accounts[0], definition.source, definition.settings, rows]);
  // On MariaDB a two-part CALL can resolve a package member. The session already pins the exact database.
  const callee = context.dialect === 'mariadb' ? quote(object.name) : quote(object.schema) + '.' + quote(object.name);
  const sql = 'CALL ' + callee + '(' + parameters.map(() => '?').join(', ') + ')';
  return { object, fingerprint, account: accounts[0][0], role: accounts[0][1], dialect: context.dialect,
    version: context.version, source: definition.source, settings: definition.settings, parameters, sql };
}

function bindProcedure(parameters, inputs) {
  if (!Array.isArray(inputs) || inputs.length !== parameters.length || Object.keys(inputs).length !== inputs.length) {
    throw fail('PARAMETER', 'Supply one typed value for each listed input parameter.');
  }
  let bytes = 0;
  const typed = parameters.map(({ kind }, index) => {
    const entry = Object.getOwnPropertyDescriptor(inputs, index);
    if (!entry || entry.get || entry.set) throw fail('PARAMETER', 'Supply one typed value for each listed input parameter.');
    const value = typedParameter(entry.value);
    if (value.kind !== 'null' && value.kind !== kind) throw fail('PARAMETER', 'Parameter ' + (index + 1) + ' requires ' + kind + ' or SQL NULL.');
    bytes += value.bytes;
    return value;
  });
  if (bytes > LIMITS.parameterBytes) throw fail('LIMIT', 'Combined procedure input exceeds 1 MiB.');
  return { values: typed.map(value => value.bound), kinds: typed.map(value => value.kind) };
}

module.exports = { listProcedures, observeProcedure, bindProcedure, fail };
