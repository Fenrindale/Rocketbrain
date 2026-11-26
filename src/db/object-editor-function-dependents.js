'use strict';

const { createHash } = require('node:crypto');
const { lex } = require('./schema-trigger-ast');
const { name, q } = require('./schema-designer-ddl');

const fail = message => Object.assign(Error(message), { code: 'ROCKETBRAIN_OBJECT_SOURCE' });
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const dependentLimit = 8;
const grantLimit = 32;

function viewProjection(source, definition) {
  const tokens = lex(source, { sqlMode: definition.sqlMode });
  let offset = 0;
  const at = value => tokens[offset]?.value?.toUpperCase() === value;
  const take = value => {
    if (!at(value)) throw fail('The dependent view needs an exact single-projection calling expression.');
    offset++;
  };
  const identifier = () => {
    if (!tokens[offset]?.name) throw fail('The dependent view requires exact identifiers and argument expressions.');
    return name(tokens[offset++].name);
  };
  const qualified = (minimum, maximum) => {
    const result = [identifier()];
    while (result.length < maximum && at('.')) {
      take('.');
      result.push(identifier());
    }
    if (result.length < minimum) throw fail('A dependent view has an unqualified target.');
    return result;
  };
  take('SELECT');
  const [schema, routine] = qualified(2, 2);
  if (schema !== definition.schema || routine !== definition.name) throw fail('A dependent view does not call the exact selected function.');
  take('(');
  const arguments_ = [];
  for (let i = 0; i < definition.parameters.length; i++) {
    if (i) take(',');
    const minus = at('-') && tokens[offset + 1]?.kind === 'number';
    if (minus) offset++;
    if (tokens[offset]?.kind === 'number') arguments_.push({ number: (minus ? '-' : '') + tokens[offset++].value });
    else if (tokens[offset]?.kind === 'word' && at('NULL')) {
      offset++;
      arguments_.push({ null: true });
    } else arguments_.push({ column: qualified(1, 3) });
  }
  take(')');
  take('AS');
  const output = identifier();
  let table = null, alias = null;
  if (at('FROM')) {
    take('FROM');
    const tableParts = qualified(1, 2);
    const [tableSchema, tableName] = tableParts.length === 1 ? [schema, tableParts[0]] : tableParts;
    if (tableSchema !== schema) throw fail('Cross-schema dependent view inputs require a separate review.');
    table = tableName;
    if (at('AS')) {
      take('AS');
      alias = identifier();
    }
  }
  const columns = arguments_.filter(argument => argument.column).map(argument => argument.column);
  if (offset !== tokens.length || columns.some(parts => !table ||
      parts.length === 2 && parts[0] !== (alias || table) ||
      parts.length === 3 && (parts[0] !== schema || parts[1] !== table || alias))) {
    throw fail('The dependent view has an unresolved input or extra SQL.');
  }
  const operands = arguments_.map(argument => argument.column ? { column: argument.column.at(-1) } : argument);
  return { output, table, alias, operands, columns: [...new Set(columns.map(parts => parts.at(-1)))] };
}

async function inspectInput(read, schema, projection) {
  if (!projection.table) return null;
  const values = [schema, projection.table];
  const rows = await read('SELECT TABLE_TYPE FROM information_schema.TABLES WHERE BINARY TABLE_SCHEMA=BINARY ? AND BINARY TABLE_NAME=BINARY ?', values);
  if (rows.length !== 1 || rows[0][0] !== 'BASE TABLE') throw fail('A dependent view input must be an exact same-schema base table.');
  const fields = await read('SELECT COLUMN_NAME,DATA_TYPE FROM information_schema.COLUMNS WHERE BINARY TABLE_SCHEMA=BINARY ? ' +
    'AND BINARY TABLE_NAME=BINARY ? ORDER BY ORDINAL_POSITION LIMIT 257', values);
  if (fields.length > 256 || projection.columns.some(column => !fields.some(([field, type]) =>
    field === column && /^(tinyint|smallint|mediumint|int|bigint|decimal|numeric)$/iu.test(type)))) {
    throw fail('The dependent view requires observed ordinary numeric base-table inputs.');
  }
  const definition = await read('SHOW CREATE TABLE ' + q(schema) + '.' + q(projection.table));
  const sql = definition[0]?.[1];
  if (definition.length !== 1 || typeof sql !== 'string' || !sql || Buffer.byteLength(sql) > 128 * 1024) {
    throw fail('The complete dependent view input definition is unavailable.');
  }
  const structural = sql.replace(/(\n\) ENGINE=[A-Za-z0-9_]+) AUTO_INCREMENT=\d+(?=\s|$)/u, '$1');
  const grants = await observedGrants(read, values);
  return { table: projection.table, fingerprint: digest([fields, structural, grants]),
    tableGrants: grants.tables.length, columnGrants: grants.columns.length };
}

