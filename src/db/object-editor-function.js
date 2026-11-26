'use strict';

const { createHash } = require('node:crypto');
const { loadSource } = require('./object-source');
const D = require('./schema-designer-ddl');
const A = require('./schema-trigger-ast');
const G = require('./schema-dependency-graph');
const Views = require('./object-editor-function-dependents');
const { bodyMentions } = require('./schema-programs');
const { tokenize } = require('./sql-policy');

const fail = message => Object.assign(Error(message), { code: 'ROCKETBRAIN_OBJECT_SOURCE' });
const numeric = /^(?:(?:TINYINT|SMALLINT|MEDIUMINT|INT|INTEGER|BIGINT)(?:\(\d{1,3}\))?|(?:DECIMAL|NUMERIC)\(\d{1,2},\d{1,2}\))(?: UNSIGNED)?$/iu;
const operators = new Set(['(', ')', ',', '+', '-', '*', '/', '%', '=', '<', '>', '!']);
const words = new Set(['NULL', 'TRUE', 'FALSE', 'DIV', 'MOD', 'AND', 'OR', 'XOR', 'NOT', 'IS', 'BETWEEN']);
const functions = new Set(['ABS', 'CEIL', 'CEILING', 'COALESCE', 'FLOOR', 'IF', 'IFNULL', 'MOD', 'NULLIF', 'ROUND', 'SIGN']);
const systemSchemas = "('mysql','sys','information_schema','performance_schema')";

function numericType(type) {
  if (typeof type !== 'string' || !numeric.test(type)) throw fail('The reviewed scalar function requires bounded integer or DECIMAL types.');
  return type.toUpperCase();
}

function scalarFunction(input, source) {
  if (input.deterministic !== 'YES' || input.dataAccess !== 'NO SQL' || /(?:^|,)ORACLE(?:,|$)/u.test(input.sqlMode) ||
      !Array.isArray(input.parameters) || input.parameters.length > 32) {
    throw fail('Choose a deterministic NO SQL function with at most 32 ordinary numeric inputs.');
  }
  const parameters = input.parameters.map(parameter => {
    if (parameter.mode !== 'IN') throw fail('The reviewed scalar function supports IN parameters.');
    return { mode: 'IN', name: D.name(parameter.name), type: numericType(parameter.type) };
  });
  const names = new Set(parameters.map(parameter => parameter.name.toLowerCase()));
  if (names.size !== parameters.length) throw fail('The function parameter names must be distinct.');
  const text = source.trim().replace(/;$/u, '').trimEnd();
  const tokens = A.lex(text, { sqlMode: input.sqlMode });
  if (tokens[0]?.kind !== 'word' || tokens[0].value.toUpperCase() !== 'RETURN' || tokens.length < 2) {
    throw fail('Use a single RETURN expression over parameters and numeric constants.');
  }
  const expression = tokens.slice(1);
  A.expression(expression);
  for (const [index, token] of expression.entries()) {
    if (token.kind === 'number' || token.kind === 'punct' && operators.has(token.value)) continue;
    const next = expression[index + 1];
    if (token.name && next?.value === '(') {
      if (token.kind === 'word' && token.end === next.start && functions.has(token.value.toUpperCase())) continue;
      throw fail('The function has a callable dependency outside the supported built-in arithmetic.');
    }
    if (token.kind === 'word' && words.has(token.value.toUpperCase()) || token.name && names.has(token.name.toLowerCase())) continue;
    throw fail('The function has an unsupported dependency or expression. Use numeric constants, declared inputs and supported built-in arithmetic.');
  }
  return { parameters, returnType: numericType(input.returnType), source: text, targets: [],
    deterministic: 'YES', dataAccess: 'NO SQL', comment: input.comment || '' };
}

