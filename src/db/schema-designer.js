'use strict';
const {randomUUID,createHash}=require('node:crypto'),E=require('./schema-diff'),D=require('./schema-designer-ddl'),{SchemaRenamer}=require('./schema-rename');
const generated = require('./schema-generated-column');
const clone=value=>structuredClone(value),fail=message=>Object.assign(Error(message),{code:'ROCKETBRAIN_DESIGNER'}),LIMITS={models:8,modelMs:600000,reviews:8};
const known=(value,keys)=>{if(!value||Array.isArray(value)||typeof value!=='object'||Object.keys(value).some(k=>!keys.includes(k)))throw fail('Use only the visible typed designer fields.');};
function draft(table,server) {
 return { name:table.name,comment:table.comment,charset:table.charset,collation:table.collation,
  columns:table.columns.map(column => {
   let value=column.defaultValue,kind=value===null?'none':'literal';
   if(value!==null&&/current_timestamp/i.test(value))kind='currentTimestamp';
   else if(value!==null&&server.dialect==='mariadb'&&value.startsWith("'"))value=D.unliteral(value,server);
   const generation = generated.definition(column, table.columns);
   return { name:column.name,type:column.type,nullable:column.nullable,defaultKind:kind,defaultValue:value||'',
    autoIncrement:/auto_increment/i.test(column.extra),comment:column.comment,charset:column.charset||'',
    collation:column.collation||'',srsId:column.srsId??'',generationMode:generation?.generation||'none',
    generationExpression:generation?.expression||'' };
  }), indexes:clone(table.indexes),foreignKeys:clone(table.foreignKeys),checks:clone(table.checks) };
}

