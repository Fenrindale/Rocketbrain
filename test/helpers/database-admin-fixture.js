'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const assert = require('node:assert/strict');

async function prepareDatabaseAdminFixture(fixture, { allowPrincipalCreation = false, allowRoleInheritance = false } = {}) {
  const { db, dbEngine } = fixture;
  const source = db.config, folder = path.dirname(db.configPath);
  const marker = JSON.parse(await fs.readFile(path.join(folder, 'owner.json')));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(marker.kind));
  assert.equal(source.host, '127.0.0.1');
  assert.equal(source.database, 'rocketbrain_fixture');
  assert.ok(['mariadb', 'mysql'].includes(dbEngine));
  const tag = randomBytes(5).toString('hex');
  const admin = { ...source, user: 'rb_acl_writer_' + tag, password: randomBytes(24).toString('base64url') };
  const guest = { ...source, user: 'rb_acl_guest_' + tag, password: randomBytes(24).toString('base64url') };
  const role = 'rb_acl_role_' + tag;
  const roleName = name => dbEngine === 'mysql' ? "'" + name + "'@'%'" : '`' + name + '`';
  const roleSql = roleName(role);
  const nested = allowRoleInheritance ? { table: 'rb_acl_chain_' + tag,
    root: role, middle: 'rb_acl_mid_' + tag, leaf: 'rb_acl_leaf_' + tag } : undefined;
  await db.withAdmin(async connection => {
    await connection.query('CREATE USER ?@? IDENTIFIED BY ?', [admin.user, admin.host, admin.password]);
    await connection.query('CREATE USER ?@? IDENTIFIED BY ?', [guest.user, guest.host, guest.password]);
    await connection.query('GRANT SELECT ON rocketbrain_fixture.* TO ?@? WITH GRANT OPTION', [admin.user, admin.host]);
    await connection.query('GRANT SELECT (User,Host' + (dbEngine === 'mariadb' ? ',is_role' : '') + ') ON mysql.user TO ?@?', [admin.user, admin.host]);
    if (allowPrincipalCreation) {
      await connection.query('GRANT CREATE USER ON *.* TO ?@?', [admin.user, admin.host]);
      if (dbEngine === 'mysql') await connection.query('GRANT SELECT (account_locked) ON mysql.user TO ?@?', [admin.user, admin.host]);
    }
    await connection.query('GRANT SELECT (User,Host,Db,Table_name,Table_priv,Column_priv) ON mysql.tables_priv TO ?@?', [admin.user, admin.host]);
    await connection.query(dbEngine === 'mysql'
      ? 'GRANT SELECT (FROM_USER,FROM_HOST,TO_USER,TO_HOST,WITH_ADMIN_OPTION) ON mysql.role_edges TO ?@?'
      : 'GRANT SELECT (User,Host,Role,Admin_option) ON mysql.roles_mapping TO ?@?', [admin.user, admin.host]);
    await connection.query('CREATE ROLE ' + roleSql);
    await connection.query('GRANT ' + roleSql + ' TO ?@?', [guest.user, guest.host]);
    if (nested) {
      await connection.query('CREATE TABLE rocketbrain_fixture.' + nested.table + ' (id INT PRIMARY KEY) ENGINE=InnoDB');
      await connection.query('INSERT INTO rocketbrain_fixture.' + nested.table + ' VALUES (17)');
      await connection.query('CREATE ROLE ' + roleName(nested.middle));
      await connection.query('CREATE ROLE ' + roleName(nested.leaf));
      await connection.query('GRANT ' + roleName(nested.middle) + ' TO ' + roleSql);
      await connection.query('GRANT ' + roleName(nested.leaf) + ' TO ' + roleName(nested.middle) + ' WITH ADMIN OPTION');
      await connection.query('GRANT SELECT ON rocketbrain_fixture.' + nested.table + ' TO ' + roleName(nested.leaf));
    }
  });
  const file = path.join(folder, 'database-admin-fixture-' + tag + '.json');
  await fs.writeFile(file, JSON.stringify({ format: 'RocketbrainOwnedDatabaseAdminFixture', version: 1, owner: marker.id,
    sourceConfigPath: db.configPath, engine: dbEngine, admin, guest, role, ...(nested && { nested }) }) + '\n', { flag: 'wx', mode: 0o600 });
  return file;
}

module.exports = { prepareDatabaseAdminFixture };
