'use strict';

const { analyzeSql,statementRanges,sourceTokens }=require('./sql-analysis');
const generatedColumn=require('./schema-generated-column');
const { endpointKey }=require('./join-catalog');
const scriptIndexes=require('./ddl-script-indexes');

const tableLimit=256;
const supportedTypes=new Set([
  'TINYINT','SMALLINT','MEDIUMINT','INT','INTEGER','BIGINT','DECIMAL','NUMERIC','DOUBLE','REAL','FLOAT',
  'BIT','BOOLEAN','BOOL','CHAR','VARCHAR','TEXT','TINYTEXT','MEDIUMTEXT','LONGTEXT',
  'BINARY','VARBINARY','BLOB','TINYBLOB','MEDIUMBLOB','LONGBLOB','DATE','TIME','DATETIME','TIMESTAMP',
  'YEAR','ENUM','SET','JSON','GEOMETRY','POINT','LINESTRING','POLYGON'
]);
const starters=new Set(['CREATE','ALTER','DROP','RENAME','TRUNCATE','USE','SET']);
const columnConstraints=new Set(['CONSTRAINT','FOREIGN','UNIQUE','KEY','INDEX','CHECK','FULLTEXT','SPATIAL']);
const same=(a,b)=>a.toLowerCase()===b.toLowerCase();
const objectEquals=(a,b,model)=>model.tableNameCaseSensitive===false?same(a,b):a===b;
const word=(token,value)=>token?.kind==='word'&&token.upper===value;
const value=(token,text)=>token?.kind==='symbol'&&token.value===text;
const identifier=token=>{
  if (!['word','identifier'].includes(token?.kind)||!token.value||token.value.length>64||
      /[\x00-\x1f\x7f]/.test(token.value)) throw Error('Choose a plain or quoted SQL identifier.');
  return token.value;
};

function nameAt(tokens,at,schema) {
  const first=identifier(tokens[at]);
  if (!value(tokens[at+1],'.')) return {name:first,next:at+1};
  if (first!==schema) throw Error('The statement targets a different schema.');
  return {name:identifier(tokens[at+2]),next:at+3};
}

function match(tokens,start) {
  if (!value(tokens[start],'(')) throw Error('Expected an explicit SQL definition list.');
  let depth=0;
  for (let at=start;at<tokens.length;at++) {
    if (value(tokens[at],'('))depth++;
    if (value(tokens[at],')')&&--depth===0)return at;
  }
  throw Error('The SQL definition list is not closed.');
}

function split(tokens,start,end) {
  const groups=[];
  let depth=0,begin=start;
  for(let at=start;at<end;at++){
    if(value(tokens[at],'('))depth++;
    else if(value(tokens[at],')'))depth--;
    else if(depth===0&&value(tokens[at],',')){
      if(begin===at)throw Error('The SQL definition has an empty item.');
      groups.push(tokens.slice(begin,at));
      begin=at+1;
    }
  }
  if(begin===end)throw Error('The SQL definition has an empty list.');
  groups.push(tokens.slice(begin,end));
  return groups;
}

