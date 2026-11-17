'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {SchemaRenamer,normalizeRequest,ddlFor,stableCreate}=require('../src/db/schema-rename');
const clone=value=>structuredClone(value);
function fixture(){
  const user={id:'console',active:null,inTransaction:false,outcomeUnknown:false,needsReconnect:false,autocommit:true,transactionState:'idle'},calls=[],closed=[],identity={dialect:'mysql',version:'8.4.13',database:'app',tableNameCaseSensitive:true};
  let counter=0,state={identity,allTables:[['old','BASE TABLE']],table:['old','BASE TABLE','InnoDB','utf8mb4_bin','comment','Dynamic',''],columns:[['id','int','NO',null,'PRI','',1,'','',null,''],['label','varchar(80)','YES','default','','',2,'comment','utf8mb4','utf8mb4_bin','']],createSql:'CREATE TABLE `old` (`id` int,`label` varchar(80))',indexes:[['PRIMARY',0,1,'id',null,'BTREE','A','','']],foreignKeys:[],checks:[],partitions:[],tableGrants:[],columnGrants:[],views:[],routines:[],triggers:[],events:[]},ddlError;
  const db={_options:{host:'localhost',port:3306,database:'app',password:'must-not-leak'},_sessions:new Map([['console',user]]),_revision:0,_editor:{models:new Map([['snapshot',{}]]),reviews:new Map([['draft',{}]])},_assertOpen(){},async _ensureConnection(session){session.connectionId=++counter;session.connected=true;},async _control(session,sql){calls.push({sql,connectionId:session.connectionId});},async _stream(session,sql){calls.push({sql,connectionId:session.connectionId});if(ddlError)throw ddlError;if(sql.startsWith('RENAME TABLE')){state.table[0]='new';state.allTables=[['new','BASE TABLE']];}else if(sql.includes('RENAME COLUMN'))state.columns[1][0]='renamed';return {rows:[],truncated:false};},_lose(session){closed.push(session.connectionId);session.connected=false;},async _refreshState(){}};
  const renamer=new SchemaRenamer(db,{createSession:id=>({id})});renamer._identity=async()=>clone(identity);renamer._snapshot=async()=>clone(state);
  return {db,user,calls,closed,renamer,setState:fn=>fn(state),setError:error=>{ddlError=error;}};
}
test('schema targets are bounded identifiers and quoted DDL preserves exact names without type reconstruction',()=>{
  for(const value of ['', 'bad\0name','a'.repeat(65),'😀','bad '])assert.throws(()=>normalizeRequest({kind:'column',table:'t',column:'a',newName:value}));
  assert.throws(()=>normalizeRequest({kind:'table',table:'t',newName:'other.table'}));
  assert.throws(()=>normalizeRequest({kind:'column',table:'t',column:'A',newName:'a'}));
  const sql=ddlFor('app\'s db',{kind:'column',table:'t`x',column:'old',newName:'새`이름'}).sql;
  assert.equal(sql,"ALTER TABLE `app's db`.`t``x` RENAME COLUMN `old` TO `새``이름`");assert.doesNotMatch(sql,/CHANGE|VARCHAR|DEFAULT/);
  assert.equal(stableCreate("CREATE TABLE t (`AUTO_INCREMENT` text DEFAULT 'AUTO_INCREMENT=7') AUTO_INCREMENT=9"),"CREATE TABLE t (`AUTO_INCREMENT` text DEFAULT 'AUTO_INCREMENT=7') AUTO_INCREMENT=<counter>");
});
test('review tokens own exact private DDL, use distinct short-lived connections and can be applied once',async()=>{
  const h=fixture(),plan=await h.renamer.preview({kind:'table',table:'old',newName:'new'});assert.equal(plan.transactionalRollback,false);assert.equal(plan.implicitCommit,true);assert.equal(plan.sourceFilesChanged,false);assert.equal(JSON.stringify(plan).includes(h.db._options.password),false);
  plan.sql='DROP DATABASE app';plan.newName='forged';const result=await h.renamer.apply({reviewId:plan.reviewId,sql:plan.sql});assert.equal(result.state,'applied');assert.equal(result.newName,'new');assert.equal(result.verified,true);
  assert.deepEqual(h.closed,[1,2]);assert.equal(h.calls.filter(c=>c.sql.startsWith('RENAME TABLE')).length,1);assert.equal(h.calls.some(c=>c.sql.startsWith('DROP')),false);assert.equal(h.calls.find(c=>c.sql.startsWith('RENAME')).connectionId,2);assert.equal(h.db._editor.models.size,0);
  await assert.rejects(h.renamer.apply({reviewId:plan.reviewId}),{code:'ROCKETBRAIN_SCHEMA_STALE'});
});
test('fresh metadata mismatch rejects before DDL and consumes the stale review',async()=>{
  const h=fixture(),plan=await h.renamer.preview({kind:'table',table:'old',newName:'new'});h.setState(state=>state.columns[1][7]='changed definition');
  await assert.rejects(h.renamer.apply(plan),e=>e.code==='ROCKETBRAIN_SCHEMA_STALE'&&e.ddlAttempted===false&&e.state==='rejected');assert.equal(h.calls.some(c=>c.sql.startsWith('RENAME')),false);assert.deepEqual(h.closed,[1,2]);
});
test('active or unknown console transactions block schema apply without committing or losing the review',async()=>{
  const h=fixture(),plan=await h.renamer.preview({kind:'table',table:'old',newName:'new'});h.user.inTransaction=true;
  await assert.rejects(h.renamer.apply(plan),{code:'ROCKETBRAIN_SCHEMA_BUSY'});assert.equal(h.user.inTransaction,true);assert.equal(h.calls.some(c=>/^(?:COMMIT|ROLLBACK|RENAME)/.test(c.sql)),false);assert.equal(h.closed.length,1);
  h.user.inTransaction=false;h.user.outcomeUnknown=true;await assert.rejects(h.renamer.apply(plan),{code:'ROCKETBRAIN_SCHEMA_BUSY'});h.user.outcomeUnknown=false;assert.equal((await h.renamer.apply(plan)).state,'applied');
});
test('lost DDL response is an explicit unknown outcome, invalidates snapshots and never retries',async()=>{
  const h=fixture(),plan=await h.renamer.preview({kind:'table',table:'old',newName:'new'});h.setError(Object.assign(new Error('lost'),{code:'PROTOCOL_CONNECTION_LOST',fatal:true}));
  await assert.rejects(h.renamer.apply(plan),e=>e.code==='ROCKETBRAIN_SCHEMA_OUTCOME_UNKNOWN'&&e.outcomeUnknown&&e.applied===null&&e.ddlAttempted&&e.sourceFilesChanged===false);
  assert.equal(h.calls.filter(c=>c.sql.startsWith('RENAME')).length,1);assert.equal(h.db._editor.models.size,0);await assert.rejects(h.renamer.apply(plan),{code:'ROCKETBRAIN_SCHEMA_STALE'});
});
test('hidden stored definitions require separate explicit approval after a concrete preview',async()=>{
  const h=fixture();h.setState(state=>state.routines.push(['hidden_routine','PROCEDURE',null]));
  const plan=await h.renamer.preview({kind:'table',table:'old',newName:'new'});assert.equal(plan.requiresUnverifiedDependencyApproval,true);assert.deepEqual(plan.dependencySummary.hiddenDefinitions,[{kind:'routine',name:'hidden_routine'}]);
  await assert.rejects(h.renamer.apply({reviewId:plan.reviewId}),e=>e.code==='ROCKETBRAIN_SCHEMA_UNVERIFIED'&&!e.ddlAttempted);assert.equal(h.calls.some(c=>c.sql.startsWith('RENAME')),false);assert.equal(h.closed.length,1);
  const result=await h.renamer.apply({reviewId:plan.reviewId,allowUnverifiedDependencies:true});assert.equal(result.state,'applied');assert.equal(result.unverifiedDependenciesAccepted,true);
});
test('stored or expression dependencies, grants and destination collisions need a separate migration',async()=>{
  for(const mutate of [state=>state.views.push(['dependent','select id from `old`']),state=>state.routines.push(['dynamic','PROCEDURE','PREPARE s FROM @sql']),state=>state.tableGrants.push(['reader','SELECT']),state=>state.allTables.push(['new','VIEW'])]){const h=fixture();h.setState(mutate);await assert.rejects(h.renamer.preview({kind:'table',table:'old',newName:'new'}));assert.equal(h.calls.some(c=>c.sql.startsWith('RENAME')),false);assert.equal(h.closed.length,1);}
  const h=fixture();h.setState(state=>state.columns[1][10]='id + 1');await assert.rejects(h.renamer.preview({kind:'column',table:'old',column:'label',newName:'renamed'}),{code:'ROCKETBRAIN_SCHEMA_DEPENDENCY'});
});
