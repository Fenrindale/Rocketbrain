'use strict';
const {analyzeSql,statementRanges,sourceRange}=require('./sql-analysis');
const {applySqlRename}=require('./sql-rename');
const crypto=require('node:crypto');
const QUOTE=String.fromCharCode(96),quoted=value=>QUOTE+value.replaceAll(QUOTE,QUOTE+QUOTE)+QUOTE;
class SqlProjectError extends Error{constructor(code,message,extra={}){super(message);this.name='SqlProjectError';this.code=code;Object.assign(this,extra);}}
const eqColumn=(a,b)=>String(a).toLowerCase()===String(b).toLowerCase();
const eqName=(a,b,options)=>options.tableNameCaseSensitive===false?eqColumn(a,b):String(a)===String(b);
const hash=text=>crypto.createHash('sha256').update(text).digest('hex');
const sameRange=(a,b)=>Boolean(a&&b&&a.start===b.start&&a.end===b.end);
function validateIdentifier(value){
  if(typeof value!=='string'||!value||value.trim()!==value||value.length>64||/[\u0000-\u001f\u007f-\u009f.\\/]/.test(value)||[...value].some(c=>c.codePointAt(0)>0xffff||/[\ud800-\udfff]/u.test(c)))throw new SqlProjectError('SQL_PROJECT_NAME','Use an unquoted 1–64 character identifier without dots, slashes, controls or supplementary Unicode.');
  if(/^[`'"]|[`'"]$/.test(value))throw new SqlProjectError('SQL_PROJECT_NAME','Enter the identifier without surrounding SQL quotes.');
}
function normalizeTarget(target,catalog,options={}){
  if(!target||!['table','column'].includes(target.kind))throw new SqlProjectError('SQL_PROJECT_TARGET','Select a physical catalog table or column.');
  const database=options.database||catalog?.database;
  if(!database||!eqName(target.database||database,database,options))throw new SqlProjectError('SQL_PROJECT_DATABASE','SQL project references require the currently observed database.');
  validateIdentifier(target.table);if(target.kind==='column')validateIdentifier(target.column);
  const tables=Array.isArray(catalog)?catalog:[...(catalog?.tables||[]),...(catalog?.views||[])],matches=tables.filter(t=>eqName(t.name,target.table,options));
  if(matches.length!==1)throw new SqlProjectError('SQL_PROJECT_TARGET','The physical table is absent or ambiguous in the observed catalog.');
  const result={kind:target.kind,database,table:matches[0].name};
  if(target.kind==='column'){const columns=(matches[0].columns||[]).filter(c=>eqColumn(c.name,target.column));if(columns.length!==1)throw new SqlProjectError('SQL_PROJECT_TARGET','The physical column is absent or ambiguous in the observed catalog.');result.column=columns[0].name;}
  return result;
}
function matchesOrigin(origin,target,options){return Boolean(origin&&eqName(origin.database,target.database,options)&&eqName(origin.table,target.table,options)&&(target.kind==='table'||origin.column!==undefined&&eqColumn(origin.column,target.column)));}
function affectedReference(ref,target,options){
  if(target.kind==='table')return ref.kind==='table'&&matchesOrigin(ref.catalog,target,options)||ref.kind==='relation'&&matchesOrigin(ref.physicalTable,target,options);
  return ref.kind==='wildcard'?ref.physicalColumns?.some(value=>matchesOrigin(value,target,options)):['column','projection'].includes(ref.kind)&&ref.renamePhysicalColumn!==false&&matchesOrigin(ref.physicalColumn,target,options);
}
function onlyTrivia(text){return !text.replace(/^(?:\s+|--[^\r\n]*(?:\r?\n|$)|#[^\r\n]*(?:\r?\n|$)|\/\*[\s\S]*?\*\/)+/g,'').trim();}
function precedenceUncertain(model){
  return model.references.some(ref=>ref.kind==='projection'&&['GROUP','HAVING'].includes(ref.projectionClause)&&(model._scopes||[]).find(s=>s.id===ref.scopeId)?.relations.some(r=>r.columns.some(c=>eqColumn(c.name,ref.name))));
}
function analyzeProjectDocument(text,catalog,options={}){
  if(typeof text!=='string'||Buffer.byteLength(text)>128*1024)throw new SqlProjectError('SQL_PROJECT_FILE_LIMIT','SQL project files are limited to 128 KiB.');
  const split=statementRanges(text,options),statements=[],unknown=[];let changed=false;
  if(split.statements.length>100)unknown.push({reason:'SQL project files are limited to 100 statements.'});
  for(const part of split.statements.slice(0,100)){
    const source=text.slice(part.start,part.end);if(onlyTrivia(source))continue;
    const model=analyzeSql(source,changed?{tables:[],views:[]}:catalog,changed?{...options,catalogComplete:false,sqlMode:undefined}:options);
    const reasons=model.coverage.unknown.map(v=>v.reason);if(model.state==='invalid')reasons.push(...model.diagnostics.map(d=>d.message));if(precedenceUncertain(model))reasons.push('GROUP BY/HAVING projection alias conflicts with a FROM column; name precedence is not established.');
    if(changed)reasons.push('An earlier statement may change schema/session resolution.');
    const known=model.state==='known'&&!changed&&!precedenceUncertain(model);
    statements.push({...part,model,known});if(!known)unknown.push({...part,reason:reasons.join(' ')||'Unsupported or incomplete SQL statement.'});
    const head=source.replace(/^(?:\s+|--[^\r\n]*(?:\r?\n|$)|#[^\r\n]*(?:\r?\n|$)|\/\*[\s\S]*?\*\/)+/g,'');
    if(/^(?:CREATE|ALTER|DROP|RENAME|TRUNCATE|USE|SET)\b/i.test(head)||/\/\*!/.test(source))changed=true;
  }
  for(const issue of split.unknown||[])unknown.push({reason:issue.reason||String(issue),start:issue.start});
  return {text,hash:hash(text),state:unknown.length?'partial':'known',statements,unknown,executedSql:false};
}
function referencesInDocument(report,target,options={}){
  return report.statements.filter(s=>s.known).flatMap(s=>s.model.references.filter(ref=>!ref.implicit&&affectedReference(ref,target,options)).map(ref=>({start:s.start+ref.start,end:s.start+ref.end,range:sourceRange(report.text,s.start+ref.start,s.start+ref.end),kind:ref.kind,name:ref.name,editEligible:ref.kind!=='wildcard',correlated:Boolean(ref.correlated),target})));
}
function targetAtDocument(report,offset,options={}){
  const statement=report.statements.find(s=>offset>=s.start&&offset<s.end);if(!statement?.known)return null;
  const local=offset-statement.start;if(statement.model._nonCode?.some(s=>local>=s.start&&local<s.end))return null;
  const ref=statement.model.references.find(r=>!r.implicit&&local>=r.start&&local<r.end);if(!ref)return null;
  if(ref.definition&&(['relation-definition','cte-definition','cte-column-definition','projection-definition','projection'].includes(ref.kind)||ref.renamePhysicalColumn===false||ref.kind==='relation'))return {kind:'local',statement,definition:ref.definition,reference:ref};
  const origin=ref.kind==='table'?ref.catalog:ref.kind==='relation'?ref.physicalTable:ref.renamePhysicalColumn!==false?ref.physicalColumn:null;
  if(origin)return {kind:ref.kind==='table'||ref.kind==='relation'?'table':'column',database:origin.database,table:origin.table,...(origin.column?{column:origin.column}:{})};
  if(ref.definition)return {kind:'local',statement,definition:ref.definition,reference:ref};return null;
}
function renamedCatalog(catalog,target,newName,options){
  const result=structuredClone(catalog),tables=Array.isArray(result)?result:[...(result.tables||[]),...(result.views||[])];
  const table=tables.find(t=>eqName(t.name,target.table,options));
  if(target.kind==='table'){
    if(tables.some(t=>t!==table&&eqName(t.name,newName,options)))throw new SqlProjectError('SQL_PROJECT_COLLISION','The new table name already exists in the observed catalog.');table.name=newName;
  }else{
    const column=table.columns.find(c=>eqColumn(c.name,target.column));if(table.columns.some(c=>c!==column&&eqColumn(c.name,newName)))throw new SqlProjectError('SQL_PROJECT_COLLISION','The new column name already exists in the observed table.');column.name=newName;
  }
  return result;
}
function offsetMapper(edits){
  const ordered=[...edits].sort((a,b)=>a.start-b.start);
  const shift=offset=>offset+ordered.filter(e=>e.end<=offset).reduce((sum,e)=>sum+e.newText.length-(e.end-e.start),0);
  return span=>{const edit=ordered.find(e=>sameRange(e,span));return edit?{start:shift(edit.start),end:shift(edit.start)+edit.newText.length}:{start:shift(span.start),end:shift(span.end)};};
}
function transformedOrigin(origin,target,newName,options){
  if(!origin)return null;if(!target)return {...origin};const value={...origin};if(matchesOrigin(origin,target,options)){if(target.kind==='table')value.table=newName;else if(value.column!==undefined)value.column=newName;}return value;
}
function canonical(ref,map,target,newName,options){
  const origin=value=>transformedOrigin(value,target,newName,options);
  return {kind:ref.kind,definition:ref.definition?(map?map(ref.definition):ref.definition):null,catalog:origin(ref.catalog),physicalTable:origin(ref.physicalTable),physicalColumn:origin(ref.physicalColumn),physicalColumns:ref.physicalColumns?.map(origin),renamePhysicalColumn:ref.renamePhysicalColumn!==false,type:ref.type,scopeId:ref.scopeId,relationId:ref.relationId,correlated:Boolean(ref.correlated)};
}
function planCatalogDocumentRename(text,catalog,options,target,newName){
  validateIdentifier(newName);target=normalizeTarget(target,catalog,options);const before=analyzeProjectDocument(text,catalog,options);
  if(before.state!=='known')throw new SqlProjectError('SQL_PROJECT_INCOMPLETE','Unsupported SQL prevents a complete source rename plan.',{unknown:before.unknown});
  const updatedCatalog=renamedCatalog(catalog,target,newName,options),refs=referencesInDocument(before,target,options);
  const edits=target[target.kind==='table'?'table':'column']===newName?[]:[...new Map(refs.filter(r=>r.editEligible).map(r=>[r.start+':'+r.end,{start:r.start,end:r.end,newText:quoted(newName)}])).values()].sort((a,b)=>a.start-b.start);
  for(let i=1;i<edits.length;i++)if(edits[i].start<edits[i-1].end)throw new SqlProjectError('SQL_PROJECT_OVERLAP','SQL rename edits overlap.');
  const resultText=applySqlRename(text,edits),after=analyzeProjectDocument(resultText,updatedCatalog,options);
  if(after.state!=='known'||after.statements.length!==before.statements.length)throw new SqlProjectError('SQL_PROJECT_REBIND','The physical rename creates an invalid, uncertain or captured SQL reference.',{unknown:after.unknown});
  const map=offsetMapper(edits);
  for(let i=0;i<before.statements.length;i++){
    const old=before.statements[i],next=after.statements[i],oldRefs=old.model.references,newRefs=next.model.references;
    if(oldRefs.length!==newRefs.length)throw new SqlProjectError('SQL_PROJECT_REBIND','The source rename changes the SQL reference graph.');
    const localMap=span=>{const full=map({start:old.start+span.start,end:old.start+span.end});return {start:full.start-next.start,end:full.end-next.start};};
    for(const ref of oldRefs){const expected=localMap(ref),matches=newRefs.filter(r=>r.kind===ref.kind&&sameRange(r,expected));if(matches.length!==1||JSON.stringify(canonical(ref,localMap,target,newName,options))!==JSON.stringify(canonical(matches[0],null,null,null,options)))throw new SqlProjectError('SQL_PROJECT_CAPTURE','The physical rename changes the binding of a selected or unrelated SQL reference.');}
  }
  return {target,newName,edits,resultText,beforeHash:before.hash,afterHash:after.hash,references:refs.length,verification:{state:'rebound',allOriginalBindingsPreserved:true,sourceOnly:true,serverExecutionVerified:false},executedSql:false};
}
module.exports={SqlProjectError,hash,normalizeTarget,analyzeProjectDocument,referencesInDocument,targetAtDocument,planCatalogDocumentRename,validateIdentifier,affectedReference};
