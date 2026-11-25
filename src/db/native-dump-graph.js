'use strict';

const { createHash } = require('node:crypto');
const Graph = require('./schema-dependency-graph');
const Programs = require('./schema-programs');
const Sources = require('./object-source');
const { error } = require('./native-dump-process');

const { AST } = Graph;
const maxObjects = 48;
const kinds = new Set(['view', 'procedure', 'function', 'trigger']);
const limitedName = value => typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_$]{0,63}$/.test(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const isDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const key = (kind, name) => kind + ':' + name;
const word = token => token?.kind === 'word' ? token.value.toUpperCase() : '';
const q = AST.q;
const fail = message => error('GRAPH', message);

function objectsFrom(catalog) {
  return [...catalog.views.map(item => ({ kind: 'view', name: item.name })), ...catalog.routines.map(item => ({
    kind: item.type.toLowerCase(), name: item.name
  })), ...catalog.triggers.map(item => ({ kind: 'trigger', name: item.name }))].filter(item => kinds.has(item.kind) && limitedName(item.name));
}

function objectList(items) {
  return Array.isArray(items) && items.length <= maxObjects && items.every(item => item && kinds.has(item.kind) && limitedName(item.name)) &&
    new Set(items.map(item => key(item.kind, item.name))).size === items.length;
}

async function rowsOf(db, sql, values = []) {
  const result = await db._metadataQuery(sql, values);
  if (result.truncated || !Array.isArray(result.rows)) throw fail('The source database graph exceeds its metadata limits.');
  return result.rows;
}

async function schemaDefaults(db, database) {
  const rows = await rowsOf(db, 'SELECT DEFAULT_CHARACTER_SET_NAME,DEFAULT_COLLATION_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?', [database]);
  const [[charset, collation] = []] = rows;
  if (rows.length !== 1 || charset !== 'utf8mb4' || !limitedName(collation) || !collation.startsWith('utf8mb4_')) {
    throw fail('Graph backup and restore require an observed UTF-8 database default.');
  }
  return { charset, collation };
}

function checkContext(definer, source, { sqlMode, charset, collation, databaseCollation }, defaults) {
  if (definer !== source.account) throw fail('Every backed-up schema object must have the current effective account as its definer.');
  if (typeof sqlMode !== 'string' || !/^[A-Za-z0-9_,]{0,1024}$/.test(sqlMode) ||
      /(?:^|,)(?:ANSI_QUOTES|NO_BACKSLASH_ESCAPES|ORACLE)(?:,|$)/i.test(sqlMode) || charset !== 'utf8mb4' ||
      !limitedName(collation) || !collation.startsWith('utf8mb4_') || databaseCollation && databaseCollation !== defaults.collation) {
    throw fail('The object creation mode or character context cannot be reproduced by this native graph workflow.');
  }
  return { sqlMode, charset, collation };
}

function portableReferences(sql, database, sqlMode) {
  const tokens = AST.programLex(sql, { sqlMode });
  const edits = [];
  for (let index = 1; index < tokens.length; index++) {
    const token = tokens[index];
    if (!token.name || tokens[index + 1]?.value !== '.' || !tokens[index + 2]?.name) continue;
    const relation = ['FROM', 'JOIN', 'INTO', 'UPDATE', 'CALL'].includes(word(tokens[index - 1]));
    if (!relation && tokens[index + 3]?.value === '(') throw fail('Qualified stored-function references are unsupported in native graph backups.');
    if (!relation && tokens[index + 3]?.value !== '.') continue;
    if (token.name !== database) throw fail('Cross-schema references are unavailable in a native graph backup.');
    edits.push({ start: token.start, end: tokens[index + 1].end });
  }
  for (const edit of edits.reverse()) sql = sql.slice(0, edit.start) + sql.slice(edit.end);
  return sql;
}

function portableView(definition, refs, database, sqlMode) {
  let sql = definition;
  for (const item of [...refs].sort((a, b) => b.start - a.start)) sql = sql.slice(0, item.start) + q(item.table) + sql.slice(item.end);
  return portableReferences(sql, database, sqlMode);
}

function routineHead(sourceSql, body, type, name, database, sqlMode, definer) {
  const end = sourceSql.lastIndexOf(body);
  if (end < 0 || sourceSql.slice(end + body.length).trim().replace(/^;$/, '') !== '') throw fail('SHOW CREATE and the captured routine body disagree.');
  const header = sourceSql.slice(0, end);
  const prefix = /^CREATE\s+DEFINER\s*=\s*`((?:[^`]|``)+)`\s*@\s*`((?:[^`]|``)+)`\s+(PROCEDURE|FUNCTION)\s+/i.exec(header);
  if (!prefix || prefix[3].toUpperCase() !== type || prefix[1].replaceAll('``', '`') + '@' + prefix[2].replaceAll('``', '`') !== definer) {
    throw fail('The routine definition does not have a supported CREATE header and observed definer.');
  }
  const declaration = header.slice(prefix[0].length);
  const tokens = AST.lex(declaration, { sqlMode, loose: true });
  if (tokens.some(item => item.value === ';')) throw fail('The routine declaration crosses its CREATE statement.');
  const observed = AST.reference(tokens, 0, database);
  if (observed.table !== name || observed.schema !== database || tokens[observed.end]?.value !== '(') throw fail('The routine identity changed during capture.');
  return 'CREATE DEFINER=CURRENT_USER ' + type + ' ' + q(name) + declaration.slice(tokens[observed.end - 1].end).trimEnd();
}

function dependencyOrder(values, referenceOf) {
  const byName = new Map(values.map(item => [item.name, item]));
  const done = new Set(), visiting = new Set(), ordered = [];
  function visit(item) {
    if (done.has(item.name)) return;
    if (visiting.has(item.name)) throw fail('The selected schema graph contains a cyclic dependency.');
    visiting.add(item.name);
    for (const name of referenceOf(item)) if (byName.has(name)) visit(byName.get(name));
    visiting.delete(item.name);
    done.add(item.name);
    ordered.push(item);
  }
  for (const item of values) visit(item);
  return ordered;
}

function requireRefs(refs, source, items) {
  for (const item of refs) {
    if (item.schema !== source.database) throw fail('Cross-schema references are unavailable in a native graph backup.');
    if (!items.has(item.table)) throw fail('Include every referenced table, view and routine in the backup selection.');
  }
}

async function tableDefinitions(read, database, tables, sqlMode) {
  const definitions = [];
  for (const name of tables) {
    const rows = await read('SHOW CREATE TABLE ' + q(database) + '.' + q(name));
    if (rows.length !== 1 || rows[0][0] !== name || typeof rows[0][1] !== 'string') throw fail('The selected table definition is unavailable.');
    if (/\/\*(?:!|M!)/i.test(rows[0][1])) throw fail('Version-dependent table clauses are unavailable in a native graph backup.');
    const tokens = AST.lex(rows[0][1], { loose: true, sqlMode });
    const stable = [];
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index], keyword = word(token), next = word(tokens[index + 1]);
      if (keyword === 'TABLESPACE' || ['DATA', 'INDEX'].includes(keyword) && next === 'DIRECTORY' ||
          keyword === 'REFERENCES' && tokens[index + 2]?.value === '.') {
        throw fail('Native graph tables cannot use external storage or explicitly schema-qualified foreign keys.');
      }
      if (keyword === 'AUTO_INCREMENT' && tokens[index + 1]?.value === '=' && tokens[index + 2]?.kind === 'number') {
        index += 2;
      } else stable.push(token.value);
    }
    definitions.push(stable);
  }
  return definitions;
}

