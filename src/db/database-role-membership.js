'use strict';

const { account, currentAccount, allowSchema, fail, assignedRoles, rolePrivileges, inspectRoleInheritance } = require('./database-admin-metadata');

const reserved = new Set(['root', 'public', 'none', 'mysql.infoschema', 'mysql.session', 'mysql.sys', 'mariadb.sys']);
const nameShape = /^[A-Za-z][A-Za-z0-9_.-]{0,31}$/u;
const hostShape = /^[A-Za-z0-9_%.:-]{1,253}$/u;
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const key = value => JSON.stringify([value.user, value.host ?? '']);
const roleRef = ({ user, host }) => ({ user, host: host ?? '' });
const accountSql = value => "'" + value.user + "'@'" + value.host + "'";
const compare = (a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;

function authorizationName(value, kind, dialect) {
  const principal = account(kind === 'role' ? roleRef(value || {}) : value);
  const expectedHost = kind === 'role' && dialect === 'mariadb' ? principal.host === '' : hostShape.test(principal.host);
  if (!nameShape.test(principal.user) || reserved.has(principal.user.toLowerCase()) || !expectedHost) {
    throw fail('Choose an exact non-system role or login account with a supported authorization name.');
  }
  return principal;
}

function request(input, dialect) {
  if (!input || !['grant', 'revoke', 'revoke-admin'].includes(input.action) ||
      input.withAdmin !== undefined && typeof input.withAdmin !== 'boolean' ||
      input.action !== 'grant' && input.withAdmin === true) throw fail('Choose one explicit role membership change.');
  if (input.action === 'revoke-admin' && dialect !== 'mariadb')
    throw fail('Only MariaDB supports admin-only revocation in this reviewed workflow.');
  return { role: authorizationName(input.role, 'role', dialect), account: authorizationName(input.account, 'account', dialect),
    action: input.action, withAdmin: input.withAdmin === true };
}

function sqlFor(target, dialect) {
  const role = dialect === 'mariadb' ? String.fromCharCode(96) + target.role.user + String.fromCharCode(96) : accountSql(target.role);
  const member = accountSql(target.account);
  if (target.action === 'grant') return 'GRANT ' + role + ' TO ' + member + (target.withAdmin ? ' WITH ADMIN OPTION' : '');
  return 'REVOKE ' + (target.action === 'revoke-admin' ? 'ADMIN OPTION FOR ' : '') + role + ' FROM ' + member;
}

function expectedRoles(before, target) {
  const found = before.find(item => key(item) === key(target.role));
  const other = before.filter(item => key(item) !== key(target.role));
  if (target.action === 'grant') {
    if (found && (!target.withAdmin || found.adminOption)) throw fail('The exact role membership is already in the requested state.');
    return [...other, { ...target.role, adminOption: target.withAdmin }].sort(compare);
  }
  if (!found || target.action === 'revoke-admin' && !found.adminOption) throw fail('The exact role or admin option is already absent.');
  return target.action === 'revoke' ? other : [...other, { ...target.role, adminOption: false }].sort(compare);
}

async function exactPrincipal(read, identity, selected, kind) {
  const maria = identity.dialect === 'mariadb';
  const field = maria ? 'is_role' : 'account_locked';
  const rows = maria ? await read('SELECT User,Host,is_role FROM mysql.user WHERE BINARY User=BINARY ? ORDER BY BINARY Host LIMIT 65', [selected.user])
    : await read('SELECT User,Host,account_locked FROM mysql.user WHERE BINARY User=BINARY ? AND BINARY Host=BINARY ? LIMIT 2',
      [selected.user, selected.host]);
  const exact = rows.filter(row => row[0] === selected.user && row[1] === selected.host && row[2] === (kind === 'role' ? 'Y' : 'N'));
  if (exact.length !== 1 || rows.length > 64 || rows.some(([user, , flag]) => user !== selected.user || !['Y', 'N'].includes(flag)) ||
      (maria ? kind === 'role' ? rows.length !== 1 : rows.some(row => row[2] === 'Y') : rows.length !== 1)) {
    throw fail('The exact ' + kind + ' is unavailable or ambiguous in the authorization dictionary.');
  }
  return { ...selected, [field]: exact[0][2] };
}

async function explicitRoles(read, identity, selected) {
  const roles = await assignedRoles(read, identity.dialect, selected);
  if (roles.visibility !== 'observed' || roles.entries.length > 128) throw fail('A complete visible direct role list within 128 entries is required.');
  const entries = roles.entries.map(item => ({ ...roleRef(item), adminOption: item.grantable })).sort(compare);
  if (new Set(entries.map(key)).size !== entries.length) throw fail('The observed role membership dictionary is ambiguous.');
  return entries;
}

async function loginDefaults(read, identity, target) {
  if (identity.dialect === 'mariadb') {
    const rows = await read('SELECT default_role FROM mysql.user WHERE BINARY User=BINARY ? AND BINARY Host=BINARY ? LIMIT 2',
      [target.user, target.host]);
    if (rows.length !== 1 || typeof rows[0][0] !== 'string') throw fail('The member default role is unavailable.');
    return rows[0][0] ? [{ user: rows[0][0], host: '' }] : [];
  }
  const rows = await read('SELECT DEFAULT_ROLE_USER,DEFAULT_ROLE_HOST FROM mysql.default_roles WHERE BINARY USER=BINARY ? AND BINARY HOST=BINARY ? ' +
    'ORDER BY BINARY DEFAULT_ROLE_USER,BINARY DEFAULT_ROLE_HOST LIMIT 129', [target.user, target.host]);
  if (rows.length > 128 || rows.some(row => typeof row[0] !== 'string' || typeof row[1] !== 'string')) throw fail('The member default roles exceed the review scope.');
  return rows.map(([user, host]) => ({ user, host })).sort(compare);
}

async function serverPolicy(read, identity) {
  const rows = await read(identity.dialect === 'mysql'
    ? 'SELECT CURRENT_ROLE(),@@GLOBAL.mandatory_roles,@@GLOBAL.activate_all_roles_on_login'
    : 'SELECT CURRENT_ROLE()');
  if (rows.length !== 1 || rows[0][0] !== null && typeof rows[0][0] !== 'string') throw fail('The current role context is unavailable.');
  if (identity.dialect === 'mariadb') return { activeRoles: rows[0][0], automaticActivation: false };
  if (rows[0][1] !== '' || ![0, 1].includes(Number(rows[0][2])))
    throw fail('Review servers with mandatory role policy separately.');
  return { activeRoles: rows[0][0], automaticActivation: Number(rows[0][2]) === 1 };
}

async function inspect(transport, session, target) {
  const read = (sql, values) => transport._read(session, sql, values);
  const identity = await transport._identity(session), own = currentAccount(identity.currentUser);
  if (allowSchema(identity.database.toLowerCase()) || identity.dialect === 'mariadb' && !identity.sqlMode.split(',').includes('NO_AUTO_CREATE_USER'))
    throw fail('Use an application schema and a server mode without implicit account creation.');
  if (key(own) === key(target.account) || key(target.account) === key(target.role))
    throw fail('Choose a distinct role and another login account.');
  const policy = await serverPolicy(read, identity);
  const role = await exactPrincipal(read, identity, target.role, 'role');
  const member = await exactPrincipal(read, identity, target.account, 'account');
  const authority = (await explicitRoles(read, identity, own)).find(item => key(item) === key(target.role) && item.adminOption);
  if (!authority) throw fail('The acting account needs observed direct ADMIN OPTION for this exact role.');
  const membership = await explicitRoles(read, identity, target.account);
  const defaults = await loginDefaults(read, identity, target.account);
  if (defaults.some(item => key(item) === key(target.role))) throw fail('This direct membership is a default role. Review default activation separately.');
  const graph = await inspectRoleInheritance(read, { ...identity, account: identity.currentUser }, target.role);
  if (graph.visibility !== 'observed') throw fail('The role inheritance graph is unavailable within the review limits.');
  if (graph.roles.some(item => key(item.identity) === key(target.account)))
    throw fail('The selected login already appears in this role inheritance graph.');
  const positiveGrants = await rolePrivileges(read, target.role);
  return { identity, policy, role, member, authority, membership, defaults, graph, positiveGrants };
}

function availableRoles(lease) {
  const transport = lease.db._schemaRenamer;
  return transport._withSession(async session => {
    const identity = await transport._identity(session);
    const read = (sql, values) => transport._read(session, sql, values);
    const actor = currentAccount(identity.currentUser), all = await explicitRoles(read, identity, actor);
    const roles = [];
    for (const edge of all.filter(item => item.adminOption)) {
      try {
        const principal = authorizationName(edge, 'role', identity.dialect);
        await exactPrincipal(read, identity, principal, 'role');
        roles.push(principal);
      } catch { /* List only exact observed delegated roles. */ }
    }
    const flag = identity.dialect === 'mysql' ? 'account_locked' : 'is_role';
    const rows = await read("SELECT User,Host FROM mysql.user WHERE " + flag + "='N' ORDER BY BINARY User,BINARY Host LIMIT 501");
    if (rows.length > 500) throw fail('The visible login account list exceeds 500 entries.');
    const accounts = rows.flatMap(([user, host]) => {
      try {
        const candidate = authorizationName({user,host}, 'account', identity.dialect);
        return key(candidate) === key(actor) ? [] : [candidate];
      } catch { return []; }
    });
    if (!lease.guard()) throw fail('The administrator connection changed.');
    return { dialect: identity.dialect, actor, roles, accounts };
  });
}

function plan(lease, input) {
  const transport = lease.db._schemaRenamer;
  return transport._withSession(async session => {
    const identity = await transport._identity(session), target = request(input, identity.dialect);
    const before = await inspect(transport, session, target);
    if (!same(identity, before.identity) || !lease.guard()) throw fail('The administrator connection changed.');
    return { target, before, expected: expectedRoles(before.membership, target), sql: sqlFor(target, identity.dialect) };
  });
}

function result(state, acknowledged, membership) {
  return { state, acknowledged, ...(membership && { membership }), scope: 'explicit-direct-membership',
    effectiveAccessCalculated: false, credentialsIncluded: false, automaticRetry: false };
}

function apply(lease, reviewed) {
  const transport = lease.db._schemaRenamer;
  return transport._withSession(async session => {
    const fresh = await inspect(transport, session, reviewed.target);
    if (!same(fresh, reviewed.before) || !lease.guard()) throw fail('The administrator, role or membership changed after review.');
    const sql = sqlFor(reviewed.target, fresh.identity.dialect);
    if (sql !== reviewed.sql) throw fail('The reviewed membership statement changed.');
    const expected = { ...fresh, membership: reviewed.expected };
    let acknowledged = false;
    try {
      const response = await lease.db._control(session, sql);
      acknowledged = true;
      if (response?.warningStatus) return result('uncertain', true);
    } catch {
      if (session.connected && lease.guard()) {
        try {
          if (same(await inspect(transport, session, reviewed.target), fresh) && lease.guard()) return result('rejected', false);
        } catch { /* A lost observation requires a new review. */ }
      }
      return result('uncertain', false);
    }
    try {
      const after = await inspect(transport, session, reviewed.target);
      if (same(after, expected) && lease.guard()) return result('verified', acknowledged, after.membership);
    } catch { /* Do not retry an acknowledged privilege statement. */ }
    return result('uncertain', acknowledged);
  });
}

module.exports = { availableRoles, plan, apply, request, sqlFor, expectedRoles };