function column(source,tokens,{generatedDialect}={}) {
  const name=identifier(tokens[0]),type=tokens[1];
  if(type?.kind!=='word'||!supportedTypes.has(type.upper))throw Error('The column type is outside the virtual schema model.');
  let end=value(tokens[2],'(')?match(tokens,2)+1:2;
  while(word(tokens[end],'UNSIGNED')||word(tokens[end],'ZEROFILL')||word(tokens[end],'PRECISION'))end++;
  let primaryKey=false,notNull=false,generationExpression,extra;
  const typeEnd=end;
  while(end<tokens.length){
    const option=tokens[end++];
    if(generatedDialect&&(word(option,'GENERATED')||word(option,'AS'))){
      if(end-1!==typeEnd)throw Error('Declare the virtual generation expression directly after its column type.');
      if(word(option,'GENERATED')){
        if(!word(tokens[end],'ALWAYS')||!word(tokens[end+1],'AS'))throw Error('Use GENERATED ALWAYS AS or AS for a virtual column.');
        end+=2;
      }
      const close=match(tokens,end);
      generationExpression=source.slice(tokens[end].end,tokens[close].start).trim();
      end=close+1;
      if(word(tokens[end],'PERSISTENT')&&generatedDialect!=='mariadb')throw Error('Use STORED or VIRTUAL for a MySQL generated column.');
      const mode=word(tokens[end],'STORED')||word(tokens[end],'PERSISTENT')?'STORED':'VIRTUAL';
      if(['STORED','PERSISTENT','VIRTUAL'].some(value=>word(tokens[end],value)))end++;
      if(end!==tokens.length)throw Error('A generated overlay column uses an expression and optional storage mode.');
      extra=mode+' GENERATED';
    }else if(word(option,'PRIMARY')&&word(tokens[end],'KEY')){
      primaryKey=true;end++;
    }else if(word(option,'NOT')&&word(tokens[end],'NULL')){
      notNull=true;end++;
    }else if(word(option,'NULL')||word(option,'AUTO_INCREMENT')){
      continue;
    }else if(word(option,'DEFAULT')||word(option,'COMMENT')){
      const literal=tokens[end++];
      if(!['number','string'].includes(literal?.kind)&&!word(literal,'NULL')&&
        !word(literal,'CURRENT_TIMESTAMP')&&!word(literal,'TRUE')&&!word(literal,'FALSE')){
        throw Error('Use a literal or CURRENT_TIMESTAMP default in the virtual schema.');
      }
    }else{
      throw Error('This column option is outside the reviewed virtual schema grammar.');
    }
  }
  const rawType=source.slice(type.start,tokens[typeEnd-1].end).trim();
  return {name,type:generationExpression===undefined?rawType:rawType.replace(/\s*([(),])\s*/gu,'$1'),nullable:!notNull&&!primaryKey,primaryKey,virtual:true,
    ...(generationExpression!==undefined&&{generationExpression,extra,defaultValue:null})};
}

function constraints(source,groups,automatic) {
  const columns=[],primary=[],indexGroups=[];
  for (const tokens of groups) {
    if(word(tokens[0],'PRIMARY')&&word(tokens[1],'KEY')){
      if(primary.length)throw Error('A virtual table cannot declare duplicate primary keys.');
      const close=match(tokens,2);
      for(const group of split(tokens,3,close)) {
        if(group.length!==1)throw Error('Use plain primary-key column names.');
        primary.push(identifier(group[0]));
      }
      continue;
    }
    if(tokens[0].kind==='word'&&columnConstraints.has(tokens[0].upper)){
      if(automatic){
        if(!['INDEX','KEY','UNIQUE'].includes(tokens[0].upper))throw Error('This table constraint is outside the script catalog.');
        indexGroups.push(tokens);
      }
      continue;
    }
    const next=column(source,tokens);
    if(columns.some(item=>same(item.name,next.name)))throw Error('Duplicate virtual table columns.');
    columns.push(next);
  }
  if(!columns.length||columns.length>256)throw Error('A virtual table requires one to 256 columns.');
  for(const name of primary) {
    const selected=columns.find(item=>same(item.name,name));
    if(!selected)throw Error('A primary key refers to an unknown column.');
    selected.primaryKey=true;
    selected.nullable=false;
  }
  if(!automatic)return {columns};
  const indexes=indexGroups.map(tokens=>scriptIndexes.addedIndex(tokens,columns));
  if(indexes.length>64||new Set(indexes.map(index=>index.name.toLowerCase())).size!==indexes.length)throw Error('Use at most 64 distinct secondary indexes.');
  return {columns:scriptColumns(columns),indexes,foreignKeys:[]};
}

const scriptColumns=columns=>columns.map((column,index)=>({...column,extra:column.extra??'',ordinal:index+1}));

function createView(source,tokens,after,model,overlay) {
  if(!word(tokens[after],'AS')||!(word(tokens[after+1],'SELECT')||overlay&&word(tokens[after+1],'WITH')))
    throw Error('Use an explicit SELECT-based virtual view.');
  const query=source.slice(tokens[after+1].start);
  const proof=analyzeSql(query,model,{dialect:model.dialect,database:model.database,catalogComplete:true,
    tableNameCaseSensitive:model.tableNameCaseSensitive,sqlMode:model.sqlMode,
    ...(overlay&&{joinOrigins:true,joinTables:overlay.joinTables})});
  if(overlay){
    const pending=proof.relations.filter(relation=>relation.requested&&!relation.catalog&&
      !objectEquals(relation.requested.schema,model.database,model)).map(relation=>relation.requested);
    if(pending.length)throw Object.assign(Error('The external view inputs need current catalog metadata.'),{endpoints:pending});
  }
  if(proof.state!=='known'||!proof.projections.length||proof.projections.length>256)throw Error('The virtual view output could not be bound to known columns.');
  const familyTypes={integer:'bigint',string:'varchar(4096)',boolean:'tinyint',decimal:'decimal',
    floating:'double',date:'date',temporal:'datetime',json:'json',binary:'varbinary(4096)'};
  const columns=proof.projections.map(({name,type})=>({
    name,type:type?.dbType||familyTypes[type?.family],nullable:type?.nullable!==false,primaryKey:false,virtual:true
  }));
  if(columns.some(item=>!item.type||!item.name||item.name.length>64)||
      new Set(columns.map(item=>item.name.toLowerCase())).size!==columns.length)throw Error('Use distinct, typed virtual view columns.');
  const inputs=proof.relations.flatMap(relation=>relation.catalog?[relation.catalog]:[]);
  const dependencies=[...new Set(inputs.filter(item=>objectEquals(item.database,model.database,model)).map(item=>item.table))];
  const external=inputs.filter(item=>!objectEquals(item.database,model.database,model)).map(item=>({schema:item.database,table:item.table}));
  const externalDependencies=[...new Map(external.map(item=>[endpointKey(item),item])).values()];
  return {columns,dependencies,...(externalDependencies.length&&{externalDependencies})};
}

