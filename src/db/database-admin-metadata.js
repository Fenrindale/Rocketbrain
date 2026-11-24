'use strict';

const schemas = Object.freeze([
  { name: 'information_schema', description: 'Account-visible schema and object metadata' },
  { name: 'performance_schema', description: 'Server instrumentation metadata' },
  { name: 'mysql', description: 'Server and account dictionary definitions' },
  { name: 'sys', description: 'Server diagnostic views and helper objects' }
]);
const fail = message => Object.assign(new Error(message), { code: 'ROCKETBRAIN_DATABASE_ADMIN' });
const text = (value, max = 512) => typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const allowSchema = value => schemas.some(schema => schema.name === value);

async function readRows(db, sql, values = []) {
  const result = await db._metadataQuery(sql, values);
  if (result.truncated) throw fail('The server metadata exceeds the supported read limits.');
  return result.rows;
}

async function readContext(read) {
  const rows = await read('SELECT VERSION(), DATABASE(), CURRENT_USER(), CURRENT_ROLE(), @@performance_schema');
  if (rows.length !== 1 || rows[0].length !== 5 || !text(rows[0][0]) || !text(rows[0][1]) || !text(rows[0][2]) ||
      rows[0][3] !== null && !text(rows[0][3], 2048)) throw fail('The server metadata context could not be verified.');
  const [version, database, account, activeRoles, performance] = rows[0];
  const dialect = /MariaDB/i.test(version) ? 'mariadb' : 'mysql';
  const state = String(performance ?? '').toUpperCase();
  return { version, dialect, database, account, activeRoles: !activeRoles || activeRoles === 'NONE' ? null : activeRoles,
    performanceInstrumentation: ['1', 'ON'].includes(state) ? 'enabled' : ['0', 'OFF'].includes(state) ? 'disabled' : 'unavailable' };
}

async function scope(read) {
  const context = await readContext(read);
  const rows = await read('SELECT SCHEMA_NAME, DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME FROM information_schema.SCHEMATA WHERE LOWER(SCHEMA_NAME) IN (?,?,?,?) ORDER BY SCHEMA_NAME',
    schemas.map(schema => schema.name));
  const visible = new Map(rows.map(([name, charset, collation]) => [name.toLowerCase(), { charset, collation }]));
  return { ...context, accountLimited: true, schemas: schemas.map(schema => ({
    ...schema, ...(visible.get(schema.name) || {}), visibility: visible.has(schema.name) ? 'visible' : 'not-observed',
    ...(schema.name === 'performance_schema' ? { instrumentation: context.performanceInstrumentation } : {})
  })) };
}

async function objects(read, { schema, page = 0, search = '' } = {}) {
  if (!allowSchema(schema) || !Number.isInteger(page) || page < 0 || page > 20 || !text(search, 128)) throw fail('Choose a supported system schema and bounded metadata search.');
  const rows = await read("SELECT TABLE_NAME,TABLE_TYPE,ENGINE FROM information_schema.TABLES WHERE LOWER(TABLE_SCHEMA)=? AND LOWER(TABLE_NAME) LIKE ? ESCAPE '=' ORDER BY BINARY TABLE_NAME LIMIT 101 OFFSET " + page * 100,
    [schema, '%' + search.toLowerCase().replace(/[=%_]/g, value => '=' + value) + '%']);
  return { schema, page, search, hasNext: rows.length > 100,
    objects: rows.slice(0, 100).map(([name, kind, engine]) => ({ name, kind, engine })),
    accountLimited: true, rowDataIncluded: false };
}

async function object(read, { schema, name } = {}) {
  if (!allowSchema(schema) || !text(name, 64) || !name) throw fail('Choose an observed system schema object.');
  const observed = await read('SELECT TABLE_NAME,TABLE_TYPE,ENGINE FROM information_schema.TABLES WHERE LOWER(TABLE_SCHEMA)=? AND TABLE_NAME=? ORDER BY TABLE_NAME LIMIT 2', [schema, name]);
  if (observed.length !== 1 || observed[0][0] !== name) throw fail('This system object is unavailable under the current database account.');
  const columns = await read('SELECT COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,ORDINAL_POSITION FROM information_schema.COLUMNS WHERE LOWER(TABLE_SCHEMA)=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION LIMIT 501', [schema, name]);
  if (columns.length > 500) throw fail('The system object exceeds 500 observed columns.');
  return { schema, name, kind: observed[0][1], engine: observed[0][2], accountLimited: true,
    columns: columns.map(([name, type, nullable, ordinal]) => ({ name, type, nullable: nullable === 'YES', ordinal: Number(ordinal) })),
    rowDataIncluded: false };
}

