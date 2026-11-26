'use strict';

const { createHash } = require('node:crypto');
const { principal } = require('./database-principal-create');

const fail = message => Object.assign(Error(message), { code: 'ROCKETBRAIN_OBJECT_EDITOR' });
const identity = (user, host) => JSON.stringify([user, host]);
const rootLimit = 8;
const principalLimit = 24;
const edgeLimit = 64;
const depthLimit = 8;

const mysqlPrincipal = 'SELECT User,Host,account_locked,(CHAR_LENGTH(authentication_string)=0) ' +
  'FROM mysql.user WHERE BINARY User=BINARY ? AND BINARY Host=BINARY ? LIMIT 2';
const mariaPrincipal = "SELECT u.User,u.Host,u.is_role,COALESCE(JSON_VALUE(p.Priv,'$.account_locked'), 'false') " +
  'FROM mysql.user u JOIN mysql.global_priv p ON BINARY p.User=BINARY u.User AND BINARY p.Host=BINARY u.Host ' +
  'WHERE BINARY u.User=BINARY ? AND BINARY u.Host=BINARY ? LIMIT 2';

async function resolvePrincipal(read, user, host, dialect) {
  const mysql = dialect === 'mysql';
  const found = await read(mysql ? mysqlPrincipal : mariaPrincipal, [user, host]);
  if (found.length !== 1 || found[0][0] !== user || found[0][1] !== host || !['Y', 'N'].includes(found[0][2])) {
    throw fail('A reviewed role or member no longer has an exact visible authorization identity.');
  }
  const [, , flag, policy] = found[0];
  if (!(mysql ? [0, 1].includes(Number(policy)) : ['true', 'false', '0', '1'].includes(String(policy)))) {
    throw fail('A reviewed role or member has unknown login policy.');
  }
  const isRole = mysql ? flag === 'Y' && host === '%' && Number(policy) === 1 : flag === 'Y';
  if (isRole) {
    const role = principal({ kind: 'role', user }, dialect);
    if (role.host !== host) throw fail('A role host is outside the supported observed convention.');
    return role;
  }
  const account = principal({ kind: 'account', user, host }, dialect);
  if (account.host !== host) throw fail('A role member host does not match its exact catalog identity.');
  if (mysql && (await read('SELECT 1 FROM mysql.role_edges WHERE BINARY FROM_USER=BINARY ? AND BINARY FROM_HOST=BINARY ? LIMIT 1',
    [user, host])).length) {
    throw fail('A nested MySQL role uses credentials or a host outside the reviewed locked-role convention.');
  }
  if (mysql ? flag === 'Y' : ['true', '1'].includes(String(policy))) return { ...account, locked: true };
  return { ...account, locked: false };
}

async function directMembers(read, role, dialect) {
  const sql = dialect === 'mysql'
    ? 'SELECT e.TO_USER,e.TO_HOST,e.WITH_ADMIN_OPTION,IF(d.USER IS NULL,0,1) FROM mysql.role_edges e ' +
      'LEFT JOIN mysql.default_roles d ON BINARY d.USER=BINARY e.TO_USER AND BINARY d.HOST=BINARY e.TO_HOST ' +
      'AND BINARY d.DEFAULT_ROLE_USER=BINARY e.FROM_USER AND BINARY d.DEFAULT_ROLE_HOST=BINARY e.FROM_HOST ' +
      'WHERE BINARY e.FROM_USER=BINARY ? AND BINARY e.FROM_HOST=BINARY ? ORDER BY BINARY e.TO_USER,BINARY e.TO_HOST'
    : 'SELECT e.User,e.Host,e.Admin_option,IF(BINARY u.default_role=BINARY e.Role,1,0) FROM mysql.roles_mapping e ' +
      'LEFT JOIN mysql.user u ON BINARY u.User=BINARY e.User AND BINARY u.Host=BINARY e.Host ' +
      'WHERE BINARY e.Role=BINARY ? ORDER BY BINARY e.User,BINARY e.Host';
  const rows = await read(sql + ' LIMIT ' + (edgeLimit + 1), dialect === 'mysql' ? [role.user, role.host] : [role.user]);
  if (rows.length > edgeLimit || rows.some(row => !['Y', 'N'].includes(row[2]) || ![0, 1].includes(Number(row[3])))) {
    throw fail('A role membership exceeds the review limit or has unsupported catalog fields.');
  }
  return rows;
}

