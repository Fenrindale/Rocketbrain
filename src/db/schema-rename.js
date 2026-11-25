'use strict';
const {randomUUID,createHash}=require('node:crypto');
const quote=value=>'`'+value.replaceAll('`','``')+'`';
const fail=(code,message,extra={})=>Object.assign(new Error(message),{code,...extra});
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const copy=value=>structuredClone(value);
const folded=value=>value.toLowerCase();
const sorted=rows=>[...rows].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
const LIMITS={reviews:16,concurrentConnections:4,reviewLifetimeMs:120000,metadataRows:5000,metadataBytes:8*1024*1024,queryTimeoutMs:10000};
function identifier(value,{table=false}={}){
  if(typeof value!=='string'||!value||value.length>64||/[\u0000-\u001f\u007f\ud800-\udfff]/.test(value)||value.endsWith(' ')||(table&&/[.\\/]/.test(value)))throw fail('ROCKETBRAIN_SCHEMA_NAME','Use a non-empty local MySQL identifier of at most 64 BMP characters, without control characters or trailing spaces.');
  return value;
}
function normalizeRequest(input){
  if(!input||!['table','column'].includes(input.kind))throw fail('ROCKETBRAIN_SCHEMA_TARGET','Select a physical table or column in the current database.');
  const result={kind:input.kind,table:identifier(input.table,{table:true}),newName:identifier(input.newName,{table:input.kind==='table'})};
  if(input.kind==='column')result.column=identifier(input.column);
  if(folded(input.kind==='table'?result.table:result.column)===folded(result.newName))throw fail('ROCKETBRAIN_SCHEMA_NAME','Choose a different name. Case-only renames are outside the verified workflow.');
  return result;
}
function ddlFor(schema,target,{dialect}={}){
  const table=quote(schema)+'.'+quote(target.table);
  if(target.kind==='table'&&dialect==='mariadb')return {sql:'ALTER TABLE '+table+' RENAME TO '+quote(schema)+'.'+quote(target.newName),reverseSql:'ALTER TABLE '+quote(schema)+'.'+quote(target.newName)+' RENAME TO '+table};
  return target.kind==='table'?{sql:'RENAME TABLE '+table+' TO '+quote(schema)+'.'+quote(target.newName),reverseSql:'RENAME TABLE '+quote(schema)+'.'+quote(target.newName)+' TO '+table}:{sql:'ALTER TABLE '+table+' RENAME COLUMN '+quote(target.column)+' TO '+quote(target.newName),reverseSql:'ALTER TABLE '+table+' RENAME COLUMN '+quote(target.newName)+' TO '+quote(target.column)};
}
// Ignore the volatile AUTO_INCREMENT counter, never quoted column defaults or comments.
function stableCreate(sql, { omitCounter = false } = {}) {
  let out = '', quoted = '', depth = 0;
  for (let index = 0; index < sql.length;) {
    const char = sql[index];
    if (quoted) {
      out += char;
      index++;
      if (char === '\\' && index < sql.length) out += sql[index++];
      else if (char === quoted) {
        if (sql[index] === quoted) out += sql[index++];
        else quoted = '';
      }
      continue;
    }
    if (["'", '"', '`'].includes(char)) {
      quoted = char;
      out += char;
      index++;
      continue;
    }
    if (sql.startsWith('/*', index)) {
      const end = sql.indexOf('*/', index + 2);
      const next = end < 0 ? sql.length : end + 2;
      out += sql.slice(index, next);
      index = next;
      continue;
    }
    if (char === '(') depth++;
    if (char === ')') depth--;
    if (depth === 0 && /[aA]/.test(char) && !/[\w$]/.test(sql[index - 1] || '')) {
      const match = /^AUTO_INCREMENT\s*=\s*\d+/i.exec(sql.slice(index));
      if (match) {
        index += match[0].length;
        if (!omitCounter) out += 'AUTO_INCREMENT=<counter>';
        else if (sql[index] === ' ') index++;
        else if (out.endsWith(' ')) out = out.slice(0, -1);
        continue;
      }
    }
    out += char;
    index++;
  }
  return out;
}
function mentions(text,name){
  const lower=String(text).toLowerCase(),target=folded(name),escaped=target.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  return lower.includes('`'+target.replaceAll('`','``')+'`')||new RegExp('(^|[^\\p{L}\\p{N}_$])'+escaped+'(?=$|[^\\p{L}\\p{N}_$])','u').test(lower);
}
function structural(snapshot){
  return {table:snapshot.table.slice(1),columns:snapshot.columns,indexes:sorted(snapshot.indexes),checks:sorted(snapshot.checks.map(row=>[row[1]])),foreignKeys:sorted(snapshot.foreignKeys.map(row=>[row[0],row[1],...row.slice(3)])),partitions:sorted(snapshot.partitions)};
}
function expectedStructure(before,target,schema){
  const result=copy(structural(before));
  if(target.kind==='table')for(const row of result.foreignKeys){if(row[0]===schema&&row[1]===target.table)row[1]=target.newName;if(row[4]===schema&&row[5]===target.table)row[5]=target.newName;}
  else{
    for(const column of result.columns)if(column[0]===target.column)column[0]=target.newName;
    for(const index of result.indexes)if(index[3]===target.column)index[3]=target.newName;
    for(const row of result.foreignKeys){if(row[0]===schema&&row[1]===target.table&&row[2]===target.column)row[2]=target.newName;if(row[4]===schema&&row[5]===target.table&&row[6]===target.column)row[6]=target.newName;}
  }
  result.indexes=sorted(result.indexes);result.foreignKeys=sorted(result.foreignKeys);return result;
}

