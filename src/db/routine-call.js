'use strict';

const { createHash } = require('node:crypto');
const { identifier } = require('./schema-rename');
const { loadSource, listNames } = require('./object-source');
const { typedParameter, LIMITS } = require('./sql-script');
const { typeKind } = require('./parameter-inference');
const { inspectPackage } = require('./routine-package');

const maxParameters = 32;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const quote = value => '`' + value.replaceAll('`', '``') + '`';
const fail = (code, message) => Object.assign(Error(message), { code: 'ROCKETBRAIN_ROUTINE_' + code });

function targetOf(target, database) {
  const schema = identifier(target?.schema ?? database, { table: true });
  const name = identifier(target?.name);
  if (schema === database && ['package-procedure', 'package-function'].includes(target?.kind)) {
    return { schema, name: identifier(name, { table: true }), kind: target.kind, package: identifier(target.package, { table: true }) };
  }
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
  if (object.kind.startsWith('package-')) {
    const { spec, body, members, syntax } = await inspectPackage(query, context,
      { schema: object.schema, name: object.package, kind: 'package' });
    const kind = object.kind.slice('package-'.length);
    const member = members.find(item => item.name === object.name && item.kind === kind && item.supported);
    if (!member) throw fail('PACKAGE_TARGET', 'Choose an unambiguous public ' + kind + ' with matching scalar signatures in the specification and body.');
    const packageSources = [{ kind: 'Specification', source: spec.source, settings: spec.settings },
      { kind: 'Body', source: body.source, settings: body.settings }];
    const fingerprint = digest([object, context.dialect, context.version, ids[0][1], accounts[0], packageSources, member.parameters, member.returns]);
    const callee = [object.schema, object.package, object.name].map(quote).join('.');
    const invocation = kind === 'function' ? packageFunctionSql(callee, fingerprint, member.parameters)
      : { sql: callSql(callee, fingerprint, member.parameters) };
    return { object, fingerprint, account: accounts[0][0], role: accounts[0][1], dialect: context.dialect,
      version: context.version, packageSources, packageSyntax: syntax, parameters: member.parameters,
      ...(member.returns && { returns: member.returns }), ...invocation };
  }
  if (context.dialect === 'mariadb' && accounts[0][7].split(',').includes('ORACLE')) {
    throw fail('MODE', 'Use a standard SQL mode for a reviewed standalone procedure call.');
  }
  const definition = await loadSource(query, context, object);
  if (context.dialect === 'mariadb' && String(definition.settings.sql_mode || '').split(',').includes('ORACLE')) {
    throw fail('MODE', 'Stored procedures defined in Oracle compatibility mode require a separate invocation workflow.');
  }
  const { rows } = await query("SELECT ORDINAL_POSITION,PARAMETER_NAME,PARAMETER_MODE,DTD_IDENTIFIER,CHARACTER_SET_NAME,COLLATION_NAME FROM information_schema.PARAMETERS WHERE BINARY SPECIFIC_SCHEMA=BINARY ? AND BINARY SPECIFIC_NAME=BINARY ? AND ROUTINE_TYPE='PROCEDURE' ORDER BY ORDINAL_POSITION LIMIT " + (maxParameters + 1), [object.schema, object.name]);
  if (rows.length > maxParameters) throw fail('LIMIT', 'Use a procedure with at most 32 parameters.');
  const names = new Set();
  const parameters = rows.map(([ordinal, rawName, mode, type], index) => {
    const name = identifier(rawName);
    const kind = typeof type === 'string' && type.length <= 2048 && typeKind(type);
    if (Number(ordinal) !== index + 1 || !['IN', 'OUT', 'INOUT'].includes(mode) || !kind || names.has(name.toLowerCase())) {
      throw fail('PARAMETER', 'The server parameter signature contains unsupported or ambiguous parameters.');
    }
    names.add(name.toLowerCase());
    return { ordinal: index + 1, name, mode, type, kind };
  });
  const fingerprint = digest([object, context.dialect, context.version, ids[0][1], accounts[0], definition.source, definition.settings, rows]);
  // On MariaDB a two-part CALL can resolve a package member. The session already pins the exact database.
  const callee = context.dialect === 'mariadb' ? quote(object.name) : quote(object.schema) + '.' + quote(object.name);
  const sql = callSql(callee, fingerprint, parameters);
  return { object, fingerprint, account: accounts[0][0], role: accounts[0][1], dialect: context.dialect,
    version: context.version, source: definition.source, settings: definition.settings, parameters, sql, callee };
}

function invocationSql(callee, fingerprint, parameters) {
  return callee + '(' + parameters.map(parameter => parameter.mode === 'IN' ? '?' : variable(fingerprint, parameter)).join(', ') + ')';
}

