'use strict';

const {randomUUID}=require('node:crypto');
const A=require('./schema-trigger-ast');
const D=require('./schema-designer-ddl');
const O=require('./object-editor-ddl');
const {loadSource}=require('./object-source');
const {sourceTokens}=require('./sql-analysis');
const {tableProtection}=require('./write-protection');

const fail=message=>Object.assign(Error(message),{code:'ROCKETBRAIN_EVENT_SOURCE'});
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const states=new Set(['alter-pending','applied','needs-inspection','restore-pending','recovered','original-verified']);
const timeZone=/^(?:[+-](?:0[0-9]|1[0-4]):[0-5][0-9]|[A-Za-z][A-Za-z0-9_+\-/]{0,63})$/u;
const validZone=value=>typeof value==='string'&&timeZone.test(value);
const writeOptions={maxRows:1,timeoutMs:10000};
const quote=(schema,name)=>D.q(schema)+'.'+D.q(name);

function parseEventBody(source,definition) {
  if (typeof source!=='string'||!source.trim()||Buffer.byteLength(source)>32768||source.includes('\0')) {
    throw fail('Use a nonempty supported event body of at most 32 KiB.');
  }
  if (!/^[A-Za-z0-9_,]*$/u.test(definition.sqlMode)||/(?:^|,)ORACLE(?:,|$)/u.test(definition.sqlMode)) {
    throw fail('The stored event SQL mode is outside the verified editor context.');
  }
  if (!/^utf8(?:mb[34])?$/iu.test(definition.charset)&&/[^\x00-\x7f]/u.test(source)) {
    throw fail('Non-ASCII event edits require an observed UTF-8 client character set.');
  }
  let ast;
  try { ast=A.parseProgram(source,definition.schema,undefined,{kind:'event',sqlMode:definition.sqlMode,allowRows:false,allowDynamic:false}); }
  catch { throw fail('Use an INSERT, UPDATE with WHERE, or DELETE with WHERE, optionally in a BEGIN/END block.'); }
  let statements=0;
  A.walk(ast.statements,node=>{
    if (node.kind==='block') return;
    if (!['insert','update','delete'].includes(node.kind)) throw fail('Only bounded INSERT, UPDATE and DELETE event statements are supported.');
    statements++;
  });
  if (!statements||statements>16||ast.calls.length||ast.userVariables.length||ast.targets.length>8) {
    throw fail('Review up to 16 direct event statements and eight statically named targets.');
  }
  for (const target of ast.targets) {
    if (target.schema!==definition.schema) throw fail('The edited event must use only same-schema targets.');
    D.name(target.table);
  }
  return ast;
}

function extractEventBody(show,metadata) {
  const tokens=sourceTokens(show,{sqlMode:metadata.sqlMode.split(',').filter(Boolean)});
  const header=tokens.findIndex(token=>token.kind==='word'&&token.upper==='EVENT');
  const boundary=tokens.find((token,index)=>index>header&&token.kind==='word'&&token.upper==='DO');
  if (tokens[0]?.upper!=='CREATE'||header<0||!boundary) throw fail('The server did not reveal a complete CREATE EVENT source.');
  const source=show.slice(boundary.end).trim();
  if (!same(parseEventBody(source,metadata),parseEventBody(metadata.body,metadata))) {
    throw fail('SHOW CREATE EVENT and the visible stored body do not agree.');
  }
  return boundary.end;
}

function alterEvent(definition,body) {
  parseEventBody(body,definition);
  return 'ALTER DEFINER = CURRENT_USER EVENT '+quote(definition.schema,definition.name)+' DISABLE DO '+body.trim();
}

const fixedContext=({body,ddl,alteredAt,bodyHash,...metadata})=>metadata;
const metadataSql='SELECT EVENT_SCHEMA,EVENT_NAME,DEFINER,TIME_ZONE,EVENT_BODY,EVENT_DEFINITION,EVENT_TYPE,'+
  'CAST(EXECUTE_AT AS CHAR),INTERVAL_VALUE,INTERVAL_FIELD,CAST(STARTS AS CHAR),CAST(ENDS AS CHAR),STATUS,ON_COMPLETION,'+
  'SQL_MODE,CHARACTER_SET_CLIENT,COLLATION_CONNECTION,DATABASE_COLLATION,EVENT_COMMENT,'+
  'UNIX_TIMESTAMP(CREATED),UNIX_TIMESTAMP(LAST_ALTERED),UNIX_TIMESTAMP(LAST_EXECUTED),ORIGINATOR '+
  'FROM information_schema.EVENTS WHERE BINARY EVENT_SCHEMA=BINARY ? AND BINARY EVENT_NAME=BINARY ? LIMIT 2';

