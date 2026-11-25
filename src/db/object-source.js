'use strict';

const { identifier } = require('./schema-rename');

const pageSize = 100;
const maxDefinitionBytes = 1024 * 1024;
const error = (code, message) => Object.assign(new Error(message), { code: 'ROCKETBRAIN_OBJECT_SOURCE_' + code });
const quote = value => '`' + value.replaceAll('`', '``') + '`';
const exact = column => 'CAST(' + column + ' AS BINARY) = CAST(? AS BINARY)';

const definitions = new Map([
  ['schema', { label: 'Schema', statement: 'DATABASE', catalog: 'SCHEMATA', schemaColumn: 'SCHEMA_NAME', nameColumn: 'SCHEMA_NAME', fields: ['Database', 'Create Database'] }],
  ['table', { label: 'Table', statement: 'TABLE', catalog: 'TABLES', schemaColumn: 'TABLE_SCHEMA', nameColumn: 'TABLE_NAME', filter: "TABLE_TYPE IN ('BASE TABLE','SYSTEM VERSIONED')", fields: ['Table', 'Create Table'] }],
  ['view', { label: 'View', statement: 'VIEW', catalog: 'TABLES', schemaColumn: 'TABLE_SCHEMA', nameColumn: 'TABLE_NAME', filter: "TABLE_TYPE = 'VIEW'", fields: ['View', 'Create View'] }],
  ['procedure', { label: 'Procedure', statement: 'PROCEDURE', catalog: 'ROUTINES', schemaColumn: 'ROUTINE_SCHEMA', nameColumn: 'ROUTINE_NAME', filter: "ROUTINE_TYPE = 'PROCEDURE'", fields: ['Procedure', 'Create Procedure'] }],
  ['function', { label: 'Function', statement: 'FUNCTION', catalog: 'ROUTINES', schemaColumn: 'ROUTINE_SCHEMA', nameColumn: 'ROUTINE_NAME', filter: "ROUTINE_TYPE = 'FUNCTION'", fields: ['Function', 'Create Function'] }],
  ['trigger', { label: 'Trigger', statement: 'TRIGGER', catalog: 'TRIGGERS', schemaColumn: 'TRIGGER_SCHEMA', nameColumn: 'TRIGGER_NAME', fields: ['Trigger', 'SQL Original Statement'] }],
  ['event', { label: 'Event', statement: 'EVENT', catalog: 'EVENTS', schemaColumn: 'EVENT_SCHEMA', nameColumn: 'EVENT_NAME', fields: ['Event', 'Create Event'] }],
  ['sequence', { label: 'Sequence', statement: 'SEQUENCE', catalog: 'TABLES', schemaColumn: 'TABLE_SCHEMA', nameColumn: 'TABLE_NAME', filter: "TABLE_TYPE = 'SEQUENCE'", fields: ['Table', 'Create Table'], mariaOnly: true }],
  ['package', { label: 'Package', statement: 'PACKAGE', catalog: 'ROUTINES', schemaColumn: 'ROUTINE_SCHEMA', nameColumn: 'ROUTINE_NAME', filter: "ROUTINE_TYPE = 'PACKAGE'", fields: ['Package', 'Create Package'], mariaOnly: true }],
  ['package-body', { label: 'Package body', statement: 'PACKAGE BODY', catalog: 'ROUTINES', schemaColumn: 'ROUTINE_SCHEMA', nameColumn: 'ROUTINE_NAME', filter: "ROUTINE_TYPE = 'PACKAGE BODY'", fields: ['Package body', 'Create Package Body'], mariaOnly: true }]
]);

const accessErrors = new Set([
  'ER_ACCESS_DENIED_ERROR', 'ER_DBACCESS_DENIED_ERROR', 'ER_TABLEACCESS_DENIED_ERROR', 'ER_COLUMNACCESS_DENIED_ERROR',
  'ER_SPECIFIC_ACCESS_DENIED_ERROR', 'ER_PROCACCESS_DENIED_ERROR', 'ER_VIEW_NO_EXPLAIN'
]);
const missingErrors = new Set(['ER_BAD_DB_ERROR', 'ER_NO_SUCH_TABLE', 'ER_SP_DOES_NOT_EXIST', 'ER_TRG_DOES_NOT_EXIST',
  'ER_EVENT_DOES_NOT_EXIST', 'ER_UNKNOWN_SEQUENCES', 'ER_NOT_SEQUENCE', 'ER_WRONG_OBJECT']);

function kindDefinition(kind, context) {
  const definition = definitions.get(kind);
  if (!definition || definition.mariaOnly && !context.mariaExtended) {
    throw error('KIND', 'Choose an object type supported by the connected database version.');
  }
  return definition;
}

