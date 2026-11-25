'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

async function preparePasswordFreeFixture({db,dbEngine}) {
  const folder = path.dirname(db.configPath);
  const owner = JSON.parse(await fs.readFile(path.join(folder,'owner.json'),'utf8'));
  const marker = {mysql:'RocketbrainDisposableOracleMysqlFixture-v1',mariadb:'RocketbrainDisposableMariaDbFixture-v1'};
  assert.equal(owner.kind,marker[dbEngine]);
  assert.equal(owner.id,db.id);
  assert.equal(db.config.host,'127.0.0.1');
  assert.equal(db.config.database,'rocketbrain_fixture');
  const suffix = randomBytes(5).toString('hex');
  const openUser = 'rb_nopass_' + suffix, protectedUser = 'rb_auth_' + suffix, unknownUser = 'rb_other_' + suffix;
  const protectedPassword = randomBytes(24).toString('base64url');
  const mysql = dbEngine === 'mysql';
  const plugin = mysql ? 'caching_sha2_password' : 'mysql_native_password';
  const clause = mysql ? 'IDENTIFIED WITH caching_sha2_password BY ?' : 'IDENTIFIED VIA mysql_native_password USING PASSWORD(?)';
  await db.withAdmin(async connection => {
    for (const [user,password] of [[openUser,''],[protectedUser,protectedPassword],['','']]) {
      await connection.query('CREATE USER ?@? '+clause,[user,db.config.host,password]);
      await connection.query('GRANT SELECT ON rocketbrain_fixture.rb_spring_person TO ?@?',[user,db.config.host]);
    }
    const [rows] = await connection.query('SELECT User,plugin FROM mysql.user WHERE Host=? AND User IN (?,?)',
      [db.config.host,openUser,protectedUser]);
    assert.equal(rows.length,2);
    assert.ok(rows.every(row=>row.plugin===plugin));
  });
  const file = path.join(folder,'password-free-'+suffix+'.json');
  await fs.writeFile(file,JSON.stringify({kind:'RocketbrainPasswordFreeFixture-v1',owner:owner.id,dbConfigPath:db.configPath,
    engine:dbEngine,plugin,openUser,protectedUser,protectedPassword,unknownUser})+String.fromCharCode(10),{flag:'wx',mode:0o600});
  return file;
}

module.exports={preparePasswordFreeFixture};