function account(value) {
  if (!value || !text(value.user, 128) || !text(value.host, 255)) throw fail('Choose an observed username and host.');
  return { user: value.user, host: value.host };
}

function currentAccount(current) {
  const at = current.lastIndexOf('@');
  if (at < 0) throw fail('The server did not expose an account and host.');
  return account({ user: current.slice(0, at), host: current.slice(at + 1) });
}

function readOptional(read, sql, values = [], map = rows => rows) {
  return read(sql, values).then(rows => {
    if (rows.length > 500) return { visibility: 'limit', entries: map(rows.slice(0, 500)) };
    return { visibility: 'observed', entries: map(rows) };
  }).catch(() => ({ visibility: 'unavailable', entries: [] }));
}

async function accounts(read, context) {
  const maria = context.dialect === 'mariadb';
  return readOptional(read, 'SELECT User,Host' + (maria ? ',is_role' : '') + ' FROM mysql.user ORDER BY User,Host LIMIT 501', [],
    rows => rows.map(([user, host, role]) => ({ ...account({ user, host }), kind: maria ? role === 'Y' ? 'role' : 'account' : 'authorization-identifier' })));
}

function grantee(value) {
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  return quote(value.user) + '@' + quote(value.host);
}

async function inspectAccess(read, context, requested) {
  const own = currentAccount(context.account);
  const selected = requested ? account(requested) : own;
  const isCurrent = own.user === selected.user && own.host === selected.host;
  if (!isCurrent) {
    const rows = await read('SELECT User,Host FROM mysql.user WHERE BINARY User=BINARY ? AND BINARY Host=BINARY ? LIMIT 2', [selected.user, selected.host]);
    if (rows.length !== 1) throw fail('Choose a visible account or role.');
  }
  const holder = grantee(selected);
  const privileges = {};
  const descriptions = [
    ['global', 'USER_PRIVILEGES', '', []],
    ['schema', 'SCHEMA_PRIVILEGES', ',TABLE_SCHEMA', ['schema']],
    ['table', 'TABLE_PRIVILEGES', ',TABLE_SCHEMA,TABLE_NAME', ['schema', 'table']],
    ['column', 'COLUMN_PRIVILEGES', ',TABLE_SCHEMA,TABLE_NAME,COLUMN_NAME', ['schema', 'table', 'column']]
  ];
  for (const [kind, view, projection, keys] of descriptions) {
    privileges[kind] = await readOptional(read, 'SELECT PRIVILEGE_TYPE,IS_GRANTABLE' + projection +
      ' FROM information_schema.' + view + ' WHERE GRANTEE=? ORDER BY PRIVILEGE_TYPE' + projection + ' LIMIT 501',
    [holder], rows => rows.map(([name, grantable, ...values]) => ({ name, grantable: grantable === 'YES',
      ...Object.fromEntries(keys.map((key, index) => [key, values[index]])) })));
  }
  const maria = context.dialect === 'mariadb';
  const roles = isCurrent
    ? await readOptional(read, 'SELECT ROLE_NAME,' + (maria ? 'NULL' : 'ROLE_HOST') +
        ',IS_GRANTABLE,IS_DEFAULT FROM information_schema.APPLICABLE_ROLES ORDER BY ROLE_NAME LIMIT 501', [],
      rows => rows.map(([user, host, grantable, isDefault]) => ({ user, host, grantable: grantable === 'YES', defaultRole: isDefault === 'YES' })))
    : await readOptional(read, maria
      ? 'SELECT Role,NULL,Admin_option FROM mysql.roles_mapping WHERE BINARY User=BINARY ? AND BINARY Host=BINARY ? ORDER BY Role LIMIT 501'
      : 'SELECT FROM_USER,FROM_HOST,WITH_ADMIN_OPTION FROM mysql.role_edges WHERE BINARY TO_USER=BINARY ? AND BINARY TO_HOST=BINARY ? ORDER BY FROM_USER,FROM_HOST LIMIT 501',
    [selected.user, selected.host], rows => rows.map(([user, host, grantable]) => ({ user, host, grantable: grantable === 'Y' })));
  return { dialect: context.dialect, version: context.version, selected, isCurrent,
    activeRoles: isCurrent ? context.activeRoles : null, roleScope: isCurrent ? 'applicable-to-current-metadata-session' : 'observed-direct-role-assignments',
    privileges, roles, accountLimited: true, effectiveAccessCalculated: false, credentialsIncluded: false };
}

module.exports = { readRows, readContext, scope, objects, object, accounts, inspectAccess, account, currentAccount, allowSchema, fail };
