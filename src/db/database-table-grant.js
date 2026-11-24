'use strict';

const { createHash } = require('node:crypto');
const { identifier, stableCreate } = require('./schema-rename');
const { account, currentAccount, allowSchema, fail } = require('./database-admin-metadata');

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const quote = name => '`' + identifier(name, { table: true }).replaceAll('`', '``') + '`';
const holder = value => "'" + value.user + "'@'" + value.host + "'";

function request(value) {
  const selected = account(value?.account);
  const table = identifier(value.table, { table: true });
  if (!/^[A-Za-z0-9_$.-]{1,80}$/.test(selected.user) || !/^[A-Za-z0-9_%.:-]{1,255}$/.test(selected.host) ||
      /^__rb_/i.test(table) || !['grant', 'revoke'].includes(value.action)) {
    throw fail('Choose an existing account, table and single SELECT grant action.');
  }
  return { account: selected, table, action: value.action };
}

function sqlFor({ table, account, action }, database) {
  const object = quote(database) + '.' + quote(table);
  return action === 'grant' ? 'GRANT SELECT ON ' + object + ' TO ' + holder(account)
    : 'REVOKE SELECT ON ' + object + ' FROM ' + holder(account);
}

function parseSet(value) {
  if (typeof value !== 'string' || value && !/^[A-Za-z_ ]+(?:,[A-Za-z_ ]+)*$/.test(value)) {
    throw fail('The direct table grant dictionary returned an unsupported privilege set.');
  }
  return [...new Set(value.split(',').map(name => name.trim().toUpperCase()).filter(Boolean))].sort();
}

async function inspectTarget(transport, session, target) {
  const read = (sql, values) => transport._read(session, sql, values);
  const identity = await transport._identity(session);
  if (allowSchema(identity.database.toLowerCase()) || identity.dialect === 'mariadb' && !identity.sqlMode.split(',').includes('NO_AUTO_CREATE_USER')) {
    throw fail('Use a user database and a server mode that prevents implicit account creation.');
  }
  const own = currentAccount(identity.currentUser);
  if (own.user === target.account.user && own.host === target.account.host) throw fail('Use a different account from the authenticated administrator.');
  const maria = identity.dialect === 'mariadb';
  const accountRows = await read('SELECT User,Host' + (maria ? ',is_role' : '') +
    ' FROM mysql.user WHERE BINARY User=BINARY ? AND BINARY Host=BINARY ? LIMIT 2', [target.account.user, target.account.host]);
  if (accountRows.length !== 1 || accountRows[0][0] !== target.account.user || accountRows[0][1] !== target.account.host || accountRows[0][2] === 'Y') {
    throw fail('The exact existing account is no longer visible.');
  }
  const names = await read('SELECT TABLE_NAME,TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND BINARY TABLE_NAME=BINARY ? LIMIT 2',
    [identity.database, target.table]);
  if (names.length !== 1 || names[0][0] !== target.table || names[0][1] !== 'BASE TABLE') throw fail('Choose an observed base table in the active user database.');
  const ddl = await read('SHOW CREATE TABLE ' + quote(identity.database) + '.' + quote(target.table));
  if (ddl.length !== 1 || typeof ddl[0][1] !== 'string' || !ddl[0][1]) throw fail('The selected table definition is unavailable.');
  const rows = await read('SELECT Table_priv,Column_priv FROM mysql.tables_priv WHERE BINARY User=BINARY ? AND BINARY Host=BINARY ? AND BINARY Db=BINARY ? AND BINARY Table_name=BINARY ? LIMIT 2',
    [target.account.user, target.account.host, identity.database, target.table]);
  if (rows.length > 1) throw fail('The direct table grant dictionary is ambiguous.');
  const privileges = rows.length ? parseSet(rows[0][0]) : [];
  const columnPrivileges = rows.length ? parseSet(rows[0][1]) : [];
  if (columnPrivileges.length || privileges.includes('GRANT')) throw fail('Column grants or an existing table-level grant option require a separate permissions review.');
  return { identity, tableHash: digest(stableCreate(ddl[0][1])), privileges };
}

function previewTableGrant(lease, value) {
  const target = request(value);
  const transport = lease.db._schemaRenamer;
  return transport._withSession(async session => {
    const before = await inspectTarget(transport, session, target);
    if (!lease.guard()) throw fail('The administrator connection changed. Prepare the review again.');
    const present = before.privileges.includes('SELECT');
    if ((target.action === 'grant') === present) throw fail('The requested direct SELECT privilege is already in that state.');
    const expected = target.action === 'grant' ? [...before.privileges, 'SELECT'].sort() : before.privileges.filter(value => value !== 'SELECT');
    return { target, before, expected, sql: sqlFor(target, before.identity.database) };
  });
}

function applyTableGrant(lease, plan) {
  const transport = lease.db._schemaRenamer;
  return transport._withSession(async session => {
    const fresh = await inspectTarget(transport, session, plan.target);
    if (!lease.guard() || digest(fresh) !== digest(plan.before)) throw fail('The administrator, table or direct privilege set changed after review.');
    let acknowledged = false;
    try {
      const header = await lease.db._control(session, plan.sql);
      acknowledged = true;
      if (header?.warningStatus) return { state: 'uncertain', acknowledged, automaticRetry: false };
    } catch {
      if (session.connected) {
        try {
          if (digest(await inspectTarget(transport, session, plan.target)) === digest(fresh)) {
            return { state: 'rejected', acknowledged: false, automaticRetry: false };
          }
        } catch { /* A changed or inaccessible grant is uncertain. */ }
      }
      return { state: 'uncertain', acknowledged, automaticRetry: false };
    }
    try {
      const after = await inspectTarget(transport, session, plan.target);
      if (digest(after.identity) === digest(fresh.identity) && after.tableHash === fresh.tableHash &&
          digest(after.privileges) === digest(plan.expected)) {
        return { state: 'verified', acknowledged, privileges: after.privileges, automaticRetry: false };
      }
    } catch { /* A lost postcondition does not authorize another grant. */ }
    return { state: 'uncertain', acknowledged, automaticRetry: false };
  });
}

module.exports = { previewTableGrant, applyTableGrant, request, sqlFor, parseSet };