function eventMetadata(row,server,name) {
  if (row?.length!==23) throw fail('The selected event metadata is unavailable.');
  const [schema,event,definer,zone,language,body,eventType,executeAt,intervalValue,intervalField,starts,ends,status,completion,
    sqlMode,charset,collation,databaseCollation,comment,createdAt,alteredAt,lastExecuted,originator]=row;
  if (schema!==server.database||event!==name||definer!==server.currentUser||status!=='DISABLED'||language!=='SQL'||
      !['ONE TIME','RECURRING'].includes(eventType)||!['PRESERVE','NOT PRESERVE'].includes(completion)||!validZone(zone)) {
    throw fail('Choose an existing disabled SQL event owned by the current database account.');
  }
  for (const value of [charset,collation,databaseCollation]) D.safe(value);
  return {kind:'event',schema,name,definer,zone,eventType,executeAt,intervalValue,intervalField,starts,ends,status,completion,
    sqlMode,charset,collation,databaseCollation,comment,createdAt,alteredAt,lastExecuted,originator,body};
}

class EventSourceEditor {
  constructor(editor,limits) {
    this.editor=editor;
    this.limits=limits;
  }

  read(session,sql,values,options) {return this.editor.transport._read(session,sql,values,options);}
  async list(session,server) {
    return this.read(session,"SELECT EVENT_NAME FROM information_schema.EVENTS WHERE BINARY EVENT_SCHEMA=BINARY ? "+
      "AND STATUS='DISABLED' AND BINARY DEFINER=BINARY ? ORDER BY EVENT_NAME LIMIT 200",[server.database,server.currentUser]);
  }

  async locate(session,server,name) {
    D.name(name);
    const rows=await this.read(session,metadataSql,[server.database,name]);
    if (rows.length!==1) throw fail('The exact scheduled event is no longer visible.');
    const observed=eventMetadata(rows[0],server,name);
    const {source,settings}=await loadSource((sql,values)=>this.read(session,sql,values,{includeColumns:true}),server,
      {kind:'event',schema:server.database,name});
    if (settings.sql_mode!==observed.sqlMode||settings.time_zone!==observed.zone||
        settings.character_set_client!==observed.charset||settings.collation_connection!==observed.collation||
        settings['database collation']!==observed.databaseCollation) {
      throw fail('The two event metadata sources disagree. Inspect the current event again.');
    }
    extractEventBody(source,observed);
    if (!same(rows,await this.read(session,metadataSql,[server.database,name]))) throw fail('The event changed while observing its source.');
    return {...observed,ddl:source,bodyHash:O.hash(parseEventBody(observed.body,observed))};
  }

  async scope(session,server,definition,bodies) {
    const programs=bodies.map(body=>parseEventBody(body,definition));
    const targets=[...new Map(programs.flatMap(program=>program.targets).map(target=>[target.table,target])).values()]
      .sort((a,b)=>a.table.localeCompare(b.table));
    if (targets.length>8) throw fail('The original and replacement together use more than eight event targets.');
    const tables=await this.editor._targets(session,{kind:'event',targets},server);
    for (const target of tables) {
      const protection=tableProtection(this.editor.db._writeProtection,target.schema,target.name);
      if (protection) throw fail(protection);
      if (target.kind!=='table'||String(target.engine).toUpperCase()!=='INNODB'||!target.createSql) {
        throw fail('The reviewed event requires observed InnoDB base tables and readable CREATE TABLE sources.');
      }
      const triggers=await this.read(session,'SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE '+
        'BINARY EVENT_OBJECT_SCHEMA=BINARY ? AND BINARY EVENT_OBJECT_TABLE=BINARY ? LIMIT 1',[target.schema,target.name]);
      if (triggers.length) throw fail('Review visible triggers on an event target separately before changing this body.');
      if (target.foreignKeys.some(link=>link.referencedSchema!==server.database||
          ['CASCADE','SET NULL','SET DEFAULT'].includes(link.onUpdate)||['CASCADE','SET NULL','SET DEFAULT'].includes(link.onDelete))) {
        throw fail('Event targets with cross-schema or cascading foreign keys need separate review.');
      }
      const inbound=await this.read(session,'SELECT k.TABLE_SCHEMA,r.UPDATE_RULE,r.DELETE_RULE FROM information_schema.KEY_COLUMN_USAGE k '+
        'JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON BINARY k.CONSTRAINT_SCHEMA=BINARY r.CONSTRAINT_SCHEMA '+
        'AND BINARY k.CONSTRAINT_NAME=BINARY r.CONSTRAINT_NAME AND BINARY k.TABLE_NAME=BINARY r.TABLE_NAME '+
        'WHERE BINARY k.REFERENCED_TABLE_SCHEMA=BINARY ? AND BINARY k.REFERENCED_TABLE_NAME=BINARY ?',
      [target.schema,target.name]);
      if (inbound.some(([schema,update,remove])=>schema!==server.database||
          [update,remove].some(rule=>['CASCADE','SET NULL','SET DEFAULT'].includes(rule)))) {
        throw fail('Inbound cascading or cross-schema relationships need separate review.');
      }
    }
    for (const program of programs) {
      try { A.validate(program,{database:server.database,tables}); }
      catch { throw fail('An event statement refers to a missing or unsupported target column.'); }
    }
    return tables.map(({schema,name,kind,engine,columns,indexes,foreignKeys,checks,partitions})=>
      ({schema,name,fingerprint:O.hash({kind,engine,columns,indexes,foreignKeys,checks,partitions})}));
  }