async function readFunction(query, schema, name) {
  const read = async (sql, values) => (await query(sql, values)).rows;
  const where = "BINARY ROUTINE_SCHEMA=BINARY ? AND BINARY ROUTINE_NAME=BINARY ? AND ROUTINE_TYPE='FUNCTION'";
  const rows = await read('SELECT ROUTINE_DEFINITION,IS_DETERMINISTIC,SQL_DATA_ACCESS,SECURITY_TYPE,DEFINER,SQL_MODE,ROUTINE_COMMENT,' +
    'CHARACTER_SET_CLIENT,COLLATION_CONNECTION,DATABASE_COLLATION,DTD_IDENTIFIER FROM information_schema.ROUTINES WHERE ' + where, [schema, name]);
  if (rows.length !== 1 || typeof rows[0][0] !== 'string') throw fail('The exact visible function definition is required.');
  const [source, deterministic, dataAccess, security, definer, sqlMode, comment, charset, collation, databaseCollation, returns] = rows[0];
  const parameters = await read('SELECT ORDINAL_POSITION,PARAMETER_MODE,PARAMETER_NAME,DTD_IDENTIFIER,CHARACTER_SET_NAME,COLLATION_NAME ' +
    'FROM information_schema.PARAMETERS WHERE BINARY SPECIFIC_SCHEMA=BINARY ? AND BINARY SPECIFIC_NAME=BINARY ? ' +
    "AND ROUTINE_TYPE='FUNCTION' ORDER BY ORDINAL_POSITION LIMIT 34", [schema, name]);
  if (!parameters.length || parameters.length > 33 || parameters[0][1] !== null || parameters[0][2] !== null ||
      parameters[0][3]?.toUpperCase() !== returns?.toUpperCase() ||
      parameters.some(([position, , , , characterSet, fieldCollation], i) => Number(position) !== i || characterSet !== null || fieldCollation !== null)) {
    throw fail('The function signature is unsupported or incomplete.');
  }
  const shown = await loadSource(query, { dialect: 'mysql' }, { kind: 'function', schema, name });
  const ddl = shown.source.trimEnd(), body = source.trim();
  if (!body || !ddl.endsWith(body) || shown.settings.sql_mode !== sqlMode ||
      shown.settings.character_set_client !== charset || shown.settings.collation_connection !== collation ||
      shown.settings['database collation'] !== databaseCollation ||
      tokenize(ddl.slice(0, -body.length), false, { sqlMode: sqlMode.split(',') }).some(token => token.kind === 'word' &&
        ['DEFAULT', 'AGGREGATE', 'ORACLE'].includes(token.upper))) {
    throw fail('SHOW CREATE did not confirm the observed function signature, body and creation settings.');
  }
  return { kind: 'function', schema, name, source, deterministic, dataAccess, security, definer, sqlMode, comment, charset,
    collation, databaseCollation, returnType: returns,
    parameters: parameters.slice(1).map(([, mode, name, type]) => ({ mode, name, type })) };
}

function eventVisible(grants, schemas) {
  const visibility = new Set();
  for (const [grant] of grants) {
    const match = /^GRANT (.+) ON (\*|`(?:[^`]|``)+`)\.\* TO /iu.exec(String(grant));
    if (match?.[1].split(',').some(privilege => ['EVENT', 'ALL PRIVILEGES'].includes(privilege.trim().toUpperCase()))) {
      visibility.add(match[2] === '*' ? '*' : match[2].slice(1, -1).replaceAll('``', '`'));
    }
  }
  return visibility.has('*') || schemas.every(schema => visibility.has(schema));
}