function callSql(callee, fingerprint, parameters) {
  return 'CALL ' + invocationSql(callee, fingerprint, parameters);
}

function packageFunctionSql(callee, fingerprint, parameters) {
  const invocation = invocationSql(callee, fingerprint, parameters);
  if (parameters.every(parameter => parameter.mode === 'IN')) return { sql: 'SELECT ' + invocation + ' AS return_value' };
  const returned = variable(fingerprint, { ordinal: 0 });
  return { sql: 'SET ' + returned + ' = ' + invocation, returnSql: 'SELECT ' + returned + ' AS return_value' };
}

function bindProcedure(parameters, inputs) {
  const declaredInputs = parameters.filter(parameter => parameter.mode !== 'OUT');
  if (!Array.isArray(inputs) || inputs.length !== declaredInputs.length || Object.keys(inputs).length !== inputs.length) {
    throw fail('PARAMETER', 'Supply one typed value for each listed input parameter.');
  }
  let bytes = 0;
  const typed = declaredInputs.map(({ kind, ordinal }, index) => {
    const entry = Object.getOwnPropertyDescriptor(inputs, index);
    if (!entry || entry.get || entry.set) throw fail('PARAMETER', 'Supply one typed value for each listed input parameter.');
    const value = typedParameter(entry.value);
    if (value.kind !== 'null' && value.kind !== kind) throw fail('PARAMETER', 'Parameter ' + ordinal + ' requires ' + kind + ' or SQL NULL.');
    bytes += value.bytes;
    return value;
  });
  if (bytes > LIMITS.parameterBytes) throw fail('LIMIT', 'Combined procedure input exceeds 1 MiB.');
  return { values: typed.map(value => value.bound), kinds: typed.map(value => value.kind) };
}

function variable(fingerprint, { ordinal }) {
  return '@rb_proc_' + fingerprint.slice(0, 24) + '_' + ordinal;
}

function sessionArguments(procedure, inputs) {
  return sessionArgumentValues(procedure, bindProcedure(procedure.parameters, inputs).values, procedure.fingerprint);
}

function sessionArgumentValues(procedure, values, execution) {
  const callValues = [], variableValues = [], assignments = [], outputs = [];
  let inputIndex = 0;
  for (const parameter of procedure.parameters) {
    if (parameter.mode === 'IN') callValues.push(values[inputIndex++]);
    else {
      const name = variable(execution, parameter);
      assignments.push(name + ' = ' + (parameter.mode === 'INOUT' ? '?' : 'NULL'));
      if (parameter.mode === 'INOUT') variableValues.push(values[inputIndex++]);
      outputs.push({ ...parameter, variable: name });
    }
  }
  return { callValues, variableValues, initializeSql: assignments.length ? 'SET ' + assignments.join(', ') : undefined, outputs };
}

function scriptSessionArguments(procedure, values, execution) {
  const prepared = sessionArgumentValues(procedure, values, execution);
  return { ...prepared, sql: callSql(procedure.callee, execution, procedure.parameters),
    clearSql: prepared.outputs.length ? 'SET ' + prepared.outputs.map(item => item.variable + ' = NULL').join(', ') : undefined };
}

async function readProcedureOutputs(query, outputs) {
  if (!outputs.length) return [];
  const { rows } = await query('SELECT ' + outputs.map(item => item.variable).join(', '));
  if (rows.length !== 1 || rows[0].length !== outputs.length) throw fail('OUTPUT', 'The procedure output parameters could not be read.');
  return outputs.map(({ variable: _, ...parameter }, index) => ({ ...parameter, value: exactOutput(parameter.kind, rows[0][index]) }));
}

function exactOutput(kind, value, label = 'procedure output') {
  if ((kind !== 'integer' && kind !== 'decimal') || value === null) return value;
  const pattern = kind === 'integer' ? /^-?\d+$/u : /^-?\d+(?:\.\d+)?$/u;
  if (!(typeof value === 'string' ? pattern.test(value) : Number.isSafeInteger(value))) {
    throw fail('OUTPUT', 'The database did not return an exact ' + label + ' number.');
  }
  return String(value);
}

function procedureOutputGrid(parameters) {
  const rows = parameters.map(({ label, name, mode, type, value }) => [label || name, mode, type, value]);
  return rows.length ? { columns: ['Parameter', 'Mode', 'SQL type', 'Value'], rows,
    rowCount: rows.length, affectedRows: 0, durationMs: 0, truncated: false } : undefined;
}

module.exports = { listProcedures, observeProcedure, bindProcedure, sessionArguments, scriptSessionArguments,
  readProcedureOutputs, procedureOutputGrid, exactOutput, fail };