  async inspect(input) {
    const e=this.editor;
    if(input.create===true) throw fail('Open an existing disabled scheduled event.');
    return e.transport._withSession(async session=>{
      e._check(input);
      const server=await e._start(session), definition=await this.locate(session,server,input.name);
      const scope=await this.scope(session,server,definition,[definition.body]);
      const modelId=randomUUID();
      while(e.models.size>=this.limits.models)e.models.delete(e.models.keys().next().value);
      e.models.set(modelId,{server,definition,scope,expiresAt:Date.now()+this.limits.lifetimeMs});
      return {modelId,kind:'event',name:definition.name,database:server.database,source:definition.body,
        schedule:fixedContext(definition),bodyOnly:true,validationCreatesOwnedObject:false};
    });
  }

  async preview(input,model) {
    const e=this.editor,definition=model.definition,program=parseEventBody(input.source,definition);
    if (O.hash(program)===definition.bodyHash) throw fail('Change the event body before creating a review.');
    const replacement={body:A.render(program),bodyHash:O.hash(program)};
    e.applying=true;
    try {
      return await e.transport._withSession(async session=>{
        const server=await e._start(session), observed=await this.locate(session,server,definition.name);
        e._check(input);
        if(!same(server,model.server)||!same(observed,definition)||
           !same(await this.scope(session,server,definition,[definition.body]),model.scope)) {
          throw fail('The event, target structure or connection context changed. Reopen the source.');
        }
        const scope=await this.scope(session,server,definition,[definition.body,replacement.body]);
        e._check(input);
        const reviewId=randomUUID(),operationId=randomUUID().replaceAll('-','');
        const record={format:'RocketbrainObjectAuthoring',formatVersion:1,id:operationId,server,kind:'event',
          name:definition.name,original:{definition},replacement,scope,state:'alter-pending'};
        record.fingerprint=this.fingerprint(record);
        const review={reviewId,operationId,kind:'event',name:definition.name,expiresAt:Date.now()+120000,schedule:fixedContext(definition),
          requiresImplicitCommitApproval:true,requiresEventDeploymentApproval:true,
          validation:{parsed:true,targetsVerified:true,compiled:false,executed:false,createdObject:false},
          sql:['-- The event stays disabled. Review excludes schedule and definer changes.',
            '-- Pause external event and schema edits before applying this source.',
            '-- Observed schedule '+definition.eventType+' in '+definition.zone+' ('+definition.completion+').',
            alterEvent(definition,replacement.body)+';'].join('\n')};
        while(e.reviews.size>=this.limits.reviews)e.reviews.delete(e.reviews.keys().next().value);
        e.reviews.set(reviewId,{record:structuredClone(record),review:structuredClone(review)});
        return review;
      });
    } finally {e.applying=false;}
  }

  fingerprint(record) {return O.hash([record.id,record.server,record.original,record.replacement,record.scope]);}

  validateRecord(record,server) {
    const original=record.original?.definition;
    if(record.formatVersion!==1||!original||original.kind!=='event'||original.schema!==server.database||
       original.definer!==server.currentUser||original.name!==record.name||original.status!=='DISABLED'||
       !validZone(original.zone)||!Array.isArray(record.scope)||!states.has(record.state)||
       record.fingerprint!==this.fingerprint(record)||
       record.publishedHash!==undefined&&!/^[0-9a-f]{64}$/u.test(record.publishedHash)) {
      throw fail('The retained scheduled event review or context changed.');
    }
    for(const value of [original.charset,original.collation,original.databaseCollation])D.safe(value);
    extractEventBody(original.ddl,original);
    if (O.hash(parseEventBody(original.body,original))!==original.bodyHash||
        O.hash(parseEventBody(record.replacement?.body,original))!==record.replacement?.bodyHash) {
      throw fail('The retained event body checksum changed.');
    }
    return record;
  }

