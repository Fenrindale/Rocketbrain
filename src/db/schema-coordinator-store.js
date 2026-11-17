'use strict';
const {identifier}=require('./schema-rename');
const M=require('./schema-coordinator-model');
const JOURNAL='__rb_schema_coordinator_v16',MARKER='Rocketbrain schema coordinator journal v16',LOCK='rocketbrain.distributed.rebuild.v16';
const q=name=>'`'+identifier(name).replaceAll('`','``')+'`';
class CoordinatorStore{
 constructor(adapter,session){this.adapter=adapter;this.session=session;this.table=q(adapter.identity.database)+'.'+q(JOURNAL);}
 read(sql,values=[]){return this.adapter.transport._read(this.session,sql,values);}
 write(sql,values=[]){return this.adapter.service._stream(this.session,sql,values,{maxRows:1,timeoutMs:10000},true);}
 async ensure(create=false){
  const schema=this.adapter.identity.database,rows=await this.read('SELECT TABLE_TYPE,ENGINE,TABLE_COMMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=?',[schema,JOURNAL]);
  if(!rows.length){if(!create)return false;await this.write('CREATE TABLE '+this.table+" (operation_id CHAR(32) NOT NULL,record_role VARCHAR(11) NOT NULL,payload LONGTEXT NOT NULL,PRIMARY KEY(operation_id,record_role)) ENGINE=InnoDB COMMENT='"+MARKER+"'");return this.ensure(false);}
  if(rows.length!==1||rows[0][0]!=='BASE TABLE'||String(rows[0][1]).toUpperCase()!=='INNODB'||rows[0][2]!==MARKER)throw M.fail('OWNERSHIP','The coordinator journal name belongs to an unverified object.');
  const columns=await this.read('SELECT COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION',[schema,JOURNAL]);
  if(JSON.stringify(columns)!==JSON.stringify([['operation_id','char(32)','NO',''],['record_role','varchar(11)','NO',''],['payload','longtext','NO','']]))throw M.fail('OWNERSHIP','The coordinator journal columns changed.');
  const indexes=await this.read('SELECT INDEX_NAME,NON_UNIQUE,SEQ_IN_INDEX,COLUMN_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY INDEX_NAME,SEQ_IN_INDEX',[schema,JOURNAL]);
  if(indexes.length!==2||indexes.some((r,i)=>r[0]!=='PRIMARY'||Number(r[1])!==0||Number(r[2])!==i+1||r[3]!==['operation_id','record_role'][i]))throw M.fail('OWNERSHIP','The coordinator journal key changed.');
  const constraints=await this.read('SELECT CONSTRAINT_TYPE FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA=? AND TABLE_NAME=?',[schema,JOURNAL]);if(constraints.length!==1||constraints[0][0]!=='PRIMARY KEY')throw M.fail('OWNERSHIP','Unreviewed coordinator journal constraints are unsupported.');
  if((await this.read('SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=? AND EVENT_OBJECT_TABLE=?',[schema,JOURNAL])).length)throw M.fail('OWNERSHIP','Coordinator journal triggers are unsupported.');return true;
 }
 async get(id,role='coordinator'){
  if(!/^[a-f0-9]{32}$/.test(id)||!['coordinator','participant'].includes(role))throw M.fail('INPUT','Invalid coordinator operation identity.');if(!await this.ensure())return null;
  const rows=await this.read('SELECT payload FROM '+this.table+' WHERE operation_id=? AND record_role=?',[id,role]);if(!rows.length)return null;if(rows.length!==1||Buffer.byteLength(String(rows[0][0]))>M.LIMITS.payloadBytes)throw M.fail('JOURNAL','Invalid coordinator journal payload.');return M.validateRecord(JSON.parse(rows[0][0]),{id,role});
 }
 async put(record){
  M.validateRecord(record);await this.ensure(true);const old=await this.get(record.id,record.role);if(old&&(M.immutable(old)!==M.immutable(record)||old.decision&&old.decision!==record.decision))throw M.fail('JOURNAL','The immutable coordinator membership or durable decision changed.');
  if(!old&&Number((await this.read('SELECT COUNT(*) FROM '+this.table))[0]?.[0])>=M.LIMITS.operations*2)throw M.fail('LIMIT','Archive retained coordinator journal operations explicitly before creating more.');
  const payload=JSON.stringify(record);await this.write('INSERT INTO '+this.table+' (operation_id,record_role,payload) VALUES(?,?,?) ON DUPLICATE KEY UPDATE payload=?',[record.id,record.role,payload,payload]);
 }
 async list(){if(!await this.ensure())return[];const rows=await this.read('SELECT operation_id,payload FROM '+this.table+" WHERE record_role='coordinator' ORDER BY operation_id LIMIT 101");if(rows.length>M.LIMITS.operations)throw M.fail('LIMIT','Too many retained coordinator operations.');return rows.map(([id,payload])=>M.validateRecord(JSON.parse(payload),{id,role:'coordinator'}));}
}
module.exports={CoordinatorStore,JOURNAL,MARKER,LOCK,q};