function createTable(source,tokens,after,automatic) {
  const close=match(tokens,after);
  let at=close+1,engine;
  while(at<tokens.length){
    if(word(tokens[at],'DEFAULT'))at++;
    const option=tokens[at++];
    if(word(option,'CHARACTER')&&word(tokens[at],'SET'))at++;
    else if(!['ENGINE','CHARSET','COLLATE'].some(name=>word(option,name))){
      throw Error('Only literal ENGINE, CHARSET and COLLATE table options are modeled.');
    }
    if(value(tokens[at],'='))at++;
    const selected=identifier(tokens[at++]);
    if(word(option,'ENGINE'))engine=selected;
  }
  const definition=constraints(source,split(tokens,after+1,close),automatic);
  if(automatic&&definition.indexes.length&&engine?.toUpperCase()!=='INNODB')throw Error('Declare ENGINE=InnoDB for a new table with modeled indexes.');
  return {...definition,...(automatic&&engine&&{engine})};
}

function launchAlter(source,tokens,at,table,liveViewsUnresolved,overlay,automatic,indexesObserved) {
  const columns=table.columns.map(item=>({...item}));
  const indexes=automatic&&Array.isArray(table.indexes)?table.indexes.map(index=>({...index,columns:index.columns.map(column=>({...column}))})):undefined;
  const indexChanges=[], usedIndexes=new Set(), usedColumns=new Set();
  const reserve=name=>{
    if(!automatic)return;
    if(usedColumns.has(name.toLowerCase()))throw Error('Use separate ALTER statements when changing the same column twice.');
    usedColumns.add(name.toLowerCase());
  };
  const changes=split(tokens,at,tokens.length);
  if(overlay&&(changes.length!==1||!word(changes[0][0],'ADD')))throw Error('Use one additive column definition per ALTER TABLE in a saved overlay.');
  for(const tokens of changes){
    const action=tokens[0]?.upper;
    const start=word(tokens[1],'COLUMN')?2:1;
    if(automatic&&scriptIndexes.isIndexAlter(tokens)){
      if(!indexes||!indexesObserved||String(table.engine).toUpperCase()!=='INNODB')throw Error('Index modeling requires observed InnoDB table and index metadata.');
      const change=scriptIndexes.alterIndex(tokens,{columns,indexes},usedIndexes);
      indexChanges.push(change);
      continue;
    }
    if(action==='ADD'){
      const chosen=column(source,tokens.slice(start),{generatedDialect:overlay?.dialect});
      if(chosen.primaryKey||tokens.some(token=>word(token,'FIRST')||word(token,'AFTER'))||
          columns.some(item=>same(item.name,chosen.name)))throw Error('Use a distinct simple appended column.');
      reserve(chosen.name);
      columns.push(chosen);
      if(chosen.generationExpression!==undefined)generatedColumn.definition(chosen,columns);
    }else if(action==='DROP'){
      if(tokens.length!==start+1)throw Error('Use one column name when dropping a virtual column.');
      const name=identifier(tokens[start]),index=columns.findIndex(item=>same(item.name,name));
      if(index<0||columns[index].primaryKey)throw Error('Use an existing non-key column for this virtual drop.');
      if(liveViewsUnresolved&&!columns[index].virtual)throw Error('The live view dependencies on this column are unavailable.');
      if(automatic&&(!columns[index].virtual||!indexesObserved))throw Error('Remove only a column introduced earlier in the script with known index coverage.');
      if(automatic&&indexes?.some(key=>key.columns.some(column=>column.name&&same(column.name,name))))throw Error('Drop the modeled index before removing its column.');
      reserve(name);
      columns.splice(index,1);
    }else if(action==='RENAME'){
      if(!word(tokens[1],'COLUMN')||!word(tokens[3],'TO')||tokens.length!==5)throw Error('Use RENAME COLUMN old TO new.');
      const from=identifier(tokens[2]),to=identifier(tokens[4]);
      const selected=columns.find(item=>same(item.name,from));
      if(!selected||columns.some(item=>same(item.name,to)))throw Error('The virtual column name is missing or already present.');
      if(liveViewsUnresolved&&!selected.virtual)throw Error('The live view dependencies on this column are unavailable.');
      if(automatic&&(!selected.virtual||!indexesObserved))throw Error('Rename only a column introduced earlier in the script with known index coverage.');
      reserve(from);reserve(to);
      if(automatic)for(const key of indexes??[])for(const column of key.columns)if(column.name&&same(column.name,from))column.name=to;
      selected.name=to;
      selected.virtual=true;
    }else{
      throw Error('Supported virtual ALTER actions are ADD, DROP and RENAME COLUMN.');
    }
  }
  if(!columns.length||columns.length>256)throw Error('A virtual table requires one to 256 columns.');
  return {table:{...table,columns:automatic?scriptColumns(columns):columns,...(indexes&&{indexes})},indexChanges};
}