async function observedGrants(read, values) {
  const tables = await read('SELECT Host,User,Table_priv,Column_priv,Grantor FROM mysql.tables_priv ' +
    'WHERE BINARY Db=BINARY ? AND BINARY Table_name=BINARY ? ORDER BY BINARY Host,BINARY User LIMIT ' + (grantLimit + 1), values);
  const columns = await read('SELECT Host,User,Column_name,Column_priv FROM mysql.columns_priv ' +
    'WHERE BINARY Db=BINARY ? AND BINARY Table_name=BINARY ? ORDER BY BINARY Host,BINARY User,BINARY Column_name LIMIT ' + (grantLimit + 1), values);
  if (tables.length > grantLimit || columns.length > grantLimit) throw fail('Dependent view or input grant inventory exceeds the review limit.');
  return { tables, columns };
}

async function inspectDependentView(read, schema, object, source, definition, { missingRoutine = false } = {}) {
  if (schema !== definition.schema) throw fail('A cross-schema dependent view requires separate deployment.');
  name(object);
  const projection = viewProjection(source, definition);
  const values = [schema, object];
  const metadata = await read('SELECT VIEW_DEFINITION,CHECK_OPTION,SECURITY_TYPE,DEFINER,CHARACTER_SET_CLIENT,COLLATION_CONNECTION ' +
    'FROM information_schema.VIEWS WHERE BINARY TABLE_SCHEMA=BINARY ? AND BINARY TABLE_NAME=BINARY ?', values);
  if (metadata.length !== 1 || metadata[0][0] !== source || metadata[0][1] !== 'NONE' ||
      metadata[0][2] !== 'INVOKER' || metadata[0][3] !== definition.definer) {
    throw fail('Dependent view review requires the same observed owner, static source, and SQL SECURITY INVOKER without a write check policy.');
  }
  const shown = await read('SHOW CREATE VIEW ' + q(schema) + '.' + q(object));
  const sql = shown[0]?.[1];
  if (shown.length !== 1 || typeof sql !== 'string' || !sql || Buffer.byteLength(sql) > 128 * 1024) {
    throw fail('The complete dependent view definition is unavailable.');
  }
  const boundary = /\sAS\s+(?=SELECT\s)/iu.exec(sql);
  if (!boundary || digest(viewProjection(sql.slice(boundary.index + boundary[0].length), definition)) !== digest(projection)) {
    throw fail('SHOW CREATE does not confirm the same dependent view projection.');
  }
  const grants = await observedGrants(read, values);
  const input = await inspectInput(read, schema, projection);
  // SHOW CREATE may add a base-table schema qualifier while the routine is absent.
  const fingerprint = digest([metadata[0].slice(1), shown[0][0], sql.slice(0, boundary.index),
    shown[0].slice(2), projection, grants, input]);
  let outputFingerprint = null;
  if (!missingRoutine) {
    const output = await read('SELECT COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,CHARACTER_SET_NAME,COLLATION_NAME FROM information_schema.COLUMNS ' +
      'WHERE BINARY TABLE_SCHEMA=BINARY ? AND BINARY TABLE_NAME=BINARY ? ORDER BY ORDINAL_POSITION LIMIT 2', values);
    if (output.length !== 1 || output[0][0] !== projection.output) throw fail('The dependent view output does not match its observed projection.');
    outputFingerprint = digest(output);
  }
  return { schema, name: object, output: projection.output, input: input?.table ?? null, tableGrants: grants.tables.length,
    columnGrants: grants.columns.length, inputTableGrants: input?.tableGrants ?? 0,
    inputColumnGrants: input?.columnGrants ?? 0, fingerprint, outputFingerprint };
}

function validateViews(entries, schema) {
  if (!Array.isArray(entries) || !entries.length || entries.length > dependentLimit) throw fail('The retained dependent view inventory changed.');
  for (const entry of entries) {
    if (entry.schema !== schema || ![entry.fingerprint, entry.outputFingerprint].every(hash => /^[a-f0-9]{64}$/u.test(hash)) ||
        ![entry.tableGrants, entry.columnGrants, entry.inputTableGrants, entry.inputColumnGrants]
          .every(count => Number.isInteger(count) && count >= 0 && count <= grantLimit)) {
      throw fail('The retained dependent view identity or grants changed.');
    }
    name(entry.name);
    name(entry.output);
    if (entry.input !== null) name(entry.input);
  }
}

module.exports = { dependentLimit, inspectDependentView, validateViews, viewProjection };
