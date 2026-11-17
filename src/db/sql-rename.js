'use strict';
const {analyzeSql,sourceRange}=require('./sql-analysis');

class SqlRenameError extends Error {constructor(code,message){super(message);this.name='SqlRenameError';this.code=code;}}
const key=span=>span?span.start+':'+span.end:null;
const same=(a,b)=>key(a)===key(b);
const equal=(a,b)=>String(a).toLowerCase()===String(b).toLowerCase();
const isDefinition=ref=>ref.kind.endsWith('-definition');
const quoted=name=>'`'+name.replaceAll('`','``')+'`';
function identifiers(model){return model.references.filter(isDefinition).map(ref=>({...ref,id:key(ref.definition)}));}
function requireKnown(model){if(model.state!=='known')throw new SqlRenameError('SQL_RENAME_UNCERTAIN','Complete the supported SELECT statement and resolve its uncertain or invalid bindings before renaming.');}
function selectedSymbol(model,offset){
  requireKnown(model);
  if(!Number.isInteger(offset)||offset<0||offset>model.text.length)throw new SqlRenameError('SQL_RENAME_POSITION','Select a local SQL identifier.');
  if(model._nonCode?.some(span=>offset>=span.start&&offset<span.end))throw new SqlRenameError('SQL_RENAME_NOT_AVAILABLE','Comments and string literals are not SQL rename targets.');
  const symbols=identifiers(model),direct=symbols.find(ref=>ref.start<ref.end&&offset>=ref.start&&offset<ref.end);
  const refs=model.references.filter(ref=>!ref.implicit&&offset>=ref.start&&offset<ref.end);
  const at=direct||refs[0]||model.references.find(ref=>!ref.implicit&&offset===ref.end&&ref.start<ref.end);
  const symbol=direct||symbols.find(candidate=>same(candidate.definition,at?.definition));
  if(!symbol)throw new SqlRenameError('SQL_RENAME_EXTERNAL','This identifier has no proven local SQL declaration. Renaming catalog tables or columns requires a separate schema migration.');
  if(symbol.kind.includes('projection')||symbol.kind==='cte-column-definition'){
    if((model._scopes||[]).some(scope=>scope.projections.some(value=>same(value.definition,symbol.definition))&&scope.projections.some(value=>!same(value.definition,symbol.definition)&&equal(value.name,symbol.name))))throw new SqlRenameError('SQL_RENAME_UNCERTAIN','The current output name is duplicated; disambiguate its declarations before renaming.');
    if(symbol.kind==='cte-column-definition'&&symbols.some(value=>value.kind===symbol.kind&&!same(value.definition,symbol.definition)&&same(value.ownerDefinition,symbol.ownerDefinition)&&equal(value.name,symbol.name)))throw new SqlRenameError('SQL_RENAME_UNCERTAIN','The CTE currently declares duplicate output names.');
  }
  return {symbol,selected:at||symbol,symbols};
}
function preparation(model,offset){const {symbol,selected}=selectedSymbol(model,offset);return {name:symbol.name,kind:symbol.kind.replace(/-definition$/,''),range:sourceRange(model.text,selected.start,selected.end),start:selected.start,end:selected.end,definition:{...symbol.definition},implicit:Boolean(symbol.implicit),scope:'statement-local',executedSql:false,schemaMutation:false};}
function prepareSqlRename(text,catalog,options,offset){return preparation(analyzeSql(text,catalog,options),offset);}
function validateName(name){
  if(typeof name!=='string'||!name||name.trim()!==name||name.length>64||/[\u0000-\u001f\u007f-\u009f.\\/]/.test(name)||[...name].some(char=>char.codePointAt(0)>0xffff||/[\ud800-\udfff]/u.test(char)))throw new SqlRenameError('SQL_RENAME_NAME','Use 1–64 identifier characters without leading/trailing whitespace, dots, slashes, control characters or supplementary Unicode characters.');
  if(name.startsWith('`')||name.endsWith('`')||name.startsWith('"')||name.endsWith('"')||name.startsWith("'")||name.endsWith("'"))throw new SqlRenameError('SQL_RENAME_NAME','Enter the identifier text without surrounding SQL quotes. Identifier quoting is applied automatically.');
}
function scopeCollision(model,symbol,symbols,name){
  const other=symbols.filter(value=>value.id!==symbol.id&&equal(value.name,name));
  const projection=['projection-definition','implicit-projection-definition'].includes(symbol.kind);
  if(other.some(value=>symbol.kind==='cte-definition'?value.kind==='cte-definition'&&value.cteGroup===symbol.cteGroup:symbol.kind==='cte-column-definition'?value.kind==='cte-column-definition'&&same(value.ownerDefinition,symbol.ownerDefinition):projection?['projection-definition','implicit-projection-definition'].includes(value.kind)&&value.scopeId===symbol.scopeId:value.kind==='relation-definition'&&value.scopeId===symbol.scopeId))throw new SqlRenameError('SQL_RENAME_COLLISION','The new name duplicates another declaration in the same SQL scope.');
  if(projection||symbol.kind==='cte-column-definition'){
    for(const scope of model._scopes||[])if(scope.projections.some(value=>same(value.definition,symbol.definition))&&scope.projections.some(value=>!same(value.definition,symbol.definition)&&equal(value.name,name)))throw new SqlRenameError('SQL_RENAME_COLLISION','The new output name would duplicate another column in a derived/CTE result.');
  }
  // MySQL GROUP/HAVING can prefer FROM columns over projection aliases.
  // The SELECT binder does not establish that ambiguity as a rename contract.
  if(projection){
    for(const ref of model.references.filter(value=>value.kind==='projection'&&same(value.definition,symbol.definition)&&['GROUP','HAVING'].includes(value.projectionClause))){const scope=(model._scopes||[]).find(s=>s.id===ref.scopeId);if(scope?.relations.some(relation=>relation.columns.some(column=>equal(column.name,symbol.name)||equal(column.name,name))))throw new SqlRenameError('SQL_RENAME_PRECEDENCE','GROUP BY/HAVING name precedence conflicts with a FROM column; qualify or explicitly disambiguate the query before renaming.');}
  }
}
function applySqlRename(text,edits){let result=text;for(const edit of [...edits].sort((a,b)=>b.start-a.start))result=result.slice(0,edit.start)+edit.newText+result.slice(edit.end);return result;}
function mapper(edits,target){
  const ordered=[...edits].sort((a,b)=>a.start-b.start);
  const shift=(offset)=>{let delta=0;for(const edit of ordered)if(edit.start===edit.end?edit.start<offset:edit.end<=offset)delta+=edit.newText.length-(edit.end-edit.start);return offset+delta;};
  return span=>{
    if(target.implicit&&same(span,target.definition)){const edit=ordered.find(e=>e.start===target.start&&e.end===target.end);const start=shift(target.start)+4;return {start,end:start+edit.newText.length-4};}
    const edit=ordered.find(e=>e.start!==e.end&&same(e,span));if(edit){const start=shift(edit.start);return {start,end:start+edit.newText.length};}
    return {start:shift(span.start),end:shift(span.end)};
  };
}
function binding(ref,map){
  if(ref.definition)return 'local:'+key(map?map(ref.definition):ref.definition);
  if(ref.catalog)return 'catalog:'+JSON.stringify(ref.catalog)+':'+(ref.kind==='column'?ref.name.toLowerCase():'');
  return 'unresolved:'+ref.kind+':'+ref.name;
}
function planSqlRename(text,catalog,options,offset,newName){
  validateName(newName);
  const before=analyzeSql(text,catalog,options),{symbol,selected,symbols}=selectedSymbol(before,offset);
  scopeCollision(before,symbol,symbols,newName);
  const base={...preparation(before,offset),newName,beforeName:symbol.name,validityVerified:false};
  if(newName===symbol.name)return {...base,edits:[],renamedBindings:0,resultText:text};
  const refs=before.references.filter(ref=>same(ref.definition,symbol.definition));
  const edits=[...new Map(refs.map(ref=>[key(ref),{start:ref.start,end:ref.end,newText:ref.implicit?' AS '+quoted(newName):quoted(newName)}])).values()].sort((a,b)=>a.start-b.start);
  if(!edits.length)throw new SqlRenameError('SQL_RENAME_NOT_AVAILABLE','No proven local references were found.');
  for(let i=1;i<edits.length;i++)if(edits[i].start<edits[i-1].end)throw new SqlRenameError('SQL_RENAME_OVERLAP','The rename edit ranges overlap.');
  const resultText=applySqlRename(text,edits),after=analyzeSql(resultText,catalog,options);
  if(after.state!=='known')throw new SqlRenameError('SQL_RENAME_REBIND','The proposed name creates an invalid, ambiguous or unsupported SQL binding.');
  const map=mapper(edits,symbol),targetDefinition=map(symbol.definition);
  const afterSymbols=identifiers(after),renamed=afterSymbols.find(value=>same(value.definition,targetDefinition));
  if(!renamed||renamed.name!==newName)throw new SqlRenameError('SQL_RENAME_REBIND','The renamed declaration could not be verified in the edited SQL.');
  for(const old of before.references){
    const location=map(old),kind=old.implicit&&same(old.definition,symbol.definition)?'projection-definition':old.kind;
    const updated=after.references.filter(ref=>ref.kind===kind&&same(ref,location));
    if(updated.length!==1||binding(old,map)!==binding(updated[0])||JSON.stringify(old.type)!==JSON.stringify(updated[0].type))throw new SqlRenameError('SQL_RENAME_CAPTURE','The proposed rename changes the binding of a selected or unrelated reference. Choose a name that does not capture or shadow another symbol.');
  }
  if(after.references.length!==before.references.length)throw new SqlRenameError('SQL_RENAME_REBIND','The edited SQL changes the reference graph beyond the selected symbol.');
  return {...base,edits,renamedBindings:refs.length,resultText,verification:{state:'rebound',allOriginalBindingsPreserved:true,sourceOnly:true,serverExecutionVerified:false},selectedRange:sourceRange(text,selected.start,selected.end)};
}
module.exports={prepareSqlRename,planSqlRename,applySqlRename,SqlRenameError};