/** Owns review tokens and one short-lived, write-capable DDL connection per operation.
 * Public review objects cannot replace private SQL, metadata or endpoint identity. */
class SchemaRenamer{
  constructor(db,{createSession,clock=Date.now}={}){this.db=db;this.createSession=createSession;this.clock=clock;this.reviews=new Map();this.sessions=new Set();this.applying=false;this.disposed=false;}
  _open(){this.db._assertOpen();if(this.disposed)throw fail('ROCKETBRAIN_SCHEMA_CLOSED','Schema rename is closed.');}
  _idle(){
    this._open();
    for(const session of this.db._sessions.values())if(session.active||session.inTransaction||session.outcomeUnknown||session.needsReconnect||session.transactionState==='unknown'||session.autocommit===false)throw fail('ROCKETBRAIN_SCHEMA_BUSY','Finish or reconnect every database console and commit or roll back its transaction before applying schema DDL. No console transaction was committed.');
  }
  _prune(){for(const [id,plan]of this.reviews)if(plan.expiresAt<=this.clock())this.reviews.delete(id);while(this.reviews.size>=LIMITS.reviews)this.reviews.delete(this.reviews.keys().next().value);}
  async _withSession(action){
    this._open();if(this.sessions.size>=LIMITS.concurrentConnections)throw fail('ROCKETBRAIN_SCHEMA_BUSY','Wait for a schema inspection connection before starting another review.');const session=this.createSession('__rocketbrain_schema_'+randomUUID(),false,this.db._options.database);this.sessions.add(session);
    try{await this.db._ensureConnection(session);await this.db._control(session,'SET SESSION lock_wait_timeout=3');return await action(session);}
    finally{session.closed=true;this.db._lose(session,fail('ROCKETBRAIN_SCHEMA_SESSION_CLOSED','The owned schema inspection connection was closed.'));this.sessions.delete(session);}
  }
  async _read(session,sql,values=[],{includeColumns=false}={}){
    this._open();const result=await this.db._stream(session,sql,values,{maxRows:LIMITS.metadataRows,timeoutMs:LIMITS.queryTimeoutMs},false);
    if(result.truncated)throw fail('ROCKETBRAIN_SCHEMA_LIMIT','Schema metadata exceeds the supported inspection limit.');
    if(session.connected)await this.db._refreshState(session);return includeColumns?result:result.rows;
  }
  async _identity(session){
    const rows=await this._read(session,'SELECT VERSION(),@@hostname,@@port,@@server_id,@@lower_case_table_names,@@sql_mode,CURRENT_USER(),DATABASE()');
    if(rows.length!==1||rows[0].length!==8)throw fail('ROCKETBRAIN_SCHEMA_IDENTITY','The database server identity could not be observed.');
    const [version,hostname,port,serverId,tableCase,mode,user,database]=rows[0],maria=/mariadb/i.test(version),numbers=/^(\d+)\.(\d+)/.exec(version);
    if(!numbers||(maria?(Number(numbers[1])<10||Number(numbers[1])===10&&Number(numbers[2])<5):Number(numbers[1])<8))throw fail('ROCKETBRAIN_SCHEMA_VERSION','Schema rename requires MySQL 8 or later, or MariaDB 10.5 or later.');
    let serverUniqueId;try{const unique=await this._read(session,maria?'SELECT @@server_uid':'SELECT @@server_uuid');serverUniqueId=unique[0]?.[0];}catch{throw fail('ROCKETBRAIN_SCHEMA_IDENTITY','The server unique identity is unavailable. Use a server patch exposing MySQL server_uuid or MariaDB server_uid.');}if(typeof serverUniqueId!=='string'||!serverUniqueId)throw fail('ROCKETBRAIN_SCHEMA_IDENTITY','The server unique identity could not be observed.');
    if(database!==this.db._options.database)throw fail('ROCKETBRAIN_SCHEMA_IDENTITY','The owned schema connection selected a different database.');
    return {dialect:maria?'mariadb':'mysql',version,hostname,port:String(port),serverId:String(serverId),serverUniqueId,tableNameCaseSensitive:Number(tableCase)===0,sqlMode:String(mode),currentUser:user,database,endpoint:require('./local-transport').connectionEndpoint(this.db._options)};
  }
  async _snapshot(session,target,identity){
    const schema=this.db._options.database,read=(sql,values=[])=>this._read(session,sql,values);
    const allTables=await read('SELECT TABLE_NAME,TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA=? ORDER BY TABLE_NAME',[schema]);
    const tableRows=await read('SELECT TABLE_NAME,TABLE_TYPE,ENGINE,TABLE_COLLATION,TABLE_COMMENT,ROW_FORMAT,CREATE_OPTIONS FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=?',[schema,target.table]);
    if(tableRows.length!==1||tableRows[0][0]!==target.table)throw fail('ROCKETBRAIN_SCHEMA_MISSING','The exact selected table is no longer visible in the current database.');
    const table=tableRows[0];if(table[1]!=='BASE TABLE'||String(table[2]).toUpperCase()!=='INNODB')throw fail('ROCKETBRAIN_SCHEMA_UNSUPPORTED','The reviewed rename workflow currently supports physical InnoDB base tables only.');
    const columns=await read('SELECT COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,COLUMN_DEFAULT,COLUMN_KEY,EXTRA,ORDINAL_POSITION,COLUMN_COMMENT,CHARACTER_SET_NAME,COLLATION_NAME,GENERATION_EXPRESSION FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION',[schema,target.table]);
    if(!columns.length)throw fail('ROCKETBRAIN_SCHEMA_VISIBILITY','The selected table columns are not visible.');
    const create=await read('SHOW CREATE TABLE '+quote(schema)+'.'+quote(target.table));if(typeof create[0]?.[1]!=='string')throw fail('ROCKETBRAIN_SCHEMA_VISIBILITY','The complete selected table definition is not visible.');
    const indexes=await read('SELECT INDEX_NAME,NON_UNIQUE,SEQ_IN_INDEX,COLUMN_NAME,SUB_PART,INDEX_TYPE,COLLATION,COMMENT,INDEX_COMMENT FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY INDEX_NAME,SEQ_IN_INDEX',[schema,target.table]);
    const foreignKeys=await read('SELECT k.TABLE_SCHEMA,k.TABLE_NAME,k.CONSTRAINT_NAME,k.COLUMN_NAME,k.ORDINAL_POSITION,k.REFERENCED_TABLE_SCHEMA,k.REFERENCED_TABLE_NAME,k.REFERENCED_COLUMN_NAME,r.UPDATE_RULE,r.DELETE_RULE FROM information_schema.KEY_COLUMN_USAGE k LEFT JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA AND r.TABLE_NAME=k.TABLE_NAME AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME WHERE k.REFERENCED_TABLE_NAME IS NOT NULL AND ((k.TABLE_SCHEMA=? AND k.TABLE_NAME=?) OR (k.REFERENCED_TABLE_SCHEMA=? AND k.REFERENCED_TABLE_NAME=?)) ORDER BY k.TABLE_SCHEMA,k.TABLE_NAME,k.CONSTRAINT_NAME,k.ORDINAL_POSITION',[schema,target.table,schema,target.table]);
    const checks=await read("SELECT tc.CONSTRAINT_NAME,cc.CHECK_CLAUSE FROM information_schema.CHECK_CONSTRAINTS cc JOIN information_schema.TABLE_CONSTRAINTS tc ON tc.CONSTRAINT_SCHEMA=cc.CONSTRAINT_SCHEMA AND tc.CONSTRAINT_NAME=cc.CONSTRAINT_NAME WHERE tc.TABLE_SCHEMA=? AND tc.TABLE_NAME=? AND tc.CONSTRAINT_TYPE='CHECK' ORDER BY tc.CONSTRAINT_NAME",[schema,target.table]);
    const partitions=await read('SELECT PARTITION_NAME,PARTITION_METHOD,PARTITION_EXPRESSION,SUBPARTITION_METHOD,SUBPARTITION_EXPRESSION FROM information_schema.PARTITIONS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND PARTITION_NAME IS NOT NULL ORDER BY PARTITION_ORDINAL_POSITION,SUBPARTITION_ORDINAL_POSITION',[schema,target.table]);
    const tableGrants=await read('SELECT GRANTEE,PRIVILEGE_TYPE FROM information_schema.TABLE_PRIVILEGES WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY GRANTEE,PRIVILEGE_TYPE',[schema,target.table]);
    const columnGrants=await read('SELECT GRANTEE,COLUMN_NAME,PRIVILEGE_TYPE FROM information_schema.COLUMN_PRIVILEGES WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY GRANTEE,COLUMN_NAME,PRIVILEGE_TYPE',[schema,target.table]);
    const views=await read('SELECT TABLE_NAME,VIEW_DEFINITION FROM information_schema.VIEWS WHERE TABLE_SCHEMA=? ORDER BY TABLE_NAME',[schema]);
    const routines=await read('SELECT ROUTINE_NAME,ROUTINE_TYPE,ROUTINE_DEFINITION FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=? ORDER BY ROUTINE_NAME,ROUTINE_TYPE',[schema]);
    const triggers=await read('SELECT TRIGGER_NAME,EVENT_OBJECT_TABLE,ACTION_STATEMENT FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=? ORDER BY TRIGGER_NAME',[schema]);
    const events=await read('SELECT EVENT_NAME,EVENT_DEFINITION FROM information_schema.EVENTS WHERE EVENT_SCHEMA=? ORDER BY EVENT_NAME',[schema]);
    const snapshot={identity,allTables,table,columns,createSql:stableCreate(create[0][1]),indexes,foreignKeys,checks,partitions,tableGrants,columnGrants,views,routines,triggers,events};if(Buffer.byteLength(JSON.stringify(snapshot))>LIMITS.metadataBytes)throw fail('ROCKETBRAIN_SCHEMA_LIMIT','The schema review exceeds the supported metadata snapshot size.');return snapshot;
  }
  _validate(snapshot,target){
    const equalTable=(left,right)=>snapshot.identity.tableNameCaseSensitive?left===right:folded(left)===folded(right);
    if(target.kind==='table'&&snapshot.allTables.some(row=>equalTable(row[0],target.newName)))throw fail('ROCKETBRAIN_SCHEMA_COLLISION','A table or view with the destination name already exists.');
    if(target.kind==='column'){
      if(!snapshot.columns.some(row=>row[0]===target.column))throw fail('ROCKETBRAIN_SCHEMA_MISSING','The exact selected column is no longer visible.');
      if(snapshot.columns.some(row=>folded(row[0])===folded(target.newName)))throw fail('ROCKETBRAIN_SCHEMA_COLLISION','A column with the destination name already exists.');
      if(snapshot.columns.some(row=>row[10]||/DEFAULT_GENERATED/.test(row[5])&&!/^\(?current_timestamp(?:\(\d*\))?\)?$/i.test(String(row[3])) )||snapshot.partitions.length||snapshot.checks.length||snapshot.indexes.some(row=>row[3]===null))throw fail('ROCKETBRAIN_SCHEMA_DEPENDENCY','Column rename with generated/default expressions, CHECK constraints, expression indexes or partition expressions requires a separate migration plan.');
    }
    if(target.kind==='table'&&(snapshot.tableGrants.length||snapshot.columnGrants.length)||target.kind==='column'&&snapshot.columnGrants.some(row=>folded(row[1])===folded(target.column)))throw fail('ROCKETBRAIN_SCHEMA_DEPENDENCY','Visible grants bound to the renamed object require a separate reviewed privilege migration. Rename does not promise to move those grants.');
    const dependencies=[],hiddenDefinitions=[];
    for(const [kind,rows,index]of [['view',snapshot.views,1],['routine',snapshot.routines,2],['trigger',snapshot.triggers,2],['event',snapshot.events,1]])for(const row of rows){const body=row[index];if(kind==='trigger'&&row[1]===target.table){dependencies.push({kind,name:row[0]});continue;}if(typeof body!=='string'){hiddenDefinitions.push({kind,name:row[0]});continue;}if(mentions(body,target.table)||/\b(?:PREPARE|EXECUTE\s+IMMEDIATE)\b/i.test(body))dependencies.push({kind,name:row[0]});}
    if(dependencies.length)throw fail('ROCKETBRAIN_SCHEMA_DEPENDENCY','Stored view/program/trigger/event dependencies require a separate migration plan.',{dependencies});
    return {visibility:'current-account',foreignKeys:snapshot.foreignKeys.length,viewsInspected:snapshot.views.length,routinesInspected:snapshot.routines.length,triggersInspected:snapshot.triggers.length,eventsInspected:snapshot.events.length,storedDependencies:dependencies,hiddenDefinitions,unseenOrDynamicDependenciesExcluded:false};
  }
  async preview(input){
    this._open();if(this.applying)throw fail('ROCKETBRAIN_SCHEMA_BUSY','Wait for the current schema change to finish.');
    const target=normalizeRequest(input),schema=identifier(this.db._options.database),reviewId=randomUUID();this._prune();
    return this._withSession(async session=>{
      const identity=await this._identity(session),snapshot=await this._snapshot(session,target,identity),dependencySummary=this._validate(snapshot,target);
      const plan={reviewId,...target,schema,...ddlFor(schema,target,identity),beforeFingerprint:digest(snapshot),serverIdentity:identity,dependencySummary,requiresUnverifiedDependencyApproval:dependencySummary.hiddenDefinitions.length>0,createdAt:this.clock(),expiresAt:this.clock()+LIMITS.reviewLifetimeMs,implicitCommit:true,transactionalRollback:false,requiresWriteLock:true,warnings:['DDL is executed on a separate owned connection and cannot be transactionally rolled back. Reverse SQL is an optional new operation, not automatic recovery.','Dependency inspection covers objects visible to the current account. Cross-database, hidden, application and dynamically constructed references are not proven absent.','The server may acquire metadata locks; this workflow uses a short lock wait and never retries DDL automatically.',...(dependencySummary.hiddenDefinitions.length?['Some visible object definitions are hidden. Applying requires a separate explicit acknowledgment of unverified dependencies.']:[])],sourceFilesChanged:false};
      this._prune();this.reviews.set(reviewId,{...copy(plan),snapshot});return copy(plan);
    });
  }
  _invalidate(){this.reviews.clear();this.db._revision++;this.db._editor.models.clear();this.db._editor.reviews.clear();}
  async apply(input){
    this._idle();if(this.applying)throw fail('ROCKETBRAIN_SCHEMA_BUSY','Wait for the current schema change to finish.');
    if(typeof input?.reviewId!=='string')throw fail('ROCKETBRAIN_SCHEMA_REVIEW','Review the exact schema rename before applying it.');
    const plan=this.reviews.get(input.reviewId);if(!plan||plan.expiresAt<=this.clock()){this.reviews.delete(input?.reviewId);throw fail('ROCKETBRAIN_SCHEMA_STALE','The schema rename review expired or was already consumed. Review it again.');}
    if(plan.requiresUnverifiedDependencyApproval&&input.allowUnverifiedDependencies!==true)throw fail('ROCKETBRAIN_SCHEMA_UNVERIFIED','Some visible object definitions are hidden. Review the unverified dependencies and explicitly acknowledge them before applying.',{state:'rejected',applied:false,ddlAttempted:false,acknowledged:false,requiresUnverifiedDependencyApproval:true,hiddenDefinitions:copy(plan.dependencySummary.hiddenDefinitions)});
    this.reviews.delete(input.reviewId);this.applying=true;let ddlAttempted=false,acknowledged=false;
    try{return await this._withSession(async session=>{
      const identity=await this._identity(session);if(digest(identity)!==digest(plan.serverIdentity))throw fail('ROCKETBRAIN_SCHEMA_STALE','The database server identity or SQL context changed after review.');
      // The dedicated WRITE lock pins the old object while its fresh metadata is
      // checked. Destination-name races are rejected atomically by one RENAME DDL.
      await this.db._control(session,'LOCK TABLES '+quote(plan.schema)+'.'+quote(plan.table)+' WRITE',5000);
      const fresh=await this._snapshot(session,plan,identity);this._validate(fresh,plan);
      if(digest(fresh)!==plan.beforeFingerprint)throw fail('ROCKETBRAIN_SCHEMA_STALE','The schema or visible dependencies changed after review. No rename was submitted.');
      ddlAttempted=true;
      await this.db._stream(session,plan.sql,[],{maxRows:1,timeoutMs:LIMITS.queryTimeoutMs},true);acknowledged=true;
      this._invalidate();
      // MariaDB's ALTER ... RENAME keeps the former lock name. Release the owned
      // lock after the one acknowledged DDL, then observe the actual new object.
      await this.db._control(session,'UNLOCK TABLES',5000);
      const afterTarget={...plan,table:plan.kind==='table'?plan.newName:plan.table},after=await this._snapshot(session,afterTarget,identity);
      if(digest(structural(after))!==digest(expectedStructure(plan.snapshot,plan,plan.schema)))throw fail('ROCKETBRAIN_SCHEMA_VERIFICATION','The server acknowledged DDL but its post-change definition differs from the reviewed rename.');
      return {state:'applied',applied:true,reviewId:plan.reviewId,kind:plan.kind,schema:plan.schema,table:plan.table,column:plan.column,newName:plan.newName,sql:plan.sql,reverseSql:plan.reverseSql,connectionId:session.connectionId,serverIdentity:identity,acknowledged:true,verified:true,verificationScope:'selected-table-definition-and-visible-foreign-keys',allReferencesVerified:false,afterFingerprint:digest(after),catalogInvalidated:true,implicitCommit:true,transactionalRollback:false,sourceFilesChanged:false,unverifiedDependenciesAccepted:plan.requiresUnverifiedDependencyApproval};
    });}
    catch(error){
      if(ddlAttempted)this._invalidate();
      const unknown=acknowledged||ddlAttempted&&(error.fatal||!/^ER_/.test(error.code||''));
      throw fail(unknown?'ROCKETBRAIN_SCHEMA_OUTCOME_UNKNOWN':error.code||'ROCKETBRAIN_SCHEMA_REJECTED',unknown?'The schema rename outcome could not be fully verified. Do not retry automatically; refresh and inspect the actual database.':error.message,{state:unknown?'unknown':'rejected',applied:unknown?null:false,outcomeUnknown:unknown,ddlAttempted,acknowledged,reviewId:plan.reviewId,catalogInvalidated:ddlAttempted,sourceFilesChanged:false,causeCode:error.code||null,...(error.dependencies?{dependencies:error.dependencies}:{})});
    }finally{this.applying=false;}
  }
  discard(reviewId){return this.reviews.delete(reviewId);}
  dispose(){if(this.disposed)return;this.disposed=true;this.reviews.clear();for(const session of this.sessions){session.closed=true;this.db._lose(session,fail('ROCKETBRAIN_SCHEMA_CLOSED','Schema rename closed while its owned operation was running.'),true);}this.sessions.clear();}
}
module.exports={SchemaRenamer,identifier,normalizeRequest,ddlFor,stableCreate,mentions,structural,expectedStructure,LIMITS};
