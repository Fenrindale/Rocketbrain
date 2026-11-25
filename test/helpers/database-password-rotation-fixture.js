'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path');
const {randomBytes}=require('node:crypto');
const randomPassword=()=>randomBytes(25).toString('base64url');

async function preparePasswordRotationFixture(fixture) {
  const {db,dbEngine}=fixture,folder=path.dirname(await fs.realpath(db.configPath));
  const marker=JSON.parse(await fs.readFile(path.join(folder,'owner.json'),'utf8'));
  assert.equal(marker.kind,dbEngine==='mariadb'?'RocketbrainDisposableMariaDbFixture-v1':'RocketbrainDisposableOracleMysqlFixture-v1');
  assert.equal(marker.id,path.basename(folder));
  assert.equal(db.config.host,'127.0.0.1');
  assert.equal(db.config.database,'rocketbrain_fixture');
  const tag=randomBytes(5).toString('hex'),host=db.config.host;
  const profile=label=>({...db.config,user:'rb_rotate_'+label+'_'+tag,password:randomPassword()});
  const writer=profile('admin'),reader=profile('observe'),target=profile('target'),locked=profile('locked'),
    expired=profile('expired'),alternate=profile('alternate');
  const role='rb_rotate_role_'+tag;
  const roleSql=dbEngine==='mysql'?"'"+role+"'@'%'":role;
  const shared='User,Host,plugin,authentication_string,password_expired,ssl_type,ssl_cipher,x509_issuer,x509_subject,'+
    'max_questions,max_updates,max_connections,max_user_connections,Create_user_priv,Grant_priv,Super_priv';
  const userFields=dbEngine==='mysql'
    ? shared+',account_locked,User_attributes,password_lifetime,Password_reuse_history,Password_reuse_time,Password_require_current'
    : shared+',is_role,default_role';
  await db.withAdmin(async actor=>{
    for (const account of [writer,reader,target,locked,expired,alternate]) {
      await actor.query('CREATE USER ?@? IDENTIFIED BY ?',[account.user,host,account.password]);
    }
    await actor.query('CREATE ROLE '+roleSql);
    await actor.query('GRANT SELECT ON rocketbrain_fixture.rb_spring_person TO '+roleSql);
    await actor.query('GRANT '+roleSql+' TO ?@?',[target.user,host]);
    const defaultRole='SET DEFAULT ROLE '+roleSql+(dbEngine==='mysql'?' TO ?@?':' FOR ?@?');
    await actor.query(defaultRole,[target.user,host]);
    await actor.query('ALTER USER ?@? WITH MAX_QUERIES_PER_HOUR 1500 MAX_UPDATES_PER_HOUR 500',[target.user,host]);
    await actor.query('ALTER USER ?@? ACCOUNT LOCK',[locked.user,host]);
    await actor.query('ALTER USER ?@? PASSWORD EXPIRE',[expired.user,host]);
    if(dbEngine==='mysql') {
      await actor.query('ALTER USER ?@? IDENTIFIED BY ? RETAIN CURRENT PASSWORD',[alternate.user,host,randomPassword()]);
    } else {
      await actor.query('ALTER USER ?@? IDENTIFIED VIA mysql_native_password USING PASSWORD(?) OR mysql_old_password USING PASSWORD(?)',
        [alternate.user,host,randomPassword(),randomPassword()]);
    }
    await actor.query('GRANT CREATE USER ON *.* TO ?@?',[writer.user,host]);
    for (const account of [writer,reader]) {
      await actor.query('GRANT SELECT ON rocketbrain_fixture.rb_spring_person TO ?@?',[account.user,host]);
      await actor.query('GRANT SELECT ('+userFields+') ON mysql.user TO ?@?',[account.user,host]);
      if(dbEngine==='mysql') {
        await actor.query('GRANT SELECT (FROM_USER,FROM_HOST,TO_USER,TO_HOST,WITH_ADMIN_OPTION) ON mysql.role_edges TO ?@?',[account.user,host]);
        await actor.query('GRANT SELECT (USER,HOST,DEFAULT_ROLE_USER,DEFAULT_ROLE_HOST) ON mysql.default_roles TO ?@?',[account.user,host]);
      } else {
        await actor.query('GRANT SELECT (User,Host,Priv) ON mysql.global_priv TO ?@?',[account.user,host]);
        await actor.query('GRANT SELECT (User,Host,Role,Admin_option) ON mysql.roles_mapping TO ?@?',[account.user,host]);
      }
    }
  });
  const descriptor=path.join(folder,'password-rotation-'+tag+'.json');
  await fs.writeFile(descriptor,JSON.stringify({format:'RocketbrainOwnedRotation',owner:marker.id,dbConfigPath:db.configPath,
    engine:dbEngine,writer,reader,target,locked,expired,alternate,role}),{flag:'wx',mode:0o600});
  return descriptor;
}

module.exports={preparePasswordRotationFixture};
