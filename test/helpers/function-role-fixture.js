'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const mysql = require('mysql2/promise');
const { prepareFunctionGrantFixture } = require('./function-grant-fixture');

const accountSql = ({ user, host }) => mysql.escape(user) + '@' + mysql.escape(host);
const roleSql = (dialect, role) => dialect === 'mysql' ? accountSql({ user: role, host: '%' }) : mysql.escapeId(role, true);
const defaultRoleSql = (dialect, role, account, enabled = true) => 'SET DEFAULT ROLE ' +
  (enabled ? roleSql(dialect, role) : 'NONE') + (dialect === 'mysql' ? ' TO ' : ' FOR ') + accountSql(account);

async function prepareFunctionRoleFixture(owned) {
  const inherited = await prepareFunctionGrantFixture(owned);
  const { owner, engine, publisher, guests, dbConfigPath } = JSON.parse(await fs.readFile(inherited, 'utf8'));
  const suffix = publisher.user.split('_').at(-1);
  const role = 'rb_function_role_' + suffix, nested = 'rb_function_nested_' + suffix;
  await owned.db.withAdmin(async connection => {
    for (const name of [role, nested]) await connection.query('CREATE ROLE ' + roleSql(engine, name));
    await connection.query('GRANT ' + roleSql(engine, role) + ' TO ' + roleSql(engine, nested));
    await connection.query('GRANT ' + roleSql(engine, nested) + ' TO ' + accountSql(guests[0]));
    await connection.query(defaultRoleSql(engine, nested, guests[0]));
  });
  const result = path.join(path.dirname(inherited), 'function-role-' + suffix + '.json');
  await fs.writeFile(result, JSON.stringify({ kind: 'RocketbrainOwnedFunctionRole-v1', owner, engine, publisher, guests,
    dbConfigPath, role, nested }), { flag: 'wx', mode: 0o600 });
  return result;
}

module.exports = { prepareFunctionRoleFixture, accountSql, roleSql, defaultRoleSql };
