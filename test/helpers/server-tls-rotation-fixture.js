'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path');
const {randomBytes}=require('node:crypto');
const {ROOT,KIND}=require('../../scripts/connection-security-fixture');
const dbMarkers={mysql:'RocketbrainDisposableOracleMysqlFixture-v1',mariadb:'RocketbrainDisposableMariaDbFixture-v1'};
const read=async file=>JSON.parse(await fs.readFile(file,'utf8'));

async function validateTlsFixture(configPath,certificatePath,engine) {
  const folder=await fs.realpath(path.dirname(configPath)),certFolder=await fs.realpath(certificatePath);
  const config=await read(configPath),owner=await read(path.join(folder,'owner.json')),certificateOwner=await read(path.join(certFolder,'owner.json'));
  assert.equal(config.host,'127.0.0.1');
  assert.equal(config.database,'rocketbrain_fixture');
  assert.equal(owner.kind,dbMarkers[engine]);
  assert.equal(certificateOwner.kind,KIND);
  assert.equal(path.basename(certFolder),certificateOwner.id);
  assert.equal(path.dirname(certFolder),await fs.realpath(ROOT));
  for(const name of ['tls-ca.pem','tls-cert.pem','tls-key.pem']) {
    const filename=path.join(folder,name);
    assert.equal(await fs.realpath(filename),filename);
    assert.ok((await fs.stat(filename)).isFile());
  }
  return {folder,certFolder,owner:owner.id,certificateOwner:certificateOwner.id,config};
}

async function prepareTlsRotationFixture(db,certificates,engine) {
  const verified=await validateTlsFixture(db.configPath,certificates.folder,engine);
  assert.equal(db.id,verified.owner);
  assert.equal(certificates.id,verified.certificateOwner);
  const actor={user:'rb_tls_rotate_'+randomBytes(5).toString('hex'),password:randomBytes(24).toString('base64url')};
  await db.withAdmin(async connection=>{
    await connection.query('CREATE USER ?@? IDENTIFIED BY ?',[actor.user,db.config.host,actor.password]);
    await connection.query('GRANT '+(engine==='mysql'?'CONNECTION_ADMIN':'RELOAD')+' ON *.* TO ?@?',[actor.user,db.config.host]);
  });
  const file=path.join(verified.folder,'tls-trust-rotation.json');
  await fs.writeFile(file,JSON.stringify({kind:'RocketbrainTlsRotationFixture-v1',engine,owner:verified.owner,
    certificateOwner:verified.certificateOwner,dbConfigPath:db.configPath,certFolder:verified.certFolder,actor}),
    {flag:'wx',mode:0o600});
  return file;
}

module.exports={validateTlsFixture,prepareTlsRotationFixture};