function prefixPattern(prefix) {
  if (typeof prefix !== 'string' || prefix.length > 64 || /[\u0000-\u001f\u007f\ud800-\udfff]/.test(prefix)) {
    throw error('NAME', 'Use an object prefix of at most 64 characters.');
  }
  return prefix.replace(/[=%_]/g, value => '=' + value) + '%';
}

async function contextOf(query) {
  const { rows } = await query('SELECT VERSION(), DATABASE()');
  const [[version, database] = []] = rows;
  if (rows.length !== 1 || typeof version !== 'string' || !version || version.length > 256) {
    throw error('CONTEXT', 'Could not confirm the metadata connection.');
  }
  const dialect = /MariaDB/i.test(version) ? 'mariadb' : 'mysql';
  const release = /^(?:5\.5\.5-)?(\d+)\.(\d+)\./.exec(version);
  const mariaExtended = dialect === 'mariadb' && Boolean(release && (+release[1] > 10 || +release[1] === 10 && +release[2] >= 3));
  return { database: identifier(database, { table: true }), dialect, version, mariaExtended,
    kinds: [...definitions].filter(([, value]) => !value.mariaOnly || mariaExtended).map(([kind, { label }]) => ({ kind, label })) };
}

async function listNames(query, context, { kind, schema, prefix = '', after = '' } = {}) {
  const { catalog, schemaColumn, nameColumn, filter } = kindDefinition(kind, context);
  const bind = [];
  const clauses = [];
  if (kind !== 'schema') {
    bind.push(identifier(schema, { table: true }));
    clauses.push(exact(schemaColumn));
  }
  if (filter) clauses.push(filter);
  clauses.push(nameColumn + " LIKE ? ESCAPE '='", 'CAST(' + nameColumn + ' AS BINARY) > CAST(? AS BINARY)');
  bind.push(prefixPattern(prefix), after === '' ? '' : identifier(after));
  const { rows } = await query('SELECT ' + schemaColumn + ',' + nameColumn + ' FROM information_schema.' + catalog +
    ' WHERE ' + clauses.join(' AND ') + ' ORDER BY CAST(' + nameColumn + ' AS BINARY) LIMIT ' + (pageSize + 1), bind);
  const items = rows.slice(0, pageSize).map(([observedSchema, name]) => ({
    schema: identifier(observedSchema, { table: true }), name: identifier(name), kind
  }));
  return { items, next: rows.length > pageSize ? items.at(-1).name : null };
}

async function loadSource(query, context, object = {}) {
  const { kind } = object;
  const { catalog, schemaColumn, nameColumn, filter, statement, fields } = kindDefinition(kind, context);
  const schema = identifier(object.schema, { table: true }), name = identifier(object.name);
  if (kind === 'schema' && name !== schema) throw error('KIND', 'Choose the exact listed schema.');
  const objectUnavailable = () => error('UNAVAILABLE', 'This object name or type is no longer visible to the current account. Browse again.');
  const { rows: matches } = await query('SELECT ' + nameColumn + ' FROM information_schema.' + catalog +
    ' WHERE ' + [exact(schemaColumn), exact(nameColumn), filter].filter(Boolean).join(' AND ') + ' LIMIT 2', [schema, name]);
  if (matches.length !== 1 || matches[0][0] !== name) throw objectUnavailable();

  let result;
  try {
    const qualified = quote(schema) + (kind === 'schema' ? '' : '.' + quote(name));
    result = await query('SHOW CREATE ' + statement + ' ' + qualified);
  } catch (cause) {
    if (accessErrors.has(cause.code)) throw error('PERMISSION', 'The current account cannot read this object definition. Check the server privileges for SHOW CREATE ' + statement + '.');
    if (missingErrors.has(cause.code)) throw objectUnavailable();
    throw cause;
  }
  const showFields = result.columns.map(column => column.toLowerCase());
  const [nameIndex, sourceIndex] = fields.map(field => showFields.indexOf(field.toLowerCase()));
  const [row] = result.rows;
  if (result.rows.length !== 1 || nameIndex < 0 || row[nameIndex] !== name) throw objectUnavailable();
  const source = row[sourceIndex];
  if (sourceIndex >= 0 && source === null) {
    throw error('PERMISSION', 'The server withheld the object definition from the current account. Check the server privileges for SHOW CREATE ' + statement + '.');
  }
  if (typeof source !== 'string' || !/^\s*CREATE\s/i.test(source)) throw error('DEFINITION', 'The server did not return a complete object definition.');
  if (Buffer.byteLength(source) > maxDefinitionBytes) throw error('SIZE', 'The object definition exceeds the 1 MiB preview limit.');
  const settings = Object.fromEntries(['sql_mode', 'character_set_client', 'collation_connection', 'database collation', 'time_zone', 'time zone']
    .filter(key => showFields.includes(key)).map(key => [key, row[showFields.indexOf(key)]]));
  return { scope: 'account-visible', object: { schema, name, kind }, dialect: context.dialect, version: context.version,
    source, settings, rowDataIncluded: false };
}

