'use strict';

const { analyzeSql,statementRanges,sourceTokens }=require('./sql-analysis');

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

function column(source,tokens) {
  const name=identifier(tokens[0]),type=tokens[1];
  if(type?.kind!=='word'||!supportedTypes.has(type.upper))throw Error('The column type is outside the virtual schema model.');
  let end=value(tokens[2],'(')?match(tokens,2)+1:2;
  while(word(tokens[end],'UNSIGNED')||word(tokens[end],'ZEROFILL')||word(tokens[end],'PRECISION'))end++;
  let primaryKey=false,notNull=false;
  const typeEnd=end;
  while(end<tokens.length){
    const option=tokens[end++];
    if(word(option,'PRIMARY')&&word(tokens[end],'KEY')){
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
  return {name,type:source.slice(type.start,tokens[typeEnd-1].end).trim(),nullable:!notNull&&!primaryKey,primaryKey,virtual:true};
}

function constraints(source,groups) {
  const columns=[],primary=[];
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
    if(tokens[0].kind==='word'&&columnConstraints.has(tokens[0].upper))continue;
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
  return columns;
}

function createView(source,tokens,after,model) {
  if(!word(tokens[after],'AS')||!word(tokens[after+1],'SELECT'))throw Error('Use an explicit SELECT-based virtual view.');
  const query=source.slice(tokens[after+1].start);
  const proof=analyzeSql(query,model,{dialect:model.dialect,database:model.database,catalogComplete:true,
    tableNameCaseSensitive:model.tableNameCaseSensitive,sqlMode:model.sqlMode});
  if(proof.state!=='known'||!proof.projections.length||proof.projections.length>256)throw Error('The virtual view output could not be bound to known columns.');
  const familyTypes={integer:'bigint',string:'varchar(4096)',boolean:'tinyint',decimal:'decimal',
    floating:'double',date:'date',temporal:'datetime',json:'json',binary:'varbinary(4096)'};
  const columns=proof.projections.map(({name,type})=>({
    name,type:type?.dbType||familyTypes[type?.family],nullable:type?.nullable!==false,primaryKey:false,virtual:true
  }));
  if(columns.some(item=>!item.type||!item.name||item.name.length>64)||
      new Set(columns.map(item=>item.name.toLowerCase())).size!==columns.length)throw Error('Use distinct, typed virtual view columns.');
  const dependencies=[...new Set(proof.relations.flatMap(relation=>relation.catalog?.table?[relation.catalog.table]:[]))];
  return {columns,dependencies};
}

function createTable(source,tokens,after) {
  const close=match(tokens,after);
  let at=close+1;
  while(at<tokens.length){
    if(word(tokens[at],'DEFAULT'))at++;
    const option=tokens[at++];
    if(word(option,'CHARACTER')&&word(tokens[at],'SET'))at++;
    else if(!['ENGINE','CHARSET','COLLATE'].some(name=>word(option,name))){
      throw Error('Only literal ENGINE, CHARSET and COLLATE table options are modeled.');
    }
    if(value(tokens[at],'='))at++;
    identifier(tokens[at++]);
  }
  return {columns:constraints(source,split(tokens,after+1,close))};
}

function launchAlter(source,tokens,at,table,liveViewsUnresolved) {
  const columns=table.columns.map(item=>({...item}));
  const changes=split(tokens,at,tokens.length);
  for(const tokens of changes){
    const action=tokens[0]?.upper;
    const start=word(tokens[1],'COLUMN')?2:1;
    if(action==='ADD'){
      const chosen=column(source,tokens.slice(start));
      if(chosen.primaryKey||tokens.some(token=>word(token,'FIRST')||word(token,'AFTER'))||
          columns.some(item=>same(item.name,chosen.name)))throw Error('Use a distinct simple appended column.');
      columns.push(chosen);
    }else if(action==='DROP'){
      if(tokens.length!==start+1)throw Error('Use one column name when dropping a virtual column.');
      const index=columns.findIndex(item=>same(item.name,identifier(tokens[start])));
      if(index<0||columns[index].primaryKey)throw Error('Use an existing non-key column for this virtual drop.');
      if(liveViewsUnresolved&&!columns[index].virtual)throw Error('The live view dependencies on this column are unavailable.');
      columns.splice(index,1);
    }else if(action==='RENAME'){
      if(!word(tokens[1],'COLUMN')||!word(tokens[3],'TO')||tokens.length!==5)throw Error('Use RENAME COLUMN old TO new.');
      const from=identifier(tokens[2]),to=identifier(tokens[4]);
      const selected=columns.find(item=>same(item.name,from));
      if(!selected||columns.some(item=>same(item.name,to)))throw Error('The virtual column name is missing or already present.');
      if(liveViewsUnresolved&&!selected.virtual)throw Error('The live view dependencies on this column are unavailable.');
      selected.name=to;
      selected.virtual=true;
    }else{
      throw Error('Supported virtual ALTER actions are ADD, DROP and RENAME COLUMN.');
    }
  }
  if(!columns.length||columns.length>256)throw Error('A virtual table requires one to 256 columns.');
  return columns;
}

function applyDdl(source,model) {
  if (!/^\s*(?:(?:--[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)\s*)*(CREATE|ALTER|DROP|RENAME|TRUNCATE|USE|SET)\b/i.test(source)) return null;
  const tokens=sourceTokens(source,{sqlMode:model.sqlMode});
  if(value(tokens.at(-1),';'))tokens.pop();
  const action=tokens[0]?.upper;
  if(!starters.has(action))return null;
  if(!['CREATE','DROP','ALTER'].includes(action))throw Error('This statement changes the context outside the reviewed virtual schema grammar.');
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
  const {name,next}=nameAt(tokens,at,model.database);
  const field=kind==='table'?'tables':'views';
  const existing=[...model.tables,...model.views].find(item=>objectEquals(item.name,name,model));
  if(existing&&(existing.kind||(model.tables.includes(existing)?'table':'view'))!==kind)throw Error('The virtual object has a different type.');
  const hasDependentView=model.views.some(view=>view.dependencies?.some(dependency=>objectEquals(name,dependency,model)));
  if(hasDependentView&&(action!=='CREATE'||replace))throw Error('A modeled view depends on this object. Model its removal first.');
  const liveViewsUnresolved=model.views.some(view=>view!==existing&&!view.virtual);
  if(existing&&!existing.virtual&&(action==='DROP'||replace)&&liveViewsUnresolved){
    throw Error('The live view dependencies are unavailable in the virtual schema preview.');
  }
  let updated=[...model[field]];
  if(action==='CREATE'){
    if(conditional&&existing)return {model,change:{action:'retain',kind,name}};
    if(existing&&!replace)throw Error('A virtual schema object with this name already exists.');
    const definition=kind==='table'?createTable(source,tokens,next):createView(source,tokens,next,model);
    const table={name,kind,...definition,virtual:true};
    updated=existing?updated.map(item=>item===existing?table:item):[...updated,table];
  }else if(action==='ALTER'){
    if(kind!=='table')throw Error('ALTER requires a table in the virtual schema.');
    if(!existing)throw Error('The ALTER target is unobserved in this virtual schema.');
    updated=updated.map(item=>item===existing?{...item,columns:launchAlter(source,tokens,next,item,liveViewsUnresolved)}:item);
  }else{
    if(next!==tokens.length)throw Error('Drop a single exact table or view in this virtual model.');
    if(!existing&&!conditional)throw Error('The DROP target is unobserved in this virtual schema.');
    updated=updated.filter(item=>item!==existing);
  }
  if(updated.length+model[kind==='table'?'views':'tables'].length>tableLimit)throw Error('The virtual schema is limited to 256 objects.');
  return {model:{...model,[field]:updated,virtual:true},change:{action:action.toLowerCase(),kind,name}};
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
  const opts={dialect:seed.dialect,database:seed.database,tableNameCaseSensitive:seed.tableNameCaseSensitive,sqlMode:seed.sqlMode};
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

module.exports={applyDdl,emptySchema,parseSchema,analyzeDdlScript};