function applyDdl(source,model,overlay,{automatic=false}={}) {
  if (!/^\s*(?:(?:--[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)\s*)*(CREATE|ALTER|DROP|RENAME|TRUNCATE|USE|SET)\b/i.test(source)) return null;
  const tokens=sourceTokens(source,{sqlMode:model.sqlMode});
  if(value(tokens.at(-1),';'))tokens.pop();
  const action=tokens[0]?.upper;
  if(!starters.has(action))return null;
  if(!['CREATE','DROP','ALTER'].includes(action))throw Error('This statement changes the context outside the reviewed virtual schema grammar.');
  const indexAt=word(tokens[1],'UNIQUE')&&action==='CREATE'?2:1;
  if(automatic&&['CREATE','DROP'].includes(action)&&word(tokens[indexAt],'INDEX')){
    if(!word(tokens[indexAt+2],'ON'))throw Error('Use a named index and explicit ON table target.');
    const target=nameAt(tokens,indexAt+3,model.database),table=model.tables.find(item=>objectEquals(item.name,target.name,model));
    if(!table||action==='DROP'&&target.next!==tokens.length)throw Error('Use a single observed table for this script index operation.');
    const modifier=action==='CREATE'?{kind:'word',upper:'ADD'}:tokens[0];
    const clause=[modifier,...tokens.slice(1,indexAt+2),...tokens.slice(target.next)];
    const edited=launchAlter(source,clause,0,table,false,null,true,table.virtual||model.coverage?.indexes==='loaded');
    return {model:{...model,tables:model.tables.map(item=>item===table?edited.table:item),virtual:true},
      change:{action:'alter',kind:'table',name:table.name,indexChanges:edited.indexChanges}};
  }
  let at=1;
  const replace=action==='CREATE'&&word(tokens[1],'OR')&&word(tokens[2],'REPLACE');
  if(replace)at=3;
  const kind=word(tokens[at],'TABLE')?'table':word(tokens[at],'VIEW')?'view':null;
  if(!kind||replace&&kind!=='view')throw Error('Only ordinary table and SELECT view definitions are modeled.');
  at++;
  let conditional=false;
  if(action==='CREATE'&&word(tokens[at],'IF')&&word(tokens[at+1],'NOT')&&word(tokens[at+2],'EXISTS')){
    conditional=true;at+=3;
  }else if(action==='DROP'&&word(tokens[at],'IF')&&word(tokens[at+1],'EXISTS')){
    conditional=true;at+=2;
  }
  if(overlay&&(conditional||replace||!(action==='CREATE'&&kind==='view'||action==='ALTER'&&kind==='table'))){
    throw Error('Saved overlays accept CREATE VIEW and ALTER TABLE ADD COLUMN definitions.');
  }
  const {name,next}=nameAt(tokens,at,model.database);
  const field=kind==='table'?'tables':'views';
  const existing=[...model.tables,...model.views].find(item=>objectEquals(item.name,name,model));
  if(existing&&(existing.kind||(model.tables.includes(existing)?'table':'view'))!==kind)throw Error('The virtual object has a different type.');
  const hasDependentView=model.views.some(view=>view.dependencies?.some(dependency=>objectEquals(name,dependency,model)));
  if(hasDependentView&&(action!=='CREATE'||replace))throw Error('A modeled view depends on this object. Model its removal first.');
  const liveViewsUnresolved=model.views.some(view=>view!==existing&&!view.virtual);
  if(automatic&&(conditional||(action==='DROP'||replace)&&!existing?.virtual))throw Error('Conditional DDL or removal of a live object requires explicit dependency review.');
  if(existing&&!existing.virtual&&(action==='DROP'||replace)&&liveViewsUnresolved){
    throw Error('The live view dependencies are unavailable in the virtual schema preview.');
  }
  let updated=[...model[field]],indexChanges;
  if(action==='CREATE'){
    if(conditional&&existing)return {model,change:{action:'retain',kind,name}};
    if(existing&&!replace)throw Error('A virtual schema object with this name already exists.');
    const definition=kind==='table'?createTable(source,tokens,next,automatic):createView(source,tokens,next,model,overlay);
    const table={name,kind,...definition,virtual:true};
    updated=existing?updated.map(item=>item===existing?table:item):[...updated,table];
  }else if(action==='ALTER'){
    if(kind!=='table')throw Error('ALTER requires a table in the virtual schema.');
    if(!existing)throw Error('The ALTER target is unobserved in this virtual schema.');
    const changed=launchAlter(source,tokens,next,existing,liveViewsUnresolved,overlay,automatic,existing.virtual||model.coverage?.indexes==='loaded');
    updated=updated.map(item=>item===existing?changed.table:item);
    indexChanges=changed.indexChanges;
  }else{
    if(next!==tokens.length)throw Error('Drop a single exact table or view in this virtual model.');
    if(!existing&&!conditional)throw Error('The DROP target is unobserved in this virtual schema.');
    updated=updated.filter(item=>item!==existing);
  }
  if(updated.length+model[kind==='table'?'views':'tables'].length>tableLimit)throw Error('The virtual schema is limited to 256 objects.');
  return {model:{...model,[field]:updated,virtual:true},change:{action:action.toLowerCase(),kind,name,
    ...(indexChanges?.length&&{indexChanges})}};
}

function emptySchema(database,dialect='mysql') {
  if(typeof database!=='string'||!/^[A-Za-z_][A-Za-z0-9_$-]{0,63}$/.test(database))throw Error('Choose a literal virtual schema name.');
  if(!['mysql','mariadb'].includes(dialect))throw Error('Choose MySQL or MariaDB mode.');
  return {database,dialect,virtual:true,tables:[],views:[],coverage:{tables:'loaded',columns:'loaded'},visibility:'local-ddl'};
}

function parseSchema(text,database,dialect) {
  let model=emptySchema(database,dialect);
  const parts=statementRanges(text,{dialect});
  if(parts.unknown.length||parts.statements.length>100)throw Error('Use at most 100 DDL definitions with known lexical structure.');
  const changes=[];
  for(const part of parts.statements){
    const source=text.slice(part.start,part.end);
    if(!source.replace(/--[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\//g,'').trim())continue;
    const proposal=applyDdl(source,model);
    if(!proposal)throw Error('A DDL catalog file contains table or view definitions.');
    model=proposal.model;
    changes.push(proposal.change);
  }
  if(!model.tables.length&&!model.views.length)throw Error('Select a DDL file with a visible table or view definition.');
  return {model,changes};
}

function analyzeDdlScript(text,seed) {
  const opts={dialect:seed.dialect,database:seed.database,tableNameCaseSensitive:seed.tableNameCaseSensitive,sqlMode:seed.sqlMode,
    ...(seed.overlayExternalTables&&{joinOrigins:true,joinTables:seed.overlayExternalTables})};
  const split=statementRanges(text,opts),known=split.unknown.length===0&&split.statements.length<=100;
  let catalog=seed,uncertain=!known,contextMayChange=false;
  const changes=[],issues=[];
  const statements=split.statements.slice(0,100).map(part=>{
    const source=text.slice(part.start,part.end);
    if(!uncertain){
      try {
        const applied=applyDdl(source,catalog);
        if(applied){
          catalog=applied.model;
          contextMayChange=true;
          changes.push({...applied.change,start:part.start});
          return {...part,virtual:true,model:{state:'known',text:source,diagnostics:[],references:[],projections:[],executedSql:false}};
        }
      }catch(error){
        uncertain=true;
        contextMayChange=true;
        issues.push({reason:error.message,start:part.start});
      }
    }
    const model=analyzeSql(source,uncertain?null:catalog,{...opts,catalogComplete:!uncertain&&
      catalog.coverage?.tables==='loaded'&&catalog.coverage?.columns==='loaded'});
    return {...part,model,virtual:true};
  });
  return {statements,contextMayChange,unknown:[...split.unknown,...issues],changes,
    state:statements.some(part=>part.model.state==='invalid')?'invalid':
      uncertain||statements.some(part=>part.model.state==='unknown')?'unknown':'known'};
}

function scriptCatalogSupported(seed) {
  if (!seed?.semanticContextObserved || seed.cachedMetadata || !Array.isArray(seed.sqlMode) || seed.sqlMode.includes('ORACLE') ||
      !['tables','columns'].every(area=>seed.coverage?.[area]==='loaded')) return false;
  const version = /^(\d+)\.(\d+)\.(\d+)/.exec(seed.serverVersion ?? '');
  if (!version) return false;
  const [,major,minor,patch]=version.map(Number);
  if (seed.dialect==='mysql') return major>=8 && !/mariadb/i.test(seed.serverVersion);
  return seed.dialect==='mariadb' && /mariadb/i.test(seed.serverVersion) && (major>10 || major===10 && (minor>5 || minor===5 && patch>=3));
}

function liveScriptAction(source, lexicalIssues) {
  const head=source.replace(/^(?:\s+|--\s[^\r\n]*(?:\r?\n|$)|#[^\r\n]*(?:\r?\n|$)|\/\*[\s\S]*?\*\/)+/u,'');
  return /^(?:CREATE|ALTER|DROP|RENAME|TRUNCATE|USE|SET|CALL|DELIMITER|DO|PREPARE|EXECUTE|DEALLOCATE|GRANT|REVOKE|LOAD)\b/i.test(head) ||
    lexicalIssues.some(issue=>issue.reason.startsWith('Executable comments'));
}

function analyzeLiveDdlScript(text,seed,split=statementRanges(text,seed)) {
  const changesContext=part=>liveScriptAction(text.slice(part.start,part.end),
    split.unknown.filter(issue=>issue.start>=part.start&&issue.start<part.end));
  if (!scriptCatalogSupported(seed) || !split.statements.some(changesContext)) return null;
  const options={dialect:seed.dialect,database:seed.database,tableNameCaseSensitive:seed.tableNameCaseSensitive,sqlMode:seed.sqlMode};
  let catalog=seed,contextMayChange=false,uncertain=split.statements.length>100 || split.unknown.some(issue=>issue.start===undefined);
  const changes=[],issues=[];
  const statements=split.statements.slice(0,100).map(part=>{
    const source=text.slice(part.start,part.end),priorContextChange=contextMayChange;
    const statement={...part,priorContextChange,scriptShadow:priorContextChange&&!uncertain};
    if (statement.scriptShadow) Object.defineProperty(statement,'scriptCatalog',{value:catalog});
    if (changesContext(part)) {
      contextMayChange=true;
      if (!uncertain) try {
        if (!/;\s*$/u.test(source)) throw Error('Complete this DDL statement before modeling later statements.');
        const applied=applyDdl(source,catalog,null,{automatic:true});
        if (!applied) throw Error('This command may change the connection context outside the script catalog.');
        catalog=applied.model;
        changes.push({...applied.change,start:part.start});
        return {...statement,model:{state:'known',text:source,diagnostics:[],references:[],projections:[],executedSql:false,validityVerified:false}};
      } catch (error) {
        uncertain=true;
        issues.push({reason:error.message,start:part.start});
      }
    }
    if (uncertain) {
      const model=analyzeSql(source,null,{...options,sqlMode:undefined,catalogComplete:false});
      return {...statement,model,scriptShadow:false,contextUncertain:true};
    }
    const analysisSource=statement.scriptShadow?scriptIndexes.maskModeledHint(source,catalog):source;
    statement.model=analyzeSql(analysisSource,catalog,{...options,catalogComplete:true});
    statement.model.text=source;
    return statement;
  });
  return {statements,contextMayChange,changes,unknown:[...split.unknown,...issues],
    state:statements.some(part=>part.model.state==='invalid')?'invalid':uncertain||statements.some(part=>part.model.state==='unknown')?'unknown':'known'};
}

module.exports={applyDdl,emptySchema,parseSchema,analyzeDdlScript,analyzeLiveDdlScript};
