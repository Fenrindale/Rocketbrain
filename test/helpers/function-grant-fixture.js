'use strict';

const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {randomBytes}=require('node:crypto');

async function prepareFunctionGrantFixture({db,dbEngine}) {
  const folder=path.dirname(await fs.realpath(db.configPath));
  const owner=JSON.parse(await fs.readFile(path.join(folder,'owner.json'),'utf8'));
  const marker={mysql:'RocketbrainDisposableOracleMysqlFixture-v1',mariadb:'RocketbrainDisposableMariaDbFixture-v1'};
  assert.equal(owner.kind,marker[dbEngine]);assert.equal(owner.id,db.id);
  assert.equal(db.config.host,'127.0.0.1');assert.equal(db.config.database,'rocketbrain_fixture');
  const suffix=randomBytes(5).toString('hex'),host=db.config.host;
  const route=label=>({...db.config,user:'rb_grant_'+label+'_'+suffix,password:randomBytes(24).toString('base64url')});
  const publisher=route('owner'),guests=[route('a'),route('b')];
  await db.withAdmin(async connection=>{
    await connection.query('CREATE USER ?@? IDENTIFIED BY ?',[publisher.user,host,publisher.password]);
    await connection.query('GRANT ALL PRIVILEGES ON rocketbrain_fixture.* TO ?@? WITH GRANT OPTION',[publisher.user,host]);
    await connection.query('GRANT SELECT, SHOW VIEW, TRIGGER, EVENT ON *.* TO ?@?',[publisher.user,host]);
    for(const guest of guests){
      await connection.query('CREATE USER ?@? IDENTIFIED BY ?',[guest.user,host,guest.password]);
      await connection.query('GRANT SELECT ON rocketbrain_fixture.rb_spring_person TO ?@?',[guest.user,host]);
    }
  });
  const config=path.join(folder,'function-grants-'+suffix+'.json');
  await fs.writeFile(config,JSON.stringify({kind:'RocketbrainOwnedFunctionGrants-v1',owner:owner.id,engine:dbEngine,
    dbConfigPath:db.configPath,publisher,guests}),{flag:'wx',mode:0o600});
  return config;
}

module.exports={prepareFunctionGrantFixture};
