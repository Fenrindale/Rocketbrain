'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto'),mysql=require('mysql2/promise');
async function run(t,{config,q,MysqlService,captureSchema,JOURNAL,reports}){
 await t.test('a valid v13-format durable journal restores original columns and data after the v14 upgrade',async()=>{
  const actor=await mysql.createConnection(config),db=new MysqlService(config),name='rb_legacy_'+crypto.randomBytes(5).toString('hex'),scope={tables:[name]};let plan,fresh;
  try{
   await actor.query('CREATE TABLE '+q(name)+' (id INT PRIMARY KEY,note VARCHAR(20),amount DECIMAL(12,3),secret VARCHAR(20)) ENGINE=InnoDB');await actor.query('INSERT INTO '+q(name)+" VALUES(1,'Original',1.250,'retained')");const current=await captureSchema(db,scope);
   await actor.query('ALTER TABLE '+q(name)+' MODIFY note VARCHAR(60),DROP COLUMN secret');const desired=await captureSchema(db,scope);await actor.query('ALTER TABLE '+q(name)+' MODIFY note VARCHAR(20),ADD COLUMN secret VARCHAR(20)');await actor.query('UPDATE '+q(name)+" SET secret='retained'");
   const review=await db.previewSchemaRebuild({current,desired,tables:[name]});plan=review.plan;const result=await db.applySchemaRebuild({reviewId:review.reviewId,allowDestructive:true,allowImplicitCommit:true,allowUnverifiedDependencies:true});assert.equal(result.state,'applied',JSON.stringify(result));
   const [[row]]=await actor.execute('SELECT payload FROM '+q(JOURNAL)+' WHERE operation_id=?',[plan.id]),record=JSON.parse(row.payload);record.plan.formatVersion=1;for(const key of ['conversionRules','requiresLossyConversionApproval','dependencies','requiresDependencyChanges','requiresDependencyChangeApproval','dependencyEnvironment','unverifiedDependencies','requiresUnverifiedDependencyApproval'])delete record.plan[key];for(const step of record.plan.steps)delete step.conversions;
   // This reproduces the typed v13 payload structure in an owned disposable
   // journal. No old evidence or arbitrary existing recovery record is changed.
   await actor.execute('UPDATE '+q(JOURNAL)+' SET payload=? WHERE operation_id=?',[JSON.stringify(record),plan.id]);await db.dispose();fresh=new MysqlService(config);assert.ok((await fresh.listSchemaRecoveries()).some(r=>r.operationId===plan.id));
   const restored=await fresh.recoverSchemaRebuild({operationId:plan.id,allowDestructive:true,allowImplicitCommit:true,allowUnverifiedDependencies:true});assert.equal(restored.state,'recovered',JSON.stringify(restored));assert.deepEqual((await actor.query('SELECT id,note,amount,secret FROM '+q(name)))[0],[{id:1,note:'Original',amount:'1.250',secret:'retained'}]);
   reports.push({kind:'v13-journal-compatibility',actualLegacyFormat1:true,originalSecretRestored:true,freshClientRecovery:true,noRawSQLReplay:true});
  }finally{await fresh?.dispose();await db.dispose();for(const table of [name,...(plan?plan.steps.flatMap(s=>[s.backup,s.shadow,s.quarantine]).filter(Boolean):[])])await actor.query('DROP TABLE IF EXISTS '+q(table));if(plan)await actor.execute('DELETE FROM '+q(JOURNAL)+' WHERE operation_id=?',[plan.id]);await actor.end();}
 });
}
module.exports={run};
