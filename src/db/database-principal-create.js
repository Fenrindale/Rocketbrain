'use strict';

const { isIP } = require('node:net');
const { currentAccount, fail } = require('./database-admin-metadata');

const userName = /^[A-Za-z][A-Za-z0-9_.-]{0,31}$/u;
const dnsLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const equal = (before, after) => JSON.stringify(before) === JSON.stringify(after);

function passwordProblem(value) {
  if (typeof value !== 'string' || !value.length || !value.isWellFormed() || /[\x00-\x1f\x7f]/u.test(value) || Buffer.byteLength(value) > 1024) {
    return 'Enter a password of up to 1024 UTF-8 bytes without control characters.';
  }
  return undefined;
}

function principal(input, dialect) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['kind', 'user', 'host'].includes(key)) ||
      !['account', 'role'].includes(input.kind) || typeof input.user !== 'string' || !userName.test(input.user)) {
    throw fail('Choose one account or role name of up to 32 ASCII letters, digits, underscores, periods or hyphens, starting with a letter.');
  }
  if (input.kind === 'role') {
    if (input.host !== undefined || /^(none|public)$/iu.test(input.user)) throw fail('Choose an unreserved role name. The server supplies the role host.');
    return { kind: 'role', user: input.user, host: dialect === 'mysql' ? '%' : '' };
  }
  const host = typeof input.host === 'string' ? input.host.toLowerCase() : '';
  if (!host || host.length > 253 || !/^[a-z0-9.:-]+$/u.test(host) || !isIP(host) && !host.split('.').every(label => dnsLabel.test(label))) {
    throw fail('Choose an explicit account host as an IP address or DNS name. Wildcards and networks require a separate review.');
  }
  return { kind: 'account', user: input.user, host };
}

function statement(target, dialect, credential = '<password supplied on apply>') {
  const exact = "'" + target.user + "'@'" + target.host + "'";
  if (target.kind === 'account') return 'CREATE USER ' + exact + ' IDENTIFIED BY ' + credential + ' ACCOUNT UNLOCK';
  return dialect === 'mysql' ? 'CREATE ROLE ' + exact : 'CREATE ROLE `' + target.user + '` WITH ADMIN CURRENT_USER';
}

function passwordLiteral(password, sqlMode) {
  const message = passwordProblem(password);
  if (message) throw fail(message);
  const escaped = sqlMode.split(',').includes('NO_BACKSLASH_ESCAPES') ? password : password.replaceAll('\\', '\\\\');
  return "'" + escaped.replaceAll("'", "''") + "'";
}

async function observe(transport, session, identity, target) {
  const read = (sql, values) => transport._read(session, sql, values);
  if (identity.dialect === 'mysql') {
    const rows = await read('SELECT User,Host,account_locked FROM mysql.user WHERE BINARY User=BINARY ? AND LOWER(Host)=? LIMIT 2',
      [target.user, target.host]);
    if (rows.length > 1 || rows.some(([user, host, locked]) => user !== target.user || host.toLowerCase() !== target.host || !['Y', 'N'].includes(locked))) {
      throw fail('The selected MySQL authorization identifier is ambiguous.');
    }
    return { exists: rows.length === 1, matches: rows[0]?.[2] === (target.kind === 'role' ? 'Y' : 'N') };
  }

  // A MariaDB role and any account with the same exact username share a name for this flow.
  const rows = await read('SELECT User,Host,is_role FROM mysql.user WHERE BINARY User=BINARY ? ORDER BY Host LIMIT 65', [target.user]);
  if (rows.length > 64 || rows.some(([user, , role]) => user !== target.user || !['Y', 'N'].includes(role))) {
    throw fail('The selected MariaDB authorization name has an ambiguous inventory.');
  }
  const row = rows.find(([, host]) => host.toLowerCase() === target.host);
  const exists = target.kind === 'role' ? rows.length > 0 : Boolean(row) || rows.some(([, , role]) => role === 'Y');
  if (target.kind === 'account') return { exists, matches: row?.[2] === 'N' && !rows.some(([, , role]) => role === 'Y') };
  if (rows.length !== 1 || row?.[2] !== 'Y') return { exists, matches: false };
  const owner = currentAccount(identity.currentUser);
  const mapping = await read('SELECT Admin_option FROM mysql.roles_mapping WHERE BINARY Role=BINARY ? AND BINARY User=BINARY ? AND BINARY Host=BINARY ? LIMIT 2',
    [target.user, owner.user, owner.host]);
  return { exists, matches: equal(mapping, [['Y']]) };
}

function plan(lease, input) {
  const transport = lease.db._schemaRenamer;
  return transport._withSession(async session => {
    const identity = await transport._identity(session);
    const target = principal(input, identity.dialect);
    const previous = await observe(transport, session, identity, target);
    if (previous.exists) throw fail('An account or role with that authorization name already exists.');
    if (!lease.guard()) throw fail('The administrator connection changed. Prepare the review again.');
    return { identity, target, sql: statement(target, identity.dialect),
      roleAdministrator: target.kind === 'role' && identity.dialect === 'mariadb' ? identity.currentUser : null };
  });
}

function result(state, acknowledged) {
  return { state, acknowledged, automaticRetry: false, credentialsIncluded: false };
}

function apply(lease, reviewed, password) {
  const transport = lease.db._schemaRenamer;
  return transport._withSession(async session => {
    const identity = await transport._identity(session), { target } = reviewed;
    if (!equal(identity, reviewed.identity) || !lease.guard()) throw fail('The administrator identity or SQL context changed after review.');
    if ((await observe(transport, session, identity, target)).exists || !lease.guard()) {
      throw fail('The exact authorization name or connection changed after review.');
    }
    if (target.kind === 'role' && password !== undefined) throw fail('A role does not accept an account password.');
    const credential = target.kind === 'account' ? passwordLiteral(password, identity.sqlMode) : undefined;
    let acknowledged = false;
    try {
      const header = await lease.db._control(session, statement(target, identity.dialect, credential));
      acknowledged = true;
      if (header?.warningStatus) return result('uncertain', true);
    } catch {
      if (session.connected && lease.guard()) {
        try {
          if (!(await observe(transport, session, identity, target)).exists) return result('rejected', false);
        } catch { /* Outcome cannot be verified. */ }
      }
      return result('uncertain', false);
    }
    try {
      const after = await transport._identity(session);
      if (equal(after, identity) && (await observe(transport, session, after, target)).matches && lease.guard()) {
        return result('verified', acknowledged);
      }
    } catch { /* A missing postcondition does not authorize a retry. */ }
    return result('uncertain', acknowledged);
  });
}

module.exports = { plan, apply, passwordProblem };