function columnFromDraft(column, index, current) {
 known(column,['name','type','nullable','defaultKind','defaultValue','autoIncrement','comment','charset','collation','srsId','generationMode','generationExpression']);
 const generationMode = column.generationMode ?? 'none', expression = column.generationExpression ?? '';
 if(!['none','virtual','stored'].includes(generationMode)||typeof expression!=='string'||generationMode==='none'&&expression.trim()) {
  throw fail('Choose a generated storage kind for the expression.');
 }
 if(typeof column.nullable!=='boolean'||typeof column.autoIncrement!=='boolean')throw fail('Choose explicit NULL/AUTO_INCREMENT settings.');
 if(!['none','literal','currentTimestamp'].includes(column.defaultKind))throw fail('Choose no default, literal or CURRENT_TIMESTAMP.');
 if(generationMode!=='none'&&(column.defaultKind!=='none'||column.autoIncrement))throw fail('A generated column cannot have a default or AUTO_INCREMENT.');
 let defaultValue=null;
 if(column.defaultKind==='currentTimestamp'){
  if(!/^(?:datetime|timestamp)(?:\([0-6]\))?$/i.test(column.type))throw fail('CURRENT_TIMESTAMP requires a calendar timestamp column.');
  defaultValue='CURRENT_TIMESTAMP'+(/\(([0-6])\)/.exec(column.type)?.[0]||'');
 } else if(column.defaultKind==='literal'){
  if(typeof column.defaultValue!=='string')throw fail('Enter an exact literal default.');
  const category=require('./schema-conversion').category(column);
  defaultValue=current.server.dialect==='mariadb'&&category!=='number'?D.literal(column.defaultValue,current.server):column.defaultValue;
 }
 const extra = generationMode==='none' ? column.autoIncrement?'auto_increment':'' : generationMode.toUpperCase()+' GENERATED';
 const result={name:column.name,type:column.type,nullable:column.nullable,defaultValue,key:'',extra,ordinal:index+1,
  comment:column.comment||'',charset:column.charset||null,collation:column.collation||null,generationExpression:expression.trim()};
 if(column.srsId!==''&&column.srsId!==null&&column.srsId!==undefined){
  const srsId=Number(column.srsId);if(![0,4326,3857].includes(srsId))throw fail('Choose explicit SRID0,4326or3857.');result.srsId=srsId;
 }
 return result;
}
function tableFromDraft(value,current){known(value,['name','comment','charset','collation','columns','indexes','foreignKeys','checks']);D.name(value.name);for(const key of ['columns','indexes','foreignKeys','checks'])if(!Array.isArray(value[key]))throw fail('The designer '+key+' list is missing.');const table={name:value.name,kind:'table',engine:'InnoDB',charset:value.charset||'utf8mb4',collation:value.collation||'utf8mb4_bin',comment:value.comment||'',rowFormat:'Dynamic',createOptions:'',createSql:'',partitions:[],columns:value.columns.map((column,index)=>columnFromDraft(column,index,current)),indexes:value.indexes.map(i=>{known(i,['name','unique','primaryKey','type','comment','columns']);if(typeof i.unique!=='boolean'||typeof i.primaryKey!=='boolean'||!Array.isArray(i.columns))throw fail('Choose explicit index settings.');return{...clone(i),name:i.primaryKey?'PRIMARY':i.name,columns:i.columns.map((c,n)=>{known(c,['name','ordinal','prefixLength','collation']);return{name:c.name,ordinal:n+1,prefixLength:c.prefixLength==null||c.prefixLength===''?null:Number(c.prefixLength),collation:c.collation||'A'};})};}),foreignKeys:value.foreignKeys.map(f=>{known(f,['name','referencedSchema','referencedTable','onDelete','onUpdate','columns']);if(!Array.isArray(f.columns))throw fail('Choose foreign-key column mappings.');return{...clone(f),referencedSchema:current.database,columns:f.columns.map((c,n)=>{known(c,['name','referencedColumn','ordinal']);return{name:c.name,referencedColumn:c.referencedColumn,ordinal:n+1};})};}),checks:value.checks.map(c=>{known(c,['name','expression']);return{name:c.name,expression:D.check(c.expression,value.columns)};})};D.validate(table,current.tables,current.database);return table;}
class SchemaDesigner{
 constructor(db,{createSession}={}){this.db=db;this.transport=new SchemaRenamer(db,{createSession});this.models=new Map();this.reviews=new Map();this.operations=new Set();this.applying=false;this.disposed=false;}
 _idle(){this.db._assertOpen();if(this.disposed||this.applying||this.db._objectEditor?.applying)throw fail('Finish the current database authoring operation.');this.db._schemaRecovery._idle();}
 _track(fn){const work=fn();this.operations.add(work);void work.finally(()=>this.operations.delete(work)).catch(()=>{});return work;}
 _capture(session,options={}){return E.captureSchema({_metadataQuery:async(sql,values)=>({rows:await this.transport._read(session,sql,values),truncated:false})},options);}
 _check(input){if(this.disposed||input?.guard&&input.guard()!==true||input?.cancellation?.aborted||input?.cancellation?.isCancellationRequested)throw fail('The workspace, connection or designer operation changed.');}
 open(input={}) {
  return this._track(async()=>{
   this._idle();
   const verify = () => { this._check(input); input.assertSqlSourceCurrent?.(); };
   return this.transport._withSession(async session=>{
    verify();
    const { table, missingTable, missingColumn } = input;
    if (missingTable !== undefined && (table !== undefined || missingColumn !== undefined) ||
        missingColumn !== undefined && !table) throw fail('Choose one unresolved table or column.');
    if (missingTable !== undefined) D.name(missingTable);
    if (missingColumn !== undefined) D.name(missingColumn);
    const current = await this._capture(session);
    const existing = table ? current.tables.find(item=>item.name===table) : null;
    if (table && !existing) throw fail('The selected table is no longer visible.');
    if (existing && (existing.kind!=='table'||existing.engine.toUpperCase()!=='INNODB'||existing.partitions.length)) {
     throw fail('Open an ordinary nonpartitioned InnoDB table.');
    }
    if (existing) generated.validate(existing);
    if (missingTable !== undefined) {
     let absent = false;
     try {
      await this.transport._read(session,'SHOW CREATE TABLE '+D.q(current.database)+'.'+D.q(missingTable));
     } catch (error) {
      absent = error.code === 'ER_NO_SUCH_TABLE' || error.errno === 1146;
      if (!absent) throw fail('The active account could not confirm that the selected table name is missing.');
     }
     if (!absent) throw fail('The selected table name already exists. Refresh the SQL catalog.');
    }
    if (missingColumn !== undefined && existing.columns.some(column=>column.name.toLowerCase()===missingColumn.toLowerCase())) {
     throw fail('The selected column already exists. Refresh the SQL catalog.');
    }
    const seed = existing || {
     name:missingTable??'new_table',comment:'',charset:'utf8mb4',collation:'utf8mb4_bin',
     columns:[{name:'id',type:'BIGINT',nullable:false,defaultValue:null,extra:'auto_increment',comment:'',charset:null,collation:null}],
     indexes:[{name:'PRIMARY',unique:true,primaryKey:true,type:'BTREE',comment:'',columns:[{name:'id',ordinal:1,prefixLength:null,collation:'A'}]}],
     foreignKeys:[],checks:[]
    };
    const draftValue = draft(seed,current.server);
    if (missingColumn !== undefined) draftValue.columns.push({
     name:missingColumn,type:'',nullable:true,defaultKind:'none',defaultValue:'',autoIncrement:false,
     generationMode:'none',generationExpression:'',charset:'',collation:'',comment:'',srsId:''
    });
    verify();
    const id=randomUUID(),model={id,current,existing:table||null,draft:draftValue,expiresAt:Date.now()+LIMITS.modelMs};
    while(this.models.size>=LIMITS.models)this.models.delete(this.models.keys().next().value);
    this.models.set(id,model);
    return {
     modelId:id,expiresAt:model.expiresAt,mode:existing?'alter':'create',database:current.database,server:current.server,draft:clone(model.draft),
     references:current.tables.filter(t=>t.kind==='table'&&!/^__rb_/i.test(t.name)).map(t=>({
      name:t.name,columns:t.columns.map(c=>({name:c.name,type:c.type,nullable:c.nullable})),indexes:clone(t.indexes)
     })),validationCreatesOwnedEmptyTable:true
    };
   });
  });
 }
 preview(input){return this._track(async()=>{this._idle();const saved=this.models.get(input?.modelId);if(!saved||saved.expiresAt<=Date.now())throw fail('Open the designer again; its server model expired.');const value=tableFromDraft(clone(input.draft),saved.current);if(saved.existing&&value.name!==saved.existing)throw fail('Use the dedicated reviewed schema rename command to rename an existing table.');let current,canonical;this.applying=true;try{await this.transport._withSession(async session=>{this._check(input);const key='rocketbrain.migration.'+createHash('sha256').update(saved.current.database).digest('hex').slice(0,40);for(const lock of ['rocketbrain.rebuild.server.v15',key])if(Number((await this.transport._read(session,'SELECT GET_LOCK(?,0)',[lock]))[0]?.[0])!==1)throw fail('Another cooperating schema operation owns this server/database.');current=await this._capture(session);if(current.fingerprint!==saved.current.fingerprint)throw fail('The database schema changed; reopen the designer.');const token=randomUUID().replaceAll('-','').slice(0,20),physical='__rb_designer_'+token,prefix='__rb_d_'+token,marker='Rocketbrain designer validation '+token;let created=false;try{await this.db._stream(session,D.render({...value,comment:marker},current,{physical,constraintPrefix:prefix}),[],{maxRows:1,timeoutMs:10000},true);created=true;if((await this.transport._read(session,'SHOW WARNINGS')).length)throw fail('Server validation produced warnings; adjust the typed design.');const captured=(await this._capture(session,{tables:[physical]})).tables[0];if(captured.comment!==marker)throw fail('The owned validation table marker changed.');canonical={...captured,name:value.name,comment:value.comment,checks:captured.checks.map(c=>({...c,name:c.name.startsWith(prefix+'_c')?value.checks[Number(c.name.slice((prefix+'_c').length))].name:c.name})),foreignKeys:captured.foreignKeys.map(f=>({...f,name:value.foreignKeys[Number(f.name.slice((prefix+'_f').length))].name,referencedTable:f.referencedTable===physical?value.name:f.referencedTable}))};canonical.createSql=D.render(canonical,current);}finally{if(created){const observed=(await this._capture(session,{tables:[physical]})).tables[0];if(!observed||observed.comment!==marker)throw fail('Validation-table ownership changed; no cleanup DDL was submitted.');await this.db._stream(session,'DROP TABLE '+D.q(current.database)+'.'+D.q(physical),[],{maxRows:1,timeoutMs:10000},true);}}this._check(input);});}finally{this.applying=false;}
 const desired=E.normalizeSnapshot({...clone(current),tables:[...current.tables.filter(t=>t.name!==value.name),canonical]},{verifyFingerprint:false}),kind=saved.existing?'rebuild':'create';let prepared;if(kind==='rebuild')prepared=await this.db._schemaRecovery.preview({current,desired,tables:[value.name]});else{const comparison=E.compareSnapshots(current,desired),ids=comparison.changes.filter(c=>c.table===value.name&&c.kind==='create-table'&&c.selectable).map(c=>c.id);if(ids.length!==1)throw fail('This typed CREATE is outside the supported additive migration profile.');prepared=await this.db._schemaApplier.preview({current,desired,changeIds:ids});}const id=randomUUID();while(this.reviews.size>=LIMITS.reviews){const old=this.reviews.keys().next().value;this.discard(old);}this.reviews.set(id,{kind,prepared,modelId:input.modelId});return{...clone(prepared),reviewId:id,kind,modelId:input.modelId,validation:{ownedEmptyTableCompiled:true,dataExecuted:false,cleaned:true},sql:prepared.plan.sql};});}
 apply(input){return this._track(async()=>{this._idle();this._check(input);const saved=this.reviews.get(input?.reviewId);if(!saved)throw fail('Review the typed design again.');if(input.allowImplicitCommit!==true||saved.kind==='rebuild'&&input.allowDestructive!==true)throw fail('Acknowledge the concrete reviewed DDL and retained-original rebuild before applying.');this.reviews.delete(input.reviewId);return saved.kind==='create'?this.db._schemaApplier.apply({...input,reviewId:saved.prepared.reviewId}):this.db._schemaRecovery.apply({...input,reviewId:saved.prepared.reviewId});});}
 discard(id){const r=this.reviews.get(id);this.reviews.delete(id);if(r)(r.kind==='create'?this.db._schemaApplier:this.db._schemaRecovery).discard(r.prepared.reviewId);return Boolean(r);}
 async dispose(){this.disposed=true;for(const id of [...this.reviews.keys()])this.discard(id);this.transport.dispose();await Promise.allSettled([...this.operations]);this.models.clear();}
}
module.exports={SchemaDesigner,LIMITS,draft,tableFromDraft};