// Descendant names use their owning object's SHOW CREATE definition.
const members = [
  { kind: 'column', from: 'COLUMNS m JOIN information_schema.TABLES t ON ' +
    'CAST(t.TABLE_SCHEMA AS BINARY)=CAST(m.TABLE_SCHEMA AS BINARY) AND CAST(t.TABLE_NAME AS BINARY)=CAST(m.TABLE_NAME AS BINARY)',
  name: 'm.COLUMN_NAME', ownerKind: "CASE WHEN t.TABLE_TYPE='VIEW' THEN 'view' ELSE 'table' END",
  filter: "t.TABLE_TYPE IN ('BASE TABLE','SYSTEM VERSIONED','VIEW')" },
  { kind: 'index', from: 'STATISTICS m', name: 'm.INDEX_NAME', ownerKind: "'table'", distinct: true },
  { kind: 'constraint', from: 'TABLE_CONSTRAINTS m', name: 'm.CONSTRAINT_NAME', ownerKind: "'table'" }
];

function literalLike(term) {
  return '%' + term.toLowerCase().replace(/[=%_]/g, value => '=' + value) + '%';
}

async function searchInventory(query, context, { schemas, term, limit = 200 } = {}) {
  if (!Array.isArray(schemas) || !schemas.length || schemas.length > 8 || new Set(schemas).size !== schemas.length ||
      !Number.isInteger(limit) || limit < 1 || limit > 200 ||
      term !== undefined && (typeof term !== 'string' || !term.length || term.length > 128 || /[\x00-\x1f\x7f]/.test(term))) {
    throw error('SEARCH', 'Choose one to eight visible schemas and a bounded search term.');
  }
  const scope = schemas.map(schema => identifier(schema, { table: true }));
  const parameters = [];
  function statement({ kind, from, schema, name, filter, owner, ownerKind, distinct }) {
    const clauses = ['CAST(' + schema + ' AS BINARY) IN (' + scope.map(() => 'CAST(? AS BINARY)').join(',') + ')'];
    parameters.push(...scope);
    if (filter) clauses.push(filter);
    if (term !== undefined) {
      const qualified = [...new Set([schema, owner, name].filter(Boolean))].join(',');
      clauses.push("(CAST(LOWER(" + name + ") AS BINARY) LIKE CAST(? AS BINARY) ESCAPE '=' OR " +
        "CAST(LOWER(CONCAT_WS('.', " + qualified + ")) AS BINARY) LIKE CAST(? AS BINARY) ESCAPE '=')");
      const pattern = literalLike(term);
      parameters.push(pattern, pattern);
    }
    const textName = expression => 'CONVERT(' + expression + ' USING utf8mb4) COLLATE utf8mb4_bin';
    return 'SELECT ' + (distinct ? 'DISTINCT ' : '') + textName(schema) + ' AS schema_id,' +
      textName(name) + " AS object_name,'" + kind + "' AS object_kind," + textName(owner ?? 'NULL') +
      ' AS owner_name,' + (ownerKind ?? 'NULL') + ' AS owner_kind FROM information_schema.' + from +
      ' WHERE ' + clauses.join(' AND ');
  }

  const statements = [...definitions].filter(([, definition]) => !definition.mariaOnly || context.mariaExtended)
    .map(([kind, definition]) => statement({ kind, from: definition.catalog, schema: definition.schemaColumn,
      name: definition.nameColumn, filter: definition.filter }));
  if (term !== undefined) for (const member of members) {
    statements.push(statement({ ...member, schema: 'm.TABLE_SCHEMA', owner: 'm.TABLE_NAME' }));
  }
  const { rows } = await query('SELECT schema_id,object_name,object_kind,owner_name,owner_kind FROM (' +
    statements.join(' UNION ALL ') + ') AS searchable ORDER BY CAST(schema_id AS BINARY),object_kind,' +
    'CAST(object_name AS BINARY),CAST(owner_name AS BINARY) LIMIT ' + (limit + 1), parameters);
  const items = [];
  let unsupported = 0;
  for (const [schemaValue, nameValue, kind, owner, ownerKind] of rows.slice(0, limit)) {
    try {
      const schema = identifier(schemaValue, { table: true });
      const name = identifier(nameValue);
      const target = { schema, name, kind };
      if (owner != null) {
        if (!['table', 'view'].includes(ownerKind) || !members.some(member => member.kind === kind)) throw Error();
        target.owner = { schema, name: identifier(owner, { table: true }), kind: ownerKind };
      } else kindDefinition(kind, context);
      items.push(target);
    } catch { unsupported++; }
  }
  return { items, limited: rows.length > limit, unsupported };
}

module.exports = { contextOf, listNames, loadSource, searchInventory };
