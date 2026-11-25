'use strict';

const { analyzeSql,scopeAt,statementRanges }=require('./sql-analysis');
const { quickFixContext }=require('./sql-fix-context');
const { tokenize }=require('./sql-policy');

const knownCodes=new Set(['sql.name.column','sql.name.ambiguous','sql.name.qualifier','sql.name.table']);
const quote=value=>'`'+value.replaceAll('`','``')+'`';
const id=token=>['identifier','word'].includes(token?.kind);
const same=(left,right)=>typeof left==='string'&&typeof right==='string'&&left.toLowerCase()===right.toLowerCase();

function nearby(left,right) {
  if (same(left,right)) return true;
  const [smaller,bigger]=left.length<right.length?[left.toLowerCase(),right.toLowerCase()]:[right.toLowerCase(),left.toLowerCase()];
  if (!smaller || Math.abs(smaller.length-bigger.length)>1) return false;
  let i=0,j=0,changes=0;
  while(i<smaller.length&&j<bigger.length){
    if(smaller[i]===bigger[j]){i++;j++;continue;}
    if(++changes>1)return false;
    if(smaller.length===bigger.length)i++;
    j++;
  }
  return changes+(bigger.length-j)<=1;
}

function sqlQuickFixes(text,offset,catalog) {
  const context=quickFixContext(text,offset,catalog);
  if(!context)return [];
  const { part,source,local:on,options,tokens }=context;
  if(!['SELECT','WITH'].includes(tokens[0]?.upper))return [];
  const before=analyzeSql(source,catalog,options);
  const scope=scopeAt(before,on);
  if(!scope||scope.partial)return [];
  const issue=before.diagnostics.find(item=>knownCodes.has(item.code)&&on>=item.start&&on<item.end);
  if(!issue)return [];
  const at=tokens.findIndex(item=>item.start===issue.start&&item.end===issue.end);
  const target=tokens[at];
  if(!id(target))return [];
  const possible=new Set();
  // JOIN ON binds only the tables introduced at that point in this block.
  const onPredicate=scope.predicates.some(([start,end])=>at>=start&&at<end);
  const relations=onPredicate?scope.relations.filter(item=>item.start<issue.start):scope.relations;
  const left=tokens[at-1]?.value==='.'&&id(tokens[at-2])?tokens[at-2].value:null;
  const column=relation=>relation.columns.some(value=>same(value.name,target.value));
  const offerSole=candidates=>{
    const distinct=[...new Set(candidates)];
    if(distinct.length===1)possible.add(quote(distinct[0]));
  };
  if(issue.code==='sql.name.table'){
    if(!relations.some(item=>item.kind==='catalog'&&!item.catalog&&item.start<=issue.start&&issue.start<item.end))return [];
    if(left&&!same(left,catalog.database))return [];
    offerSole([...catalog.tables,...(catalog.views||[])].map(item=>item.name)
      .filter(name=>name!==target.value&&nearby(name,target.value)));
  }else if(issue.code==='sql.name.qualifier'){
    const columnName=tokens[at+1]?.value==='.'&&id(tokens[at+2])?tokens[at+2].value:null;
    if(!columnName||left&&tokens[at-3]?.value==='.')return [];
    const schemaMatches=item=>!left||item.kind==='catalog'&&!item.definition&&item.catalog&&
      (catalog.tableNameCaseSensitive===false?same(item.catalog.database,left):item.catalog.database===left);
    offerSole(relations.filter(item=>item.complete&&schemaMatches(item)&&nearby(item.alias,target.value)&&
      item.columns.some(c=>same(c.name,columnName))).map(item=>item.alias));
  }else if(issue.code==='sql.name.ambiguous'){
    if(left)return [];
    for(const relation of relations.filter(column))possible.add(quote(relation.alias)+'.'+quote(target.value));
  }else{
    const candidates=left?relations.filter(item=>same(item.alias,left)):relations;
    if(candidates.length!==1)return [];
    offerSole(candidates[0].columns.map(item=>item.name)
      .filter(name=>name!==target.value&&nearby(name,target.value)));
  }
  return [...possible].slice(0,24).flatMap(replacement=>{
    const after=source.slice(0,issue.start)+replacement+source.slice(issue.end);
    const verified=analyzeSql(after,catalog,options);
    if(verified.state!=='known'||verified.diagnostics.some(item=>knownCodes.has(item.code)))return [];
    return [{start:part.start+issue.start,end:part.start+issue.end,replacement,code:issue.code}];
  });
}

function missingObjectIntent(text,offset,catalog) {
  if (!catalog?.database || catalog.coverage?.tables !== 'loaded' || catalog.coverage?.columns !== 'loaded') return null;
  const options = { dialect: catalog.dialect, database: catalog.database, catalogComplete: true,
    sqlMode: catalog.sqlMode, tableNameCaseSensitive: catalog.tableNameCaseSensitive };
  const split = statementRanges(text, options);
  const part = split.statements.find(item => offset >= item.start && offset < item.end);
  if (!part || split.unknown.length) return null;
  const source = text.slice(part.start, part.end), model = analyzeSql(source, catalog, options);
  if (model.scopes.length !== 1 || model.scopes[0].partial || model.relations.some(item => item.kind !== 'catalog')) return null;
  const issue = model.diagnostics.find(item => ['sql.name.table', 'sql.name.column'].includes(item.code) &&
    offset >= part.start + item.start && offset < part.start + item.end);
  if (!issue) return null;
  let tokens;
  try { tokens = tokenize(source, false, options); } catch { return null; }
  if (tokens[0]?.upper !== 'SELECT') return null;
  const at = tokens.findIndex(item => item.start === issue.start && item.end === issue.end), target = tokens[at];
  if (!id(target) || !target.value || target.value.length > 64 || /^__rb_/i.test(target.value)) return null;
  const qualifier = tokens[at - 1]?.value === '.' && id(tokens[at - 2]) ? tokens[at - 2].value : null;
  if (issue.code === 'sql.name.table') {
    const before = tokens[at - (qualifier ? 3 : 1)];
    const matchesSchema = catalog.tableNameCaseSensitive ? qualifier === catalog.database : same(qualifier, catalog.database);
    if (!['FROM', 'JOIN'].includes(before?.upper) || qualifier && !matchesSchema) return null;
    return { missingTable: target.value, title: 'Design Unresolved Table ' + quote(target.value) };
  }
  const relations = model.scopes[0].relations;
  const choices = qualifier ? relations.filter(item => same(item.alias, qualifier)) : relations;
  if (choices.length !== 1 || choices[0].catalog?.database !== catalog.database) return null;
  const table = choices[0].catalog.table;
  if (!catalog.tables.some(item => item.name === table)) return null;
  return { table, missingColumn: target.value, title: 'Design Column ' + quote(target.value) + ' on ' + quote(table) };
}

module.exports={sqlQuickFixes,missingObjectIntent};