async function observeRoleAccess(read, user, host, dialect) {
  const role = await resolvePrincipal(read, user, host, dialect);
  if (role.kind !== 'role') throw fail('A retained role EXECUTE grantee is no longer a supported role.');
  let activateAllOnLogin = null;
  if (dialect === 'mysql') {
    const [[automatic, mandatory] = []] = await read('SELECT @@GLOBAL.activate_all_roles_on_login,@@GLOBAL.mandatory_roles');
    if (mandatory !== '' || ![0, 1].includes(Number(automatic))) {
      throw fail('Reviewed role EXECUTE requires readable activation policy without implicit mandatory roles.');
    }
    activateAllOnLogin = Number(automatic) === 1;
  }
  const root = identity(user, host);
  const nodes = new Map([[root, role]]), memberships = [];
  const pending = [role];
  for (const current of pending) {
    const members = await directMembers(read, current, dialect);
    if (current === role && !members.length && dialect === 'mysql') {
      throw fail('A MySQL role EXECUTE grantee must have an observed explicit role assignment.');
    }
    for (const [memberUser, memberHost, admin, byDefault] of members) {
      const key = identity(memberUser, memberHost);
      if (memberships.length >= edgeLimit) throw fail('Role membership exceeds the reviewed edge limit.');
      if (!nodes.has(key)) {
        if (nodes.size >= principalLimit) throw fail('Role membership exceeds the reviewed principal limit.');
        const member = await resolvePrincipal(read, memberUser, memberHost, dialect);
        nodes.set(key, member);
        if (member.kind === 'role') pending.push(member);
      }
      memberships.push({ role: [current.user, current.host], member: [memberUser, memberHost],
        adminOption: admin === 'Y', defaultRole: Number(byDefault) === 1 });
    }
  }
  checkTopology(root, nodes, memberships);
  const value = { user, host, activateAllOnLogin, principals: [...nodes.values()], memberships };
  return { ...value, fingerprint: createHash('sha256').update(JSON.stringify(value)).digest('hex') };
}

function checkTopology(root, nodes, memberships) {
  const children = new Map(), visited = new Set(), depth = new Map();
  for (const edge of memberships) {
    const from = identity(...edge.role), to = identity(...edge.member);
    if (nodes.get(from)?.kind !== 'role' || !nodes.has(to)) throw fail('A role membership has an unresolved endpoint.');
    if (!children.has(from)) children.set(from, new Set());
    if (children.get(from).has(to)) throw fail('A role membership occurs more than once.');
    children.get(from).add(to);
  }
  const height = node => {
    if (depth.has(node)) return depth.get(node);
    if (visited.has(node)) throw fail('The role membership contains a cycle.');
    visited.add(node);
    const value = 1 + Math.max(0, ...Array.from(children.get(node) || [], height));
    visited.delete(node);
    depth.set(node, value);
    return value;
  };
  if (height(root) > depthLimit + 1 || depth.size !== nodes.size) throw fail('Role membership exceeds the reviewed depth or contains unreachable entries.');
}

function validateRoleAccess(entry, dialect) {
  const { fingerprint, user, host, activateAllOnLogin, principals, memberships, ...rest } = entry || {};
  const root = principal({ kind: 'role', user }, dialect);
  const value = { user, host, activateAllOnLogin, principals, memberships };
  if (Object.keys(rest).length || root.host !== host || !Array.isArray(principals) || !principals.length || principals.length > principalLimit ||
      !Array.isArray(memberships) || memberships.length > edgeLimit ||
      (dialect === 'mysql' ? typeof activateAllOnLogin !== 'boolean' : activateAllOnLogin !== null) ||
      fingerprint !== createHash('sha256').update(JSON.stringify(value)).digest('hex')) {
    throw fail('The retained role-membership inventory is malformed.');
  }
  const nodes = new Map();
  for (const node of principals) {
    const normalized = principal(node?.kind === 'role' ? { kind: 'role', user: node.user } :
      { kind: 'account', user: node?.user, host: node?.host }, dialect);
    if (normalized.kind === 'account' && typeof node.locked === 'boolean') normalized.locked = node.locked;
    const key = identity(node.user, node.host);
    if (nodes.has(key) || JSON.stringify(normalized) !== JSON.stringify(node)) throw fail('A retained role identity is malformed.');
    nodes.set(key, node);
  }
  if (memberships.some(edge => !edge || Object.keys(edge).length !== 4 || ![edge.role, edge.member].every(endpoint =>
    Array.isArray(endpoint) && endpoint.length === 2 && endpoint.every(part => typeof part === 'string')) ||
    typeof edge.adminOption !== 'boolean' || typeof edge.defaultRole !== 'boolean')) throw fail('A retained role membership is malformed.');
  const rootKey = identity(user, host);
  if (nodes.get(rootKey)?.kind !== 'role') throw fail('The retained root role is missing.');
  checkTopology(rootKey, nodes, memberships);
  return root;
}

module.exports = { observeRoleAccess, validateRoleAccess, rootLimit };
