'use strict';
const {createHash}=require('node:crypto');
const engine=require('./schema-diff');
const {SchemaRenamer,stableCreate}=require('./schema-rename');
const copy=value=>structuredClone(value),equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const fail=(code,message)=>Object.assign(new Error(message),{code});
const quote=value=>'`'+value.replaceAll('`','``')+'`';
const LIMITS={reviews:10,reviewLifetimeMs:120000,statementTimeoutMs:10000};
const cancelled=token=>token?.isCancellationRequested===true||token?.aborted===true;
const scope=snapshot=>snapshot.scope.kind==='selected-tables'?{tables:snapshot.scope.tables}:{};
/** Owns immutable selected additive plans and short-lived DDL connections.
 * No client SQL or mutated public plan is accepted by Apply. */
class SchemaApplier{
 constructor(db,{createSession,clock=Date.now}={}){this.db=db;this.clock=clock;this.transport=new SchemaRenamer(db,{createSession,clock});this.reviews=new Map();this.operations=new Set();this.applying=false;this.disposed=false;}
 _open(){this.db._assertOpen();if(this.disposed)throw fail('ROCKETBRAIN_MIGRATION_CLOSED','Schema application is closed.');}
 _idle(){this._open();if(this.applying||this.db._schemaRecovery?.applying||this.db._streamImportState?.running||this.db._streamImportState?.pending||this.db._schemaRenamer?.applying||this.transport.sessions.size||this.db._metadataSession?.pendingOperations)throw fail('ROCKETBRAIN_MIGRATION_BUSY','Wait for the current schema operation or metadata read.');for(const s of this.db._sessions.values())if(s.pendingOperations||s.active||s.scriptRunning||s.inTransaction||s.outcomeUnknown||s.needsReconnect||s.transactionState==='unknown'||s.autocommit===false)throw fail('ROCKETBRAIN_MIGRATION_BUSY','Finish queued console work and explicitly commit, roll back or reconnect every unresolved console before applying schema changes. No console transaction was committed.');}
 _prune(){for(const [id,item]of this.reviews)if(item.expiresAt<=this.clock())this.reviews.delete(id);while(this.reviews.size>=LIMITS.reviews)this.reviews.delete(this.reviews.keys().next().value);}
 _capture(session,options){return engine.captureSchema({_metadataQuery:async(sql,values)=>({rows:await this.transport._read(session,sql,values),truncated:false})},options);}
 _track(fn){const work=fn();this.operations.add(work);void work.finally(()=>this.operations.delete(work)).catch(()=>{});return work;}
 preview(input){return this._track(async()=>{this._idle();const current=engine.normalizeSnapshot(input?.current),desired=engine.normalizeSnapshot(input?.desired),plan=engine.planMigration(current,desired,{changeIds:input?.changeIds});await this.transport._withSession(async session=>engine.validateMigrationPlan(plan,await this._capture(session,scope(current))));this._open();this._prune();const expiresAt=this.clock()+LIMITS.reviewLifetimeMs;this.reviews.set(plan.id,{plan:copy(plan),current,desired,expiresAt});return{plan:copy(plan),reviewId:plan.id,expiresAt,implicitCommit:true,atomicAcrossSteps:false,automaticApplyImplemented:true};});}
 _invalidate(){this.db._revision++;this.db._editor.models.clear();this.db._editor.reviews.clear();this.db._schemaRenamer.reviews.clear();}
 apply(input){return this._track(async()=>{
  this._idle();if(input?.allowImplicitCommit!==true)throw fail('ROCKETBRAIN_MIGRATION_APPROVAL','Review the selected SQL and explicitly acknowledge DDL implicit commits before applying.');
  const saved=this.reviews.get(input.reviewId);if(!saved||saved.expiresAt<=this.clock()){this.reviews.delete(input?.reviewId);throw fail('ROCKETBRAIN_MIGRATION_STALE','This schema review expired or was already consumed. Compare again.');}
  const check=()=>{this._open();if(cancelled(input.cancellation))throw fail('ROCKETBRAIN_CANCELLED','Schema application was cancelled; later statements were not submitted.');if(input.guard&&input.guard()!==true)throw fail('ROCKETBRAIN_MIGRATION_CONTEXT','The workspace or database context changed. Later schema statements were not submitted.');if(cancelled(input.cancellation))throw fail('ROCKETBRAIN_CANCELLED','Schema application was cancelled; later statements were not submitted.');};check();
  this.reviews.delete(input.reviewId);this.applying=true;const report={format:'RocketbrainSchemaApplication',formatVersion:1,reviewId:input.reviewId,database:saved.plan.database,state:'rejected',steps:saved.plan.steps.map((step,index)=>({...copy(step),index,status:'not-run',attempted:false,acknowledged:false,verified:false})),completed:0,failed:0,notRun:saved.plan.steps.length,outcomeUnknown:false,ddlAttempted:false,atomicAcrossSteps:false,implicitCommit:true,transactionalRollback:false,autoRetried:false,catalogInvalidated:false,allReferencesVerified:false,concurrencyScope:'Per-step target WRITE lock and cooperating Rocketbrain advisory lock; no atomic cross-step or whole-catalog guarantee.'};
  let sessionForCancel,subscription;
  try{return await this.transport._withSession(async session=>{
   sessionForCancel=session;report.connectionId=session.connectionId;
   const stop=()=>{if(sessionForCancel?.active)this.db._lose(sessionForCancel,fail('ROCKETBRAIN_CANCELLED','The owned schema connection was closed for cancellation.'),Boolean(report.steps.some(s=>s.status==='running')));};
   if(input.cancellation?.onCancellationRequested)subscription=input.cancellation.onCancellationRequested(stop);else if(input.cancellation?.addEventListener){input.cancellation.addEventListener('abort',stop,{once:true});subscription={dispose:()=>input.cancellation.removeEventListener('abort',stop)};}
   const lock='rocketbrain.migration.'+createHash('sha256').update(saved.plan.database).digest('hex').slice(0,40);const acquired=await this.transport._read(session,'SELECT GET_LOCK(?,0)',[lock]);if(Number(acquired[0]?.[0])!==1)throw fail('ROCKETBRAIN_MIGRATION_BUSY','Another cooperating schema application owns this database.');
   if(saved.current.server.dialect==='mariadb'){const wsrep=await this.transport._read(session,"SHOW VARIABLES LIKE 'wsrep_on'");if(wsrep.length&&![0,'0','OFF'].includes(wsrep[0]?.[1]))throw fail('ROCKETBRAIN_MIGRATION_UNSUPPORTED','Galera/wsrep schema application is outside this locked workflow.');report.wsrepObservation=wsrep.length?'off':'variable-not-exposed';}
   let expected=saved.current;
   for(const step of report.steps){
    check();const before=await this._capture(session,scope(saved.current));if(before.fingerprint!==expected.fingerprint)throw fail('ROCKETBRAIN_MIGRATION_STALE','The schema changed between reviewed steps. Compare the remaining changes again.');if(!equal(before.server,saved.plan.currentServer))throw fail('ROCKETBRAIN_MIGRATION_STALE','The database server, account or SQL mode changed.');
    const target=before.tables.find(t=>t.name===step.table);let locked=false,manualAutocommit=false;
    try{
     if(step.kind!=='create-table'){
      if(!target)throw fail('ROCKETBRAIN_MIGRATION_STALE','The selected target no longer exists.');
      const locks=await this.transport._read(session,'SELECT @@innodb_table_locks');if(Number(locks[0]?.[0])!==1)throw fail('ROCKETBRAIN_MIGRATION_UNSUPPORTED','Enable InnoDB table locks on the server before using this reviewed schema workflow.');
      await this.db._control(session,'SET autocommit=0',5000);manualAutocommit=true;
      await this.db._control(session,'LOCK TABLES '+quote(saved.plan.database)+'.'+quote(step.table)+' WRITE',5000);locked=true;
      const mode=await this.transport._read(session,'SELECT @@autocommit');if(Number(mode[0]?.[0])!==0)throw fail('ROCKETBRAIN_MIGRATION_LOCK','The dedicated connection did not retain the required manual autocommit lock mode.');step.lockObservation={innodbTableLocks:true,autocommit:false,writeLockAcquired:true};
      const latest=await this.transport._read(session,'SHOW CREATE TABLE '+quote(saved.plan.database)+'.'+quote(step.table));if(stableCreate(String(latest[0]?.[1]))!==stableCreate(target.createSql))throw fail('ROCKETBRAIN_MIGRATION_STALE','The selected table changed before its write lock.');
     }
     check();step.status='running';step.attempted=true;report.ddlAttempted=true;
     await this.db._stream(session,step.sql,[],{maxRows:1,timeoutMs:LIMITS.statementTimeoutMs},true);step.acknowledged=true;this._invalidate();report.catalogInvalidated=true;
     if(locked){await this.db._control(session,'UNLOCK TABLES',5000);locked=false;}
     if(manualAutocommit){await this.db._control(session,'SET autocommit=1',5000);manualAutocommit=false;}
     const after=await this._capture(session,scope(saved.current)),observed=engine.compareSnapshots(before,after);
     if(!equal(after.server,saved.plan.currentServer)||observed.changes.length!==1||observed.changes[0].kind!==step.kind||observed.changes[0].table!==step.table||observed.changes[0].object!==step.object||observed.changes[0].sql!==step.sql)throw fail('ROCKETBRAIN_MIGRATION_VERIFY','DDL was acknowledged but the observed structural change differs from the selected step. Inspect the database before continuing.');
     step.status='applied';step.verified=true;step.afterFingerprint=after.fingerprint;expected=after;report.completed++;
    }catch(error){step.status=!step.attempted?'not-run':step.acknowledged||!/^ER_/.test(error.code||'')||error.fatal?'uncertain':'failed';step.error={code:error.code||'ROCKETBRAIN_MIGRATION_FAILED',message:step.status==='uncertain'?'The DDL outcome or postcondition is unconfirmed. Inspect the actual database; no statement was retried.':error.message};if(step.attempted)report.failed++;report.outcomeUnknown=step.status==='uncertain';throw error;}
    finally{if(locked&&session.connected)try{await this.db._control(session,'UNLOCK TABLES',5000);}catch{}if(manualAutocommit&&session.connected)try{await this.db._control(session,'SET autocommit=1',5000);}catch{}}
   }
   report.state='applied';report.afterFingerprint=expected.fingerprint;return report;
  });}
  catch(error){if(!report.error)report.error={code:error.code||'ROCKETBRAIN_MIGRATION_FAILED',message:error.message};report.state=report.outcomeUnknown?'uncertain':cancelled(input.cancellation)?'cancelled':report.completed?'partial':report.ddlAttempted?'failed':'rejected';return report;}
  finally{subscription?.dispose();sessionForCancel=null;report.notRun=report.steps.filter(s=>s.status==='not-run').length;this.applying=false;if(report.ddlAttempted){this._invalidate();report.catalogInvalidated=true;this.reviews.clear();}}
 });}
 discard(id){return this.reviews.delete(id);}
 async dispose(){if(this.disposed)return;this.disposed=true;this.reviews.clear();this.transport.dispose();await Promise.allSettled([...this.operations]);}
}
module.exports={SchemaApplier,LIMITS};
