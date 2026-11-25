'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path');
const {randomBytes}=require('node:crypto');
const password=()=>randomBytes(24).toString('base64url');

async function prepareAccountAccessFixture({db,dbEngine}) {
  const folder=path.dirname(await fs.realpath(db.configPath));
  const owner=JSON.parse(await fs.readFile(path.join(folder,'owner.json'),'utf8'));
  const marker={mysql:'RocketbrainDisposableOracleMysqlFixture-v1',mariadb:'RocketbrainDisposableMariaDbFixture-v1'};
  assert.equal(owner.kind,marker[dbEngine]);
  assert.equal(owner.id,db.id);
  const {host,database}=db.config;
  assert.equal(host,'127.0.0.1');
  assert.equal(database,'rocketbrain_fixture');
  const tag=randomBytes(5).toString('hex'), mysql=dbEngine==='mysql';
  const account=(label,pass=password())=>({...db.config,user:'rb_acl_'+label+'_'+tag,password:pass});
  const actor=account('admin'),limited=account('limit'),target=account('target'),empty=account('empty','');
  const remote='rb_acl_schema_'+tag,view='rb_acl_v_'+tag,invoker='rb_acl_iv_'+tag,routine='rb_acl_p_'+tag,
    trigger='rb_acl_t_'+tag,event='rb_acl_e_'+tag,input='rb_acl_in_'+tag,audit='rb_acl_log_'+tag,role='rb_acl_r_'+tag;
  const roleSql=mysql?"'"+role+"'@'%'":role;
  const qualified=name=>database+'.'+name;
  const principal=[target.user,host];
  await db.withAdmin(async connection=>{
    const method=mysql?'IDENTIFIED WITH caching_sha2_password BY ?':'IDENTIFIED VIA mysql_native_password USING PASSWORD(?)';
    for(const item of [actor,limited,target,empty]){
      await connection.query('CREATE USER ?@? '+method,[item.user,host,item.password]);
    }
    await connection.query('GRANT SELECT, SHOW VIEW, TRIGGER, EVENT, CREATE USER ON *.* TO ?@?',[actor.user,host]);
    await connection.query('GRANT SELECT ON mysql.* TO ?@?',[limited.user,host]);
    await connection.query('GRANT SELECT ON '+database+'.* TO ?@?',[limited.user,host]);
    await connection.query('GRANT CREATE USER ON *.* TO ?@?',[limited.user,host]);
    await connection.query('CREATE DATABASE '+remote);
    await connection.query('CREATE TABLE '+qualified(input)+'(id INT PRIMARY KEY)');
    await connection.query('CREATE TABLE '+qualified(audit)+'(id INT PRIMARY KEY)');
    await connection.query('GRANT SELECT ON '+qualified('rb_spring_person')+' TO ?@?',principal);

    await connection.query('GRANT TRIGGER ON '+qualified(input)+' TO ?@?',principal);
    await connection.query('GRANT SELECT ON '+qualified(input)+' TO ?@?',principal);
    await connection.query('GRANT INSERT ON '+qualified(audit)+' TO ?@?',principal);
    await connection.query('GRANT SELECT ON '+qualified('rb_spring_person')+' TO ?@?',[empty.user,host]);
    await connection.query('CREATE ROLE '+roleSql);
    await connection.query('GRANT SELECT ON '+qualified(audit)+' TO '+roleSql);
    await connection.query('GRANT '+roleSql+' TO ?@?',principal);
    await connection.query('SET DEFAULT ROLE '+roleSql+(mysql?' TO ?@?':' FOR ?@?'),principal);
    await connection.query('ALTER USER ?@? WITH MAX_QUERIES_PER_HOUR 1700',principal);
    await connection.query('CREATE DEFINER=?@? SQL SECURITY DEFINER VIEW '+qualified(view)+' AS SELECT id FROM '+qualified('rb_spring_person'),principal);
    await connection.query('GRANT CREATE VIEW, DROP ON '+qualified(view)+' TO ?@?',principal);
    await connection.query('CREATE DEFINER=?@? SQL SECURITY INVOKER VIEW '+remote+'.'+invoker+' AS SELECT id FROM '+qualified('rb_spring_person'),principal);
    await connection.query('GRANT SELECT ON '+remote+'.'+invoker+' TO ?@?',[db.config.user,host]);
    await connection.query('CREATE DEFINER=?@? PROCEDURE '+qualified(routine)+'() SQL SECURITY DEFINER READS SQL DATA SELECT COUNT(*) n FROM '+qualified('rb_spring_person'),principal);
    await connection.query('GRANT EXECUTE ON PROCEDURE '+qualified(routine)+' TO ?@?',principal);
    await connection.query('CREATE DEFINER=?@? TRIGGER '+qualified(trigger)+' AFTER INSERT ON '+qualified(input)+
      ' FOR EACH ROW INSERT INTO '+qualified(audit)+' VALUES (NEW.id)',principal);
    await connection.query('CREATE DEFINER=?@? EVENT '+qualified(event)+' ON SCHEDULE AT CURRENT_TIMESTAMP + INTERVAL 1 DAY DISABLE DO INSERT INTO '+qualified(audit)+' VALUES (999)',principal);
  });
  const file=path.join(folder,'account-access-'+tag+'.json');
  await fs.writeFile(file,JSON.stringify({kind:'RocketbrainOwnedAccountAccess-v1',owner:owner.id,engine:dbEngine,
    dbConfigPath:db.configPath,actor,limited,target,empty,objects:{remote,view,invoker,routine,trigger,event,input,audit}}),
    {flag:'wx',mode:0o600});
  return file;
}

module.exports={prepareAccountAccessFixture};