async function inspectFunctionDependents(read, definition, { missingRoutine = false } = {}) {
  const grants = await read('SHOW GRANTS');
  await G.grants(async () => grants, definition.schema);
  const schemas = await read('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE BINARY SCHEMA_NAME NOT IN ' + systemSchemas +
    ' ORDER BY BINARY SCHEMA_NAME LIMIT 33');
  if (!schemas.some(([schema]) => schema === definition.schema) || schemas.length > 32 || !eventVisible(grants, schemas.map(([name]) => name))) {
    throw fail('Function deployment requires verified EVENT visibility on all application schemas within the 32-schema inspection limit.');
  }
  const catalogs = [
    ['view', 'TABLE_SCHEMA', 'TABLE_NAME', 'VIEW_DEFINITION', 'VIEWS'],
    ['routine', 'ROUTINE_SCHEMA', 'ROUTINE_NAME', 'ROUTINE_DEFINITION', 'ROUTINES', 'ROUTINE_TYPE'],
    ['trigger', 'TRIGGER_SCHEMA', 'TRIGGER_NAME', 'ACTION_STATEMENT', 'TRIGGERS'],
    ['event', 'EVENT_SCHEMA', 'EVENT_NAME', 'EVENT_DEFINITION', 'EVENTS']
  ];
  const observed = [], dependentViews = [];
  for (const [kind, schema, name, source, table, routineType] of catalogs) {
    const rows = await read('SELECT ' + [schema, name, source, routineType].filter(Boolean).join(',') + ' FROM information_schema.' + table +
      ' WHERE BINARY ' + schema + ' NOT IN ' + systemSchemas + ' ORDER BY BINARY ' + schema + ',BINARY ' + name +
      (routineType ? ',' + routineType : '') + ' LIMIT 257');
    if (observed.length + rows.length > 256) throw fail('Function dependency inspection exceeds 256 application objects.');
    for (const row of rows) {
      const [schemaName, objectName, body, type] = row;
      if (type === 'FUNCTION' && schemaName === definition.schema && objectName === definition.name) continue;
      if (typeof body !== 'string' || !body || /\b(?:PREPARE|EXECUTE)\b/iu.test(body)) {
        throw fail('Function deployment requires readable static application object definitions. An opaque or dynamic dependency may call this function.');
      }
      if (bodyMentions(body, definition.name)) {
        if (kind !== 'view' || dependentViews.length >= Views.dependentLimit) {
          throw fail('An observed application object may depend on this function. Use a separate dependency-aware deployment.');
        }
        try {
          dependentViews.push(await Views.inspectDependentView(read, schemaName, objectName, body, definition, { missingRoutine }));
        } catch (error) {
          if (!['ROCKETBRAIN_OBJECT_SOURCE', 'ROCKETBRAIN_DEPENDENCY', 'ROCKETBRAIN_DESIGNER_MODEL', 'ROCKETBRAIN_SCHEMA_NAME'].includes(error.code)) throw error;
          throw fail('An observed application object may depend on this function. ' + error.message);
        }
      }
      observed.push([kind, ...row]);
    }
  }
  for (const view of dependentViews) {
    if (observed.some(([kind, schema, object, body]) =>
      !(kind === 'view' && schema === view.schema && object === view.name) && bodyMentions(body, view.name))) {
      throw fail('A downstream object may depend on the reviewed view. Use a separate dependency-aware deployment.');
    }
  }
  const stableDefinitions = observed.map(row => {
    const [kind, schema, name] = row;
    const view = kind === 'view' && dependentViews.find(item => item.schema === schema && item.name === name);
    return view ? [kind, schema, name, view.fingerprint] : row;
  });
  const fingerprint = createHash('sha256').update(JSON.stringify([schemas, stableDefinitions])).digest('hex');
  return { scope: 'visible-application-schemas', schemas: schemas.length, objects: observed.length, fingerprint,
    ...(dependentViews.length && { dependentViews }) };
}

function sameFunctionDependents(observed, retained, { missingRoutine = false } = {}) {
  if (!missingRoutine || !retained?.dependentViews) return JSON.stringify(observed) === JSON.stringify(retained);
  return JSON.stringify(observed) === JSON.stringify({ ...retained,
    dependentViews: retained.dependentViews.map(view => ({ ...view, outputFingerprint: null })) });
}

module.exports = { scalarFunction, readFunction, inspectFunctionDependents, sameFunctionDependents };
