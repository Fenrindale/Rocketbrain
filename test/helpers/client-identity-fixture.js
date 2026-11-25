'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path');
const crypto = require('node:crypto');

async function prepareClientIdentityFixture(db, cert, descriptor) {
  const owner = JSON.parse(await fs.readFile(path.join(db.folder,'owner.json'),'utf8'));
  assert.match(owner.kind,/^RocketbrainDisposable(?:OracleMysql|MariaDb)Fixture-v1$/u);
  assert.equal(owner.id,db.id);
  assert.equal(db.config.host,'127.0.0.1');
  const user = 'rb_client_' + crypto.randomBytes(5).toString('hex'), password = crypto.randomBytes(24).toString('base64url');
  await db.withAdmin(async admin => {
    await admin.query('CREATE USER ?@? IDENTIFIED BY ? REQUIRE X509',[user,'127.0.0.1',password]);
    await admin.query('GRANT SELECT, SHOW VIEW ON rocketbrain_fixture.* TO ?@?',[user,'127.0.0.1']);
    const [[policy]] = await admin.query('SHOW CREATE USER ?@?',[user,'127.0.0.1']);
    assert.match(Object.values(policy)[0],/REQUIRE X509/u);
  });
  await fs.writeFile(descriptor,JSON.stringify({format:'RocketbrainOwnedClientIdentityFixture',id:db.id,
    dbConfigPath:db.configPath,user,password,passphrase:cert.passphrase,folder:cert.folder}),{flag:'wx',mode:0o600});
  return descriptor;
}

module.exports = { prepareClientIdentityFixture };
