'use strict';
const assert=require('node:assert/strict');
async function run(t,{fixture,q,reports}){
 await t.test('lost validation-view creation acknowledgment cleans only journaled typed temporary objects before restoring the intact graph',async()=>{
  const s=await fixture();try{const review=await s.review(),original=s.db._stream.bind(s.db);let losses=0;s.db._stream=async(session,sql,values,options,write)=>{const value=await original(session,sql,values,options,write);if(!losses&&write&&sql.startsWith('CREATE ALGORITHM=')&&sql.includes('__rb_v_')){losses++;const error=Object.assign(new Error('Controlled lost validation creation acknowledgment'),{code:'PROTOCOL_CONNECTION_LOST',fatal:true});s.db._lose(session,error,true);throw error;}return value;};const result=await s.db.applySchemaRebuild({reviewId:review.reviewId,allowDestructive:true,allowImplicitCommit:true,allowUnverifiedDependencies:true,allowDependencyChanges:true});assert.equal(result.state,'recovered',JSON.stringify(result));assert.equal(losses,1);const [remaining]=await s.actor.execute('SELECT TABLE_NAME FROM information_schema.VIEWS WHERE TABLE_SCHEMA=? AND TABLE_NAME LIKE ?',[review.plan.database,'__rb_v_'+review.plan.id.slice(0,20)+'_%']);assert.equal(remaining.length,0);assert.equal((await s.actor.query('SELECT * FROM '+q(s.names.nested)))[0].length,2);reports.push({kind:'validation-lost-ack',intentJournaledBeforeDDL:true,actualCreateBeforeLoss:true,ownedTemporaryViewCleaned:true,originalGraphRestored:true});}finally{await s.close();}
 });
 await t.test('lost publication acknowledgment keeps renamed physical objects fenced and safely restores their original dependencies',async()=>{
  const s=await fixture();try{
   const review=await s.review(),original=s.db._stream.bind(s.db);let losses=0;
   s.db._stream=async(session,sql,values,options,write)=>{const value=await original(session,sql,values,options,write);if(!losses&&write&&(sql.startsWith('RENAME TABLE ')||sql.startsWith('ALTER TABLE ')&&sql.includes(review.plan.steps[0].shadow)&&sql.includes('RENAME TO'))){losses++;const error=Object.assign(new Error('Controlled lost dependency publish acknowledgment'),{code:'PROTOCOL_CONNECTION_LOST',fatal:true});s.db._lose(session,error,true);throw error;}return value;};
   const result=await s.db.applySchemaRebuild({reviewId:review.reviewId,allowDestructive:true,allowImplicitCommit:true,allowUnverifiedDependencies:true,allowDependencyChanges:true});assert.equal(result.state,'recovered',JSON.stringify(result));assert.equal(losses,1);assert.equal(result.automaticRecovery.dependenciesRestored,true);assert.equal(result.automaticRecovery.normalClientFencesReleased,true);
   assert.equal((await s.actor.query('SHOW COLUMNS FROM '+q(s.base)+" LIKE 'note'"))[0][0].Type,'varchar(30)');assert.equal((await s.actor.query('SELECT * FROM '+q(s.names.nested)))[0].length,2);await s.actor.query('INSERT INTO '+q(s.base)+" VALUES(3,1,'Recovered')");assert.equal(Number((await s.actor.query('SELECT COUNT(*) AS n FROM '+q(s.names.audit)))[0][0].n),1);
   reports.push({kind:'dependency-publish-lost-ack',actualPublishBeforeLoss:true,renamedFencesIdentified:true,originalGraphRestored:true,triggerFiresOnce:true,publishNotReplayed:true});
  }finally{await s.close();}
 });
}
module.exports={run};