  async context(session,definition,action) {
    const e=this.editor,before=(await this.read(session,'SELECT @@session.time_zone'))[0]?.[0];
    if (!validZone(before)||!validZone(definition.zone)) throw fail('The session or event time zone is unavailable.');
    try {
      await e.db._control(session,'SET SESSION time_zone='+D.literal(definition.zone,{sqlMode:''}));
      return await e._context(session,definition,action);
    } finally {
      if (session.connected) await e.db._control(session,'SET SESSION time_zone='+D.literal(before,{sqlMode:''}));
    }
  }

  async apply(input,saved) {
    const e=this.editor,record=structuredClone(saved.record);
    if(input.allowImplicitCommit!==true||input.allowEventDeployment!==true) {
      throw fail('Acknowledge the reviewed ALTER EVENT and stop external event edits during verification.');
    }
    e._check(input);
    e.reviews.delete(input.reviewId);
    e.applying=true;
    try {
      return await e.transport._withSession(async session=>{
        const server=await e._start(session);
        await e._locks(session,server);
        const original=record.original.definition;
        if(!same(server,record.server)||!same(original,await this.locate(session,server,record.name))||
           !same(record.scope,await this.scope(session,server,original,[original.body,record.replacement.body]))) {
          throw fail('The original event, target definitions or connection changed after review.');
        }
        e._check(input);
        await e._journal(session,true);
        return this.deploy(session,server,record,input,{before:original,restore:false});
      });
    } finally {e.applying=false;e.db._revision++;}
  }

  async deploy(session,server,record,input,{before,restore}) {
    const e=this.editor,original=record.original.definition;
    const intended=restore?original:record.replacement;
    record.state=restore?'restore-pending':'alter-pending';
    await e._save(session,record);
    if (!same(before,await this.locate(session,server,record.name))) {
      record.state='needs-inspection';
      await e._save(session,record);
      throw fail('The stored event changed before issuing the reviewed ALTER.');
    }
    e._check(input);
    try {
      await this.context(session,original,()=>e.db._stream(session,alterEvent(original,intended.body),[],writeOptions,true));
      const after=await this.locate(session,server,record.name);
      if(!same(fixedContext(after),fixedContext(original))||after.bodyHash!==intended.bodyHash||
         restore&&after.body!==original.body) {
        throw fail('The server did not confirm the disabled event body and preserved schedule.');
      }
      record.state=restore?'recovered':'applied';
      if (!restore) record.publishedHash=O.hash(after);
      await e._save(session,record);
      return {operationId:record.id,state:record.state,kind:'event',status:'DISABLED',bodyExecuted:false,autoRetried:false,
        scheduleAndContextPreserved:true,originalRetained:true,definitionVerified:true};
    } catch(error) {
      record.state='needs-inspection';
      if(session.connected) await e._save(session,record);
      return {operationId:record.id,state:record.state,kind:'event',bodyExecuted:false,autoRetried:false,
        errorCode:error.code||'ROCKETBRAIN_EVENT_SOURCE'};
    }
  }

  async recover(session,record,server,input) {
    const e=this.editor;
    if(input.allowImplicitCommit!==true||input.allowEventDeployment!==true) throw fail('Acknowledge the reviewed disabled event restoration.');
    const original=record.original.definition,current=await this.locate(session,server,record.name);
    if (!same(fixedContext(current),fixedContext(original))) throw fail('The event status, schedule or creation context changed. Restoration is refused.');
    if (current.body===original.body&&current.bodyHash===original.bodyHash) {
      record.state='original-verified';
      await e._save(session,record);
      return {operationId:record.id,state:record.state,kind:'event',bodyExecuted:false,autoRetried:false};
    }
    if(current.bodyHash!==record.replacement.bodyHash||record.publishedHash&&O.hash(current)!==record.publishedHash) {
      throw fail('The live event differs from the verified replacement. Restoration is refused.');
    }
    if(!same(record.scope,await this.scope(session,server,original,[original.body,record.replacement.body]))) {
      throw fail('The reviewed event target structure changed. Publish a new review before restoring.');
    }
    return this.deploy(session,server,record,input,{before:current,restore:true});
  }
}

module.exports={EventSourceEditor,parseEventBody,extractEventBody,alterEvent};