function scriptFor(objects, fingerprint) {
  const delimiter = '~rb' + fingerprint.slice(0, 9) + '~';
  let text = '\n-- Rocketbrain reviewed schema graph\n';
  for (const object of objects) {
    if (object.sql.includes(delimiter) || /(?:^|\r?\n)\s*(?:delimiter\b|\\)/im.test(object.sql) || /\0/.test(object.sql)) {
      throw fail('The captured object includes an unsupported native-client delimiter or command.');
    }
    text += "SET SESSION sql_mode = '" + object.context.sqlMode + "';\nSET NAMES utf8mb4 COLLATE " + object.context.collation +
      ';\nDELIMITER ' + delimiter + '\n' + object.sql + '\n' + delimiter + '\nDELIMITER ;\n';
    if (Buffer.byteLength(text) > 1024 * 1024) throw fail('The native object definition suffix exceeds 1 MiB.');
  }
  return text;
}

async function captureGraph(db, source, catalog, tables, selected) {
  if (!objectList(selected) || !selected.length) throw fail('Choose one to 48 distinct visible schema objects.');
  if (!['tables', 'columns', 'routines', 'triggers'].every(area => catalog.coverage?.[area] === 'loaded') || !catalog.semanticContextObserved) {
    throw fail('Refresh the visible schema and SQL context before capturing native graph objects.');
  }
  const available = new Set(objectsFrom(catalog).map(item => key(item.kind, item.name)));
  if (selected.some(item => !available.has(key(item.kind, item.name)))) throw fail('A selected native graph object changed or is unavailable.');
  const defaults = await schemaDefaults(db, source.database);
  const tableNames = new Set(tables);
  const relations = new Set([...tables, ...selected.filter(item => item.kind === 'view').map(item => item.name)]);
  const tableShapes = [...catalog.tables, ...catalog.views].filter(item => relations.has(item.name))
    .map(item => ({ ...item, schema: source.database }));
  const context = { database: source.database, dialect: source.dialect, version: source.version };
  const read = (sql, values) => rowsOf(db, sql, values);
  const tableSql = await tableDefinitions(read, source.database, tables, catalog.sqlMode.join(','));
  const readSource = item => Sources.loadSource((sql, values) => db._metadataQuery(sql, values), context,
    { ...item, schema: source.database });
  const views = [], procedures = [], functions = [], triggers = [];
  for (const item of selected.filter(item => item.kind === 'view').sort((a, b) => a.name.localeCompare(b.name))) {
    const rows = await read('SELECT VIEW_DEFINITION,DEFINER,SECURITY_TYPE,CHECK_OPTION,CHARACTER_SET_CLIENT,COLLATION_CONNECTION' +
      ' FROM information_schema.VIEWS WHERE TABLE_SCHEMA=? AND TABLE_NAME=?', [source.database, item.name]);
    if (rows.length !== 1) throw fail('The complete view definition is unavailable.');
    const [[definition, definer, security, check, charset, collation]] = rows;
    const shown = await readSource(item);
    const algorithm = /^CREATE\s+ALGORITHM\s*=\s*(UNDEFINED|MERGE|TEMPTABLE)\b/i.exec(shown.source)?.[1]?.toUpperCase();
    if (!algorithm || !['DEFINER', 'INVOKER'].includes(security) || !['NONE', 'LOCAL', 'CASCADED'].includes(check)) throw fail('The view creation context is unsupported.');
    const mode = checkContext(definer, source, { sqlMode: catalog.sqlMode.join(','), charset, collation }, defaults);
    const { refs } = Graph.parseView(definition, source.database, mode);
    requireRefs(refs, source, relations);
    const sql = 'CREATE ALGORITHM=' + algorithm + ' DEFINER=CURRENT_USER SQL SECURITY ' + security + ' VIEW ' + q(item.name) +
      ' AS ' + portableView(definition, refs, source.database, mode.sqlMode) + (check === 'NONE' ? '' : ' WITH ' + check + ' CHECK OPTION');
    views.push({ ...item, sql, context: mode, references: refs.map(value => value.table) });
  }
  const procedureNames = new Set(selected.filter(item => item.kind === 'procedure').map(item => item.name));
  const routineItems = selected.filter(item => item.kind === 'procedure' || item.kind === 'function').sort((a, b) => a.name.localeCompare(b.name));
  for (const item of routineItems) {
    const type = item.kind.toUpperCase();
    const rows = await read('SELECT ROUTINE_DEFINITION,DEFINER,SQL_MODE,CHARACTER_SET_CLIENT,COLLATION_CONNECTION,DATABASE_COLLATION,' +
      'IS_DETERMINISTIC,SQL_DATA_ACCESS FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=? AND ROUTINE_NAME=? AND ROUTINE_TYPE=?',
    [source.database, item.name, type]);
    if (rows.length !== 1 || typeof rows[0][0] !== 'string') throw fail('The complete stored routine definition is unavailable.');
    const [[definition, definer, sqlMode, charset, collation, databaseCollation, deterministic, access]] = rows;
    const mode = checkContext(definer, source, { sqlMode, charset, collation, databaseCollation }, defaults);
    const shown = await readSource(item);
    if (item.kind === 'function') {
      const body = definition.trim(), expression = /^RETURN\s+([\s\S]+)$/i.exec(body)?.[1];
      if (!expression || deterministic !== 'YES' || !['NO SQL', 'CONTAINS SQL'].includes(access)) {
        throw fail('Native graph functions must be deterministic scalar RETURN expressions without SQL queries.');
      }
      const tokens = AST.lex(expression, mode);
      if (tokens.some(token => token.value === '.')) throw fail('Qualified names are unavailable in scalar native graph functions.');
      const rendered = AST.expression(tokens);
      functions.push({ ...item, context: mode, sql: routineHead(shown.source, body, type, item.name, source.database, sqlMode, definer) + '\nRETURN ' + rendered });
      continue;
    }
    const observed = await Programs.readRoutine(read, source.database, item.name, { metadataOnly: true });
    const body = Programs.shownBody(shown.source, source.database, item.name, sqlMode);
    const ast = AST.parseProgram(body, source.database, undefined, { kind: 'procedure', sqlMode, parameters: observed.parameters,
      allowRows: true, allowDynamic: false });
    requireRefs(ast.targets, source, relations);
    requireRefs(ast.calls, source, procedureNames);
    AST.validate(ast, { database: source.database, tables: tableShapes });
    procedures.push({ ...item, schema: source.database, context: mode, ast, parameters: observed.parameters,
      references: ast.calls.map(value => value.table), sql: routineHead(shown.source, body, type, item.name, source.database, sqlMode, definer) +
        '\n' + portableReferences(AST.render(ast), source.database, sqlMode) });
  }
  for (const item of procedures) Programs.validateCalls(item.ast, procedures, { database: source.database, tables: tableShapes });

  const triggerNames = new Set(selected.filter(item => item.kind === 'trigger').map(item => item.name));
  const triggerRows = triggerNames.size ? await Graph.readTriggers(read, source.database) : [];
  for (const row of triggerRows.filter(value => triggerNames.has(value[0]))) {
    const [name, table, timing, event, body, sqlMode, definer, charset, collation, databaseCollation, order] = row;
    if (!tableNames.has(table) || !['BEFORE', 'AFTER'].includes(timing) || !['INSERT', 'UPDATE', 'DELETE'].includes(event)) {
      throw fail('Include the native trigger subject table and use a supported event.');
    }
    if (triggerRows.some(other => other[1] === table && other[2] === timing && other[3] === event && !triggerNames.has(other[0]))) {
      throw fail('Include all triggers in each selected subject, timing and event group so their order can be restored.');
    }
    const mode = checkContext(definer, source, { sqlMode, charset, collation, databaseCollation }, defaults);
    const ast = AST.parse(body, source.database, table, { sqlMode, allowRows: false, allowDynamic: false });
    requireRefs(ast.targets, source, relations);
    requireRefs(ast.calls || [], source, procedureNames);
    AST.validate(ast, { database: source.database, table, tables: tableShapes, timing, event });
    Programs.validateCalls(ast, procedures, { database: source.database, table, tables: tableShapes, timing, event });
    triggers.push({ kind: 'trigger', name, context: mode, table, timing, event, actionOrder: Number(order),
      sql: 'CREATE DEFINER=CURRENT_USER TRIGGER ' + q(name) + ' ' + timing + ' ' + event + ' ON ' + q(table) +
        ' FOR EACH ROW ' + portableReferences(AST.render(ast), source.database, sqlMode) });
  }
  if (triggerNames.size !== triggers.length) throw fail('A selected trigger disappeared during capture.');
  // ACTION_ORDER is already sorted by the visible schema dictionary within each trigger group.
  const ordered = [...dependencyOrder(views, item => item.references), ...functions,
    ...dependencyOrder(procedures, item => item.references), ...triggers];
  const normalized = ordered.map(({ kind, name, context, sql, actionOrder }) => ({ kind, name, context,
    sql: AST.lex(sql, { sqlMode: context.sqlMode, loose: true }).map(t => t.value), actionOrder }));
  const fingerprint = hash({ objects: normalized, tables: tableSql });
  return { graph: { serverKey: source.serverKey, accountKey: source.accountKey, defaults,
    objects: ordered.map(({ kind, name }) => ({ kind, name })), fingerprint },
    sourceStamp: hash({ fingerprint, tables: tableShapes.filter(item => tableNames.has(item.name)), defaults }), suffix: scriptFor(ordered, fingerprint) };
}

function validGraph(value) {
  return value && isDigest(value.serverKey) && isDigest(value.accountKey) && isDigest(value.fingerprint) &&
    value.defaults?.charset === 'utf8mb4' && limitedName(value.defaults.collation) && objectList(value.objects) && value.objects.length > 0;
}

async function checkDestination(db, target, graph) {
  if (!validGraph(graph) || target.serverKey !== graph.serverKey || target.accountKey !== graph.accountKey) {
    throw fail('Native graph restore requires a different schema on the same server under the same effective account.');
  }
  const defaults = await schemaDefaults(db, target.database);
  if (defaults.collation !== graph.defaults.collation) throw fail('The destination schema default collation differs from the reviewed graph.');
}

module.exports = { objectsFrom, captureGraph, validGraph, checkDestination, maxObjects };
