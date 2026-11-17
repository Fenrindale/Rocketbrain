'use strict';
const mysql=require('mysql2/promise'),assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path');
const q=value=>'`'+value.replaceAll('`','``')+'`';
const errorDetails=error=>({code:error.code,errno:error.errno,sqlState:error.sqlState});
async function rejected(action,predicate){try{await action();}catch(error){assert.ok(predicate(error),JSON.stringify(errorDetails(error)));return errorDetails(error);}assert.fail('The expected server rejection did not occur.');}
function paired(){const file=process.env.ROCKETBRAIN_COORDINATOR_TEST_CONFIG;assert.ok(file,'Use the paired owned Spring fixtures for native atomic-DDL proof.');const descriptor=JSON.parse(fs.readFileSync(file));assert.equal(descriptor.format,'RocketbrainOwnedPairedSpringFixtures');assert.equal(descriptor.version,1);assert.deepEqual(descriptor.participants.map(p=>p.engine).sort(),['mariadb','mysql']);return descriptor.participants.map(part=>{const marker=JSON.parse(fs.readFileSync(path.join(path.dirname(part.configPath),'owner.json'))),config=JSON.parse(fs.readFileSync(part.configPath));assert.ok(['RocketbrainDisposableMariaDbFixture-v1','RocketbrainDisposableOracleMysqlFixture-v1'].includes(marker.kind));assert.equal(config.host,'127.0.0.1');return{...part,config};});}
async function engineProbe(part){
 const actor=await mysql.createConnection(part.config),observer=await mysql.createConnection(part.config),prefix='rb_atomic_'+crypto.randomBytes(6).toString('hex'),names=['data','ddl','xa','left','right','renamed','collision'].map(suffix=>prefix+'_'+suffix),[data,ddl,xa,left,right,renamed,collision]=names,xid=prefix+'_xid';let xaActive=false,xaEnded=false;
 const exists=async name=>Number((await observer.execute('SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=?',[part.config.database,name]))[0][0].n)===1;
 try{
  await actor.query('SET SESSION autocommit=1');const version=(await actor.query('SELECT VERSION() AS version'))[0][0].version;assert.equal(/mariadb/i.test(version),part.engine==='mariadb');
  await actor.query('CREATE TABLE '+q(data)+' (id INT PRIMARY KEY) ENGINE=InnoDB');await actor.query('INSERT INTO '+q(data)+' VALUES(1)');
  await actor.beginTransaction();await actor.query('INSERT INTO '+q(data)+' VALUES(2)');await actor.query('CREATE TABLE '+q(ddl)+' (id INT PRIMARY KEY) ENGINE=InnoDB');await actor.rollback();
  assert.deepEqual((await observer.query('SELECT id FROM '+q(data)+' ORDER BY id'))[0],[{id:1},{id:2}]);assert.equal(await exists(ddl),true);
  await actor.query('CREATE TABLE '+q(xa)+' (id INT PRIMARY KEY) ENGINE=InnoDB');await actor.query('XA START ?',[xid]);xaActive=true;await actor.query('INSERT INTO '+q(xa)+' VALUES(7)');
  const xaError=await rejected(()=>actor.query('ALTER TABLE '+q(xa)+' ADD blocked INT NULL'),error=>/^XAE/.test(error.sqlState||''));
  await actor.query('XA END ?',[xid]);xaActive=false;xaEnded=true;await actor.query('XA ROLLBACK ?',[xid]);xaEnded=false;
  assert.equal(Number((await observer.query('SELECT COUNT(*) AS n FROM '+q(xa)))[0][0].n),0);assert.equal(Number((await observer.execute('SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND COLUMN_NAME=?',[part.config.database,xa,'blocked']))[0][0].n),0);
  for(const name of [left,right,collision]){await actor.query('CREATE TABLE '+q(name)+' (id INT PRIMARY KEY) ENGINE=InnoDB');await actor.query('INSERT INTO '+q(name)+' VALUES(1)');}
  const renameError=await rejected(()=>actor.query('RENAME TABLE '+q(left)+' TO '+q(renamed)+', '+q(right)+' TO '+q(collision)),error=>error.code==='ER_TABLE_EXISTS_ERROR');
  assert.equal(await exists(left),true);assert.equal(await exists(right),true);assert.equal(await exists(renamed),false);assert.equal(await exists(collision),true);for(const name of [left,right,collision])assert.deepEqual((await observer.query('SELECT id FROM '+q(name)))[0],[{id:1}]);
  return{kind:'server-semantics',engine:part.engine,version,ordinaryDmlCommittedBeforeDDL:true,createdTableSurvivesRollback:true,activeXaDdlRejected:true,xaError,xaDmlRolledBack:true,xaDDLAbsent:true,failedMultiRenameLeavesAllNames:true,failedMultiRenameLeavesRows:true,renameError,crashAtomicityTested:false,storageEngine:'InnoDB'};
 }finally{
  if(xaActive)try{await actor.query('XA END ?',[xid]);xaEnded=true;}catch{}
  if(xaEnded)try{await actor.query('XA ROLLBACK ?',[xid]);}catch{}
  try{await actor.rollback();for(const name of names)await actor.query('DROP TABLE IF EXISTS '+q(name));}finally{await actor.end();await observer.end();}
 }
}
async function mixedProbe(parts){
 assert.equal(parts.length,2);const name='rb_atomic_pair_'+crypto.randomBytes(6).toString('hex'),actors=[];
 try{
  for(const part of parts){const actor=await mysql.createConnection(part.config);actors.push(actor);await actor.query('SET SESSION autocommit=1');await actor.query('CREATE TABLE '+q(name)+' (id INT PRIMARY KEY,note VARCHAR(20) NOT NULL) ENGINE=InnoDB');await actor.query("INSERT INTO "+q(name)+" VALUES(1,'original')");}
  await actors[0].beginTransaction();await actors[1].beginTransaction();await actors[0].query('ALTER TABLE '+q(name)+' ADD published INT NULL');
  const failure=await rejected(()=>actors[1].query('ALTER TABLE '+q(name)+' ADD note INT NULL'),error=>error.code==='ER_DUP_FIELDNAME');for(const actor of actors)await actor.rollback();
  for(let i=0;i<actors.length;i++){const columns=(await actors[i].execute('SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=?',[parts[i].config.database,name]))[0].map(r=>r.COLUMN_NAME);assert.equal(columns.includes('published'),i===0);assert.deepEqual((await actors[i].query('SELECT id,note FROM '+q(name)))[0],[{id:1,note:'original'}]);}
  return{kind:'cross-server-rollback',engines:parts.map(p=>p.engine),firstServerDDLPublished:true,secondServerDDLRejected:true,secondError:failure,rollbackDidNotUndoFirstServer:true,secondServerUnchanged:true,originalRowsPreserved:true,atomicDistributedDDL:false,automaticCompensation:false};
 }finally{for(const actor of actors)try{await actor.rollback();await actor.query('DROP TABLE IF EXISTS '+q(name));}finally{await actor.end();}}
}
async function isolation(parts){const result=[];for(const part of parts)if(part.baseUrl){const state=await(await fetch(part.baseUrl+'/probe/testing-state')).json();assert.deepEqual(state,{people:2,departments:1,rolledBackNames:0});result.push({engine:part.engine,isolation:state});}return result;}
module.exports={engineProbe,mixedProbe,isolation,paired,q};
