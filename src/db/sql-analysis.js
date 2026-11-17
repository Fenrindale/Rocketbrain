'use strict';

// A bounded SELECT binder. It never sends SQL or loads server/provider code.
const LIMITS={bytes:128*1024,tokens:24000,scopes:256,depth:32,columns:2048};
const CLAUSES=new Set(['FROM','WHERE','GROUP','HAVING','ORDER','LIMIT','WINDOW','INTO','FOR','LOCK','PROCEDURE','QUALIFY']);
const RESERVED=new Set(('SELECT FROM WHERE AS DISTINCT ALL JOIN INNER OUTER LEFT RIGHT CROSS FULL NATURAL LATERAL ON USING GROUP BY HAVING ORDER ASC DESC LIMIT OFFSET UNION INTERSECT EXCEPT WITH RECURSIVE AND OR XOR NOT IS NULL TRUE FALSE UNKNOWN IN EXISTS BETWEEN LIKE REGEXP RLIKE ESCAPE CASE WHEN THEN ELSE END OVER PARTITION ROWS RANGE GROUPS UNBOUNDED PRECEDING FOLLOWING CURRENT ROW ASC DESC COLLATE DIV MOD FOR UPDATE LOCK SHARE MODE SQL_CALC_FOUND_ROWS STRAIGHT_JOIN HIGH_PRIORITY LOW_PRIORITY SQL_SMALL_RESULT SQL_BIG_RESULT SQL_BUFFER_RESULT SQL_NO_CACHE INTO OUTFILE DUMPFILE WINDOW QUALIFY SEPARATOR BOTH LEADING TRAILING FROM RETURNING').split(' '));
const TYPE_WORDS=new Set(('CHAR VARCHAR NCHAR BINARY VARBINARY SIGNED UNSIGNED INTEGER INT DECIMAL NUMERIC FLOAT DOUBLE REAL DATE TIME DATETIME TIMESTAMP JSON YEAR BOOLEAN BOOL').split(' '));
const INTERVAL_UNITS=new Set(('MICROSECOND SECOND MINUTE HOUR DAY WEEK MONTH QUARTER YEAR SECOND_MICROSECOND MINUTE_MICROSECOND MINUTE_SECOND HOUR_MICROSECOND HOUR_SECOND HOUR_MINUTE DAY_MICROSECOND DAY_SECOND DAY_MINUTE DAY_HOUR YEAR_MONTH').split(' '));
const KNOWN_FUNCTIONS=new Set(('COUNT ROW_NUMBER RANK DENSE_RANK LENGTH CHAR_LENGTH CHARACTER_LENGTH LOCATE INSTR LOWER UPPER LCASE UCASE CONCAT CONCAT_WS SUBSTRING SUBSTR TRIM REPLACE SUM AVG MIN MAX ABS COALESCE IFNULL NULLIF GREATEST LEAST CAST CONVERT EXTRACT').split(' '));
RESERVED.add('DISTINCTROW');
const QUOTE=String.fromCharCode(96),quote=name=>QUOTE+name.replaceAll(QUOTE,QUOTE+QUOTE)+QUOTE;
const family=(name,extra={})=>({family:name,...extra});
const UNKNOWN=()=>family('unknown');
function dbType(value){const base=/^[a-z]+/i.exec(value||'')?.[0].toLowerCase();return family(/^(tinyint|smallint|mediumint|int|integer|bigint|year)$/.test(base)?'integer':/^(decimal|numeric)$/.test(base)?'decimal':/^(double|float|real)$/.test(base)?'floating':/^(char|varchar|tinytext|text|mediumtext|longtext|enum|set)$/.test(base)?'string':/^(binary|varbinary|tinyblob|blob|mediumblob|longblob|bit)$/.test(base)?'binary':/^(date|time|datetime|timestamp)$/.test(base)?'temporal':base==='json'?'json':'unknown',{dbType:value});}
function position(text,offset){const before=text.slice(0,offset).split('\n');return {line:before.length-1,character:before.at(-1).length};}
function sourceRange(text,start,end){return {start:position(text,start),end:position(text,end)};}
function lex(text,options,unknown,nonCode){
  const tokens=[];let i=0;
  const modes=Array.isArray(options.sqlMode)?new Set(options.sqlMode.map(x=>String(x).toUpperCase())):null;
  while(i<text.length){const c=text[i];if(/\s|\uFEFF/.test(c)){i++;continue;}
    if(c==='#'||text.startsWith('--',i)&&/\s/.test(text[i+2]||' ')){const end=text.indexOf('\n',i);nonCode.push({start:i,end:end<0?text.length:end});i=end<0?text.length:end+1;continue;}
    if(text.startsWith('/*',i)){const start=i,end=text.indexOf('*/',i+2);nonCode.push({start,end:end<0?text.length:end+2});if(end<0){unknown('Unclosed comment.',start);break;}if(/^\/\*(?:!|[mM]!)/.test(text.slice(i)))unknown('Executable comments require server SQL-mode/version interpretation.',i);i=end+2;continue;}
    const start=i;
    if(c==="'"||c==='"'||c===QUOTE){const identifier=c===QUOTE||c==='"'&&modes?.has('ANSI_QUOTES');if(c==='"'&&!modes)unknown('Double-quoted SQL depends on ANSI_QUOTES; supply the observed sqlMode.',i);let value='',closed=false;i++;
      for(;i<text.length;){if(text[i]===c){if(text[i+1]===c){value+=c;i+=2;continue;}closed=true;i++;break;}if(text[i]==='\\'&&c!==QUOTE){if(!modes)unknown('Backslash escaping depends on NO_BACKSLASH_ESCAPES; supply sqlMode.',i);if(!modes?.has('NO_BACKSLASH_ESCAPES')&&i+1<text.length){value+=text[i+1];i+=2;continue;}}value+=text[i++];}
      if(!closed)unknown('Unclosed quoted token.',start);if(!identifier)nonCode.push({start,end:i});tokens.push({kind:identifier?'identifier':'string',value,start,end:i,quoted:identifier});
    }else if(/[\p{L}_$]/u.test(c)){i++;while(i<text.length&&/[\p{L}\p{N}_$]/u.test(text[i]))i++;const value=text.slice(start,i);tokens.push({kind:'word',value,upper:value.toUpperCase(),start,end:i});}
    else if(/\d/.test(c)||c==='.'&&/\d/.test(text[i+1]||'')){const match=/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(text.slice(i));i+=match[0].length;tokens.push({kind:'number',value:match[0],start,end:i});}
    else if(c==='@'||c==='?'||c===':'){i++;while(i<text.length&&/[\p{L}\p{N}_$.@]/u.test(text[i]))i++;tokens.push({kind:'parameter',value:text.slice(start,i),start,end:i});}
    else{const op=['<=>','->>','!=','<>','>=','<=','||','&&',':=','->','<<','>>'].find(op=>text.startsWith(op,i));i+=op?op.length:1;tokens.push({kind:'symbol',value:op||c,upper:op||c,start,end:i});}
    if(tokens.length>=LIMITS.tokens){unknown('SQL token limit reached.',i);break;}
  }
  const stack=[];for(let n=0;n<tokens.length;n++){if(tokens[n].kind!=='symbol')continue;if(tokens[n].value==='(')stack.push(n);else if(tokens[n].value===')'){const open=stack.pop();if(open===undefined)unknown('Unbalanced closing parenthesis.',tokens[n].start);else{tokens[open].close=n;tokens[n].open=open;}}}for(const n of stack)unknown('Unclosed parenthesis.',tokens[n].start);
  return tokens;
}
function analyzeSql(text,catalog=[],options={}){
  const model={text:typeof text==='string'?text:'',state:'unknown',dialect:options.dialect||'mysql',database:options.database||catalog?.database||null,diagnostics:[],scopes:[],relations:[],references:[],projections:[],coverage:{supported:[],unknown:[]},validityVerified:false,executedSql:false};
  const unknown=(reason,start)=>{if(!model.coverage.unknown.some(v=>v.reason===reason&&v.start===start))model.coverage.unknown.push({reason,...(Number.isInteger(start)?{start}:{})});};
  if(typeof text!=='string'||!text.trim()){unknown('No SQL statement to analyze.');return model;}
  if(text.includes('\0')||Buffer.byteLength(text)>LIMITS.bytes){unknown('SQL input exceeds limits or contains NUL.');return model;}
  if(!['mysql','mariadb'].includes(model.dialect)){unknown('Only MySQL/MariaDB SELECT dialect profiles are supported.');return model;}
  const tables=Array.isArray(catalog)?catalog:[...(catalog?.tables||[]),...(catalog?.views||[])];
  const catalogComplete=options.catalogComplete===true||Boolean(catalog?.coverage?.tables==='loaded'&&catalog?.coverage?.columns==='loaded');
  const nonCode=[];let lexicalUncertainty=false;const token=lex(text,options,(reason,start)=>{lexicalUncertainty=true;unknown(reason,start);},nonCode),supported=new Set(),seenReferences=new Set();
  Object.defineProperty(model,'_nonCode',{value:nonCode,enumerable:false});
  const id=t=>t&&(t.kind==='identifier'||t.kind==='word'&&!RESERVED.has(t.upper));
  const colEq=(a,b)=>String(a).toLowerCase()===String(b).toLowerCase();
  const nameEq=(a,b)=>options.tableNameCaseSensitive===false?colEq(a,b):String(a)===String(b);
  const issue=(code,message,t,severity='error')=>{if(!t)return;if(!model.diagnostics.some(d=>d.code===code&&d.start===t.start))model.diagnostics.push({code,message,severity,start:t.start,end:t.end,range:sourceRange(text,t.start,t.end)});};
  const top=(a,b,action)=>{for(let i=a;i<b;i++){const t=token[i];const result=action(t,i);if(result!==undefined)return result;if(t.kind==='symbol'&&t.value==='('&&t.close!==undefined)i=t.close;}};
  const split=(a,b,value=',')=>{const result=[];let start=a;top(a,b,(t,i)=>{if(t.kind==='word'&&t.upper===value||t.kind==='symbol'&&t.value===value){result.push([start,i]);start=i+1;}});result.push([start,b]);return result;};
  const span=(a,b)=>({start:token[a]?.start??text.length,end:token[b-1]?.end??text.length});
  const ref=(t,kind,name,type,definition,extra={})=>{const key=t.start+':'+kind;if(seenReferences.has(key))return;seenReferences.add(key);model.references.push({start:t.start,end:t.end,range:sourceRange(text,t.start,t.end),kind,name,type,definition,...extra});};
  const findRelation=(scope,name)=>{for(let current=scope;current;current=current.parent){const matches=current.relations.filter(r=>colEq(r.alias,name));if(matches.length)return matches.length===1?matches[0]:null;}return null;};
  const isCompleteScope=scope=>scope&&scope.relations.every(r=>r.complete)&&!scope.partial;
  const resolve=(scope,parts,at,{projectionAlias=false,projectionClause,uncertain=false}={})=>{
    const name=parts.at(-1).value;
    if(parts.length>3){unknown('Column paths with more than database/table/column components are not supported.',at.start);return UNKNOWN();}
    if(parts.length>1){const qualifier=parts.at(-2).value,relation=findRelation(scope,qualifier);if(!relation){if(uncertain||scope.partial||!catalogComplete)unknown('Column qualifier is unresolved in a partial scope.',at.start);else issue('sql.name.qualifier','Unknown relation alias '+qualifier+'.',parts.at(-2));return UNKNOWN();}
      if(parts.length===3&&(relation.kind!=='catalog'||relation.definition||!relation.catalog||!nameEq(parts[0].value,relation.catalog.database))){unknown('The database-qualified column does not prove an unaliased relation in the observed database.',parts[0].start);return UNKNOWN();}
      const columns=relation.columns.filter(c=>colEq(c.name,name));
      ref(parts.at(-2),'relation',qualifier,UNKNOWN(),relation.definition,{relationId:relation.id,scopeId:scope.id,physicalTable:relation.kind==='catalog'&&!relation.definition?relation.catalog:undefined});
      if(columns.length===1){const c=columns[0];ref(at,'column',name,c.type,c.definition,{relationId:relation.id,scopeId:scope.id,catalog:relation.catalog,physicalColumn:c.physicalColumn||c.catalog,renamePhysicalColumn:c.renamePhysicalColumn!==false,correlated:relation.scopeId!==scope.id});supported.add(relation.scopeId===scope.id?'column-binding':'correlated-subquery');return c.type;}
      if(columns.length>1&&!uncertain)issue('sql.name.ambiguous','Column '+name+' is duplicated in '+qualifier+'.',at);
      else if(relation.complete&&!uncertain)issue('sql.name.column','Unknown column '+qualifier+'.'+name+'.',at);else unknown('Column metadata or expression grammar is incomplete for '+qualifier+'.',at.start);return UNKNOWN();
    }
    if(projectionAlias){const matches=scope.projections?.filter(c=>colEq(c.name,name));if(matches?.length===1){ref(at,'projection',name,matches[0].type,matches[0].definition,{scopeId:scope.id,projectionClause,physicalColumn:matches[0].physicalColumn,renamePhysicalColumn:matches[0].renamePhysicalColumn!==false});return matches[0].type;}}
    for(let current=scope;current;current=current.parent){const choices=current.relations.flatMap(r=>r.columns.filter(c=>colEq(c.name,name)).map(c=>({relation:r,column:c})));
      if(choices.length===1&&isCompleteScope(current)){const {relation,column}=choices[0];ref(at,'column',name,column.type,column.definition,{relationId:relation.id,scopeId:scope.id,catalog:relation.catalog,physicalColumn:column.physicalColumn||column.catalog,renamePhysicalColumn:column.renamePhysicalColumn!==false,correlated:current!==scope});supported.add(current===scope?'column-binding':'correlated-subquery');return column.type;}
      if(choices.length>1){if(uncertain||current.partial)unknown('Column ownership is uncertain in an unsupported expression/join.',at.start);else issue('sql.name.ambiguous','Column '+name+' is ambiguous; qualify its relation.',at);return UNKNOWN();}
      if(choices.length===1||!isCompleteScope(current)){unknown('Unqualified column ownership is uncertain in a partial scope.',at.start);return UNKNOWN();}
    }
    if(catalogComplete&&!scope.partial&&!uncertain)issue('sql.name.column','Unknown column '+name+'.',at);else unknown('Column or expression symbol '+name+' is not resolved in the supported grammar/catalog.',at.start);return UNKNOWN();
  };
  const mergeTypes=types=>{const unique=[...new Set(types.map(t=>t.family).filter(f=>f!=='null'))];if(!unique.length)return family('null',{nullable:true});if(unique.length===1)return {...types.find(t=>t.family===unique[0]),nullable:types.some(t=>t.nullable||t.family==='null')};if(unique.every(f=>['integer','decimal','floating'].includes(f)))return family(unique.includes('floating')?'floating':unique.includes('decimal')?'decimal':'integer');unknown('Result type depends on server coercion/collation rules.');return UNKNOWN();};
  let parseQuery;
  function expression(a,b,scope,context={}){
    while(token[a]?.value==='('&&token[a].close===b-1){a++;b--;}
    if(a>=b){unknown('Incomplete SQL expression.',token[a]?.start);return UNKNOWN();}
    if(['SELECT','WITH'].includes(token[a]?.upper)){const sub=parseQuery(a,b,scope,new Map(scope.ctes),scope.depth+1);supported.add('scalar-subquery');if(sub.projections.length!==1){if(sub.complete)issue('sql.shape.scalar','Scalar subquery must return exactly one column.',token[a]);return UNKNOWN();}return {...sub.projections[0].type,nullable:true};}
    // Expressions are traversed for all nested scopes and column references before inference.
    const atoms=[];let operator=false,comparison=false;
    for(let i=a;i<b;i++){const t=token[i];
      if(t.value==='('&&t.close!==undefined&&t.close<b){if(['SELECT','WITH'].includes(token[i+1]?.upper)){const sub=parseQuery(i+1,t.close,scope,new Map(scope.ctes),scope.depth+1);const exists=token[i-1]?.upper==='EXISTS',inList=token[i-1]?.upper==='IN';if(!exists&&sub.projections.length!==1&&sub.complete)issue('sql.shape.scalar',inList?'IN subquery column count is not covered for row operands.':'Scalar subquery must return exactly one column.',t,inList?'information':'error');atoms.push(exists?family('boolean'):sub.projections[0]?.type||UNKNOWN());}else atoms.push(expression(i+1,t.close,scope,context));i=t.close;continue;}
      if(t.kind==='number'){atoms.push(family(/[.eE]/.test(t.value)?'decimal':'integer'));continue;}
      if(t.kind==='string'){atoms.push(family('string'));continue;}
      if(t.kind==='parameter'){unknown('Parameter/session-variable type requires a runtime binding contract.',t.start);atoms.push(UNKNOWN());continue;}
      if(t.upper==='NULL'){atoms.push(family('null',{nullable:true}));continue;}
      if(['TRUE','FALSE'].includes(t.upper)){atoms.push(family('boolean'));continue;}
      if(t.kind==='word'&&['DATE','TIME','TIMESTAMP'].includes(t.upper)&&token[i+1]?.kind==='string'){atoms.push(family('temporal'));i++;continue;}
      if(t.kind==='word'&&['CURRENT_DATE','CURRENT_TIME','CURRENT_TIMESTAMP','LOCALTIME','LOCALTIMESTAMP'].includes(t.upper)&&token[i+1]?.value!=='('){atoms.push(family('temporal'));continue;}
      if(t.kind==='word'&&(t.upper==='INTERVAL'||INTERVAL_UNITS.has(t.upper)&&token.slice(a,i).some(v=>v.upper==='INTERVAL'))){unknown('Interval arithmetic is traversed but SQL-unit coercion is not fully inferred.',t.start);continue;}
      if(t.upper==='COLLATE'){unknown('Collation-dependent expression semantics require observed server validation.',t.start);if(id(token[i+1]))i++;continue;}
      if(t.upper==='BINARY'&&i===a&&a+1<b){unknown('BINARY prefix coercion is outside exact static result typing.',t.start);continue;}
      if(t.upper==='OVER'&&id(token[i+1])){unknown('Named window declarations and frame semantics are not bound.',t.start);i++;continue;}
      if(id(t)){
        if(token[i+1]?.value==='('){const close=token[i+1].close;if(close===undefined||close>=b){unknown('Incomplete function call.',t.start);return UNKNOWN();}const args=split(i+2,close).filter(([x,y])=>x<y);let argTypes=[];
          if(['COUNT','LOWER','UPPER','LCASE','UCASE','LENGTH','CHAR_LENGTH','CHARACTER_LENGTH','SUM','AVG','MIN','MAX','ABS'].includes(t.upper)&&args.length!==1)issue('sql.function.arity',t.value+' requires exactly one argument in this supported form.',t);
          if(t.upper==='EXTRACT'){const from=top(i+2,close,(v,n)=>v.upper==='FROM'?n:undefined);if(from!==undefined){expression(from+1,close,scope,context);atoms.push(family(token[i+2]?.upper==='SECOND'?'decimal':'integer'));}else{unknown('Incomplete EXTRACT form.',t.start);atoms.push(UNKNOWN());}}
          else if(['CAST','CONVERT'].includes(t.upper)){let as=top(i+2,close,(v,n)=>v.upper==='AS'?n:undefined);if(as!==undefined){argTypes=[expression(i+2,as,scope,context)];const target=token[as+1]?.upper;if(TYPE_WORDS.has(target))atoms.push(dbType(target==='SIGNED'||target==='UNSIGNED'?'bigint':target.toLowerCase()));else{unknown('Unsupported CAST target.',t.start);atoms.push(UNKNOWN());}}else{unknown('CONVERT/CAST form is outside the supported subset.',t.start);for(const [x,y]of args)expression(x,y,scope,context);atoms.push(UNKNOWN());}}
          else{argTypes=args.map(([x,y])=>token[x]?.value==='*'&&y===x+1?family('wildcard'):expression(x,y,scope,{...context,uncertain:context.uncertain||!KNOWN_FUNCTIONS.has(t.upper)}));
            if(t.upper==='COUNT')atoms.push(family('integer',{nullable:false}));
            else if(['ROW_NUMBER','RANK','DENSE_RANK','LENGTH','CHAR_LENGTH','CHARACTER_LENGTH','LOCATE','INSTR'].includes(t.upper))atoms.push(family('integer'));
            else if(['LOWER','UPPER','LCASE','UCASE','CONCAT','CONCAT_WS','SUBSTRING','SUBSTR','TRIM','REPLACE'].includes(t.upper))atoms.push(family('string'));
            else if(['SUM','AVG'].includes(t.upper)){const type=argTypes[0];atoms.push(type?.family==='floating'?family('floating'):['integer','decimal'].includes(type?.family)?family('decimal',{nullable:true}):UNKNOWN());if(!['integer','decimal','floating','null'].includes(type?.family))unknown('Aggregate numeric coercion requires provider execution.',t.start);}
            else if(['MIN','MAX','NULLIF'].includes(t.upper))atoms.push({...mergeTypes(argTypes),nullable:true});
            else if(['ABS','COALESCE','IFNULL','GREATEST','LEAST'].includes(t.upper))atoms.push(mergeTypes(argTypes));
            else{unknown('Function '+t.value+' has no static return contract.',t.start);atoms.push(UNKNOWN());}
          }supported.add('function-traversal');i=close;continue;
        }
        if(TYPE_WORDS.has(t.upper)&&token[i-1]?.upper==='AS')continue;
        const parts=[t];while(token[i+1]?.value==='.'&&(id(token[i+2])||token[i+2]?.value==='*')){parts.push(token[i+2]);i+=2;}
        if(token[i+1]?.value==='.'&&!id(token[i+2])){unknown('Incomplete qualified column reference.',t.start);i++;atoms.push(UNKNOWN());continue;}
        if(parts.at(-1).value==='*'){const r=findRelation(scope,parts.at(-2)?.value);if(r)ref(parts.at(-2),'relation',parts.at(-2).value,UNKNOWN(),r.definition,{scopeId:scope.id,relationId:r.id,physicalTable:r.kind==='catalog'&&!r.definition?r.catalog:undefined});continue;}
        atoms.push(resolve(scope,parts,parts.at(-1),context));continue;
      }
      if(['=','!=','<>','<','>','>=','<=','<=>','AND','OR','XOR','NOT','IS','IN','EXISTS','BETWEEN','LIKE','REGEXP','RLIKE'].includes(t.upper||t.value))comparison=true;
      else if(t.value==='&&')comparison=true;
      else if(t.value==='||'){unknown('Double-pipe semantics depend on PIPES_AS_CONCAT and provider modes.',t.start);atoms.push(UNKNOWN());}
      else if(['&','|','^','~','<<','>>','->','->>'].includes(t.value)){unknown('Bitwise/JSON operator result and coercion rules are not statically covered.',t.start);atoms.push(UNKNOWN());}
      else if(['+','-','*','/','DIV','MOD','%'].includes(t.upper||t.value))operator=true;
      else if(t.value==='*'&&a+1===b)atoms.push(family('wildcard'));
      else if(['CASE','WHEN','THEN','ELSE','END'].includes(t.upper)){unknown('CASE branch result coercion is not statically complete.',t.start);}
      else if(['OVER','PARTITION','ROWS','RANGE','GROUPS','UNBOUNDED','PRECEDING','FOLLOWING','CURRENT','ROW','WINDOW'].includes(t.upper))unknown('Window specification is traversed but frame semantics are unverified.',t.start);
    }
    if(comparison){supported.add('predicate-traversal');return family('boolean',{nullable:atoms.some(t=>t.nullable)});}
    if(operator){supported.add('numeric-expression');if(atoms.every(t=>['integer','decimal','floating'].includes(t.family)))return family(atoms.some(t=>t.family==='floating')?'floating':token.slice(a,b).some(t=>t.value==='/')?'decimal':atoms.some(t=>t.family==='decimal')?'decimal':'integer');unknown('Arithmetic may use MySQL/MariaDB implicit conversion; no static type error is asserted.',token[a].start);return UNKNOWN();}
    return atoms.length===1?atoms[0]:atoms.length?mergeTypes(atoms):UNKNOWN();
  }
  function relation(scope,a,b,ctes){
    let i=a,lateral=false;if(token[i]?.upper==='LATERAL'){lateral=true;i++;unknown('LATERAL provider/version restrictions are not fully checked.',token[a].start);}
    if(token[i]?.value==='('&&token[i].close!==undefined&&token[i].close<b){const close=token[i].close;if(!['SELECT','WITH'].includes(token[i+1]?.upper)){scope.partial=true;unknown('Parenthesized join/table functions are outside this binder.',token[i].start);return close+1;}
      const sub=parseQuery(i+1,close,lateral?scope:scope.parent,new Map(ctes),scope.depth+1);let next=close+1;if(token[next]?.upper==='AS')next++;const alias=id(token[next])?token[next]:null;if(alias)next++;else{scope.partial=true;unknown('Derived table alias is incomplete.',token[close].start);}
      const r={id:'relation-'+model.relations.length,scopeId:scope.id,kind:'derived',name:alias?.value||'(derived)',alias:alias?.value||'',columns:sub.projections,complete:sub.complete,definition:alias?{start:alias.start,end:alias.end}:span(i,close+1),start:token[a].start,end:token[next-1]?.end};scope.relations.push(r);model.relations.push(r);if(alias)ref(alias,'relation-definition',alias.value,UNKNOWN(),r.definition,{relationId:r.id,scopeId:scope.id});supported.add('derived-table');return next;
    }
    if(!id(token[i])){scope.partial=true;unknown('FROM relation is not a supported table/derived form.',token[i]?.start);return i+1;}
    const first=token[i],parts=[first];i++;while(token[i]?.value==='.'&&id(token[i+1])){parts.push(token[i+1]);i+=2;}
    if(token[i]?.value==='('){scope.partial=true;unknown('Table-valued functions are outside the supported subset.',first.start);return token[i].close!==undefined?token[i].close+1:i+1;}
    const name=parts.at(-1).value,db=parts.length>1?parts.at(-2).value:null;let aliasToken;if(token[i]?.upper==='AS'){i++;if(id(token[i]))aliasToken=token[i++];}else if(id(token[i])&&!['USE','FORCE','IGNORE','PARTITION'].includes(token[i].upper))aliasToken=token[i++];
    const cte=!db?ctes.get(name.toLowerCase()):null;let table,columns=[],complete=false,definition=cte?.definition;
    if(cte){columns=cte.columns;complete=cte.complete;supported.add('cte-reference');}
    else if(db&&model.database&& !nameEq(db,model.database)){unknown('Cross-database metadata is unavailable for '+db+'.'+name+'.',first.start);}
    else{const matches=tables.filter(t=>nameEq(t.name,name));if(matches.length===1){table=matches[0];columns=(table.columns||[]).slice(0,LIMITS.columns).map(c=>({name:c.name,type:{...dbType(c.type),nullable:c.nullable},catalog:{database:db||model.database,table:table.name,column:c.name}}));complete=catalogComplete&&table.columns?.length<=LIMITS.columns;}else if(matches.length>1)unknown('Catalog table name is ambiguous.',first.start);else if(catalogComplete)issue('sql.name.table','Table '+(db?db+'.':'')+name+' is not in the visible catalog.',parts.at(-1),'warning');else unknown('Table '+name+' is not in the available partial catalog.',first.start);}
    const r={id:'relation-'+model.relations.length,scopeId:scope.id,kind:cte?'cte':'catalog',name,alias:aliasToken?.value||name,columns,complete,definition:aliasToken?{start:aliasToken.start,end:aliasToken.end}:definition,start:first.start,end:token[i-1].end,catalog:table?{database:db||model.database,table:table.name}:undefined};
    if(scope.relations.some(existing=>colEq(existing.alias,r.alias)))issue('sql.name.alias.duplicate','Relation alias '+r.alias+' is duplicated in this query block.',aliasToken||parts.at(-1));
    scope.relations.push(r);model.relations.push(r);ref(parts.at(-1),'table',name,UNKNOWN(),definition,{relationId:r.id,scopeId:scope.id,catalog:r.catalog});if(aliasToken)ref(aliasToken,'relation-definition',aliasToken.value,UNKNOWN(),r.definition,{relationId:r.id,scopeId:scope.id});supported.add('table-binding');return i;
  }
  function from(scope,a,b,ctes){let i=a,expect=true;while(i<b){const t=token[i];if(expect){i=relation(scope,i,b,ctes);expect=false;continue;}if(t.value===','||['JOIN','STRAIGHT_JOIN'].includes(t.upper)){expect=true;i++;continue;}if(['LEFT','RIGHT','INNER','OUTER','CROSS'].includes(t.upper)){i++;continue;}if(t.upper==='NATURAL'||t.upper==='USING'){scope.partial=true;unknown('NATURAL/USING output-column coalescing is not modeled.',t.start);if(token[i+1]?.value==='('&&token[i+1].close!==undefined)i=token[i+1].close+1;else i++;continue;}if(t.upper==='ON'){const start=++i;for(;i<b;i++){if(token[i].value==='('&&token[i].close!==undefined)i=token[i].close;else if(token[i].value===','||['JOIN','LEFT','RIGHT','INNER','CROSS','NATURAL','STRAIGHT_JOIN'].includes(token[i].upper))break;}scope.predicates.push([start,i]);continue;}scope.partial=true;unknown('Unsupported FROM modifier '+t.value+'.',t.start);i++;}}
  function select(a,b,parent,ctes,depth){
    const scope={id:'scope-'+model.scopes.length,start:token[a]?.start??0,end:token[b-1]?.end??text.length,parent,parentId:parent?.id||null,depth,ctes,relations:[],projections:[],predicates:[],partial:false};model.scopes.push(scope);
    if(token[a]?.upper!=='SELECT'){scope.partial=true;unknown('Only SELECT query blocks are bound.',token[a]?.start);return scope;}
    let projectionStart=a+1;while(['DISTINCT','DISTINCTROW','ALL'].includes(token[projectionStart]?.upper))projectionStart++;
    const clauses=[];top(projectionStart,b,(t,i)=>{if(CLAUSES.has(t.upper))clauses.push({kind:t.upper,start:i});});
    const fromClause=clauses.find(c=>c.kind==='FROM');if(fromClause){const end=clauses.find(c=>c.start>fromClause.start)?.start??b;from(scope,fromClause.start+1,end,ctes);}
    const projectionEnd=clauses[0]?.start??b;
    for(const [x,y]of split(projectionStart,projectionEnd)){
      if(x>=y){unknown('Incomplete projection.',token[x]?.start);continue;}let end=y,alias=null;const as=top(x,y,(t,i)=>t.upper==='AS'?i:undefined);
      const previous=token[y-2],canEnd=previous&&(previous.kind==='symbol'?previous.value===')':previous.kind==='word'?!RESERVED.has(previous.upper)&&previous.upper!=='BINARY':['identifier','number','string'].includes(previous.kind));
      if(as!==undefined&&id(token[as+1])&&as+2===y){alias=token[as+1];end=as;}else if(y-x>1&&id(token[y-1])&&canEnd){alias=token[y-1];end=y-1;}
      const star=end-x===1&&token[x].kind==='symbol'&&token[x].value==='*',qualifiedStar=end-x===3&&id(token[x])&&token[x+1].value==='.'&&token[x+2].kind==='symbol'&&token[x+2].value==='*';
      if(star||qualifiedStar){const source=qualifiedStar?scope.relations.filter(r=>colEq(r.alias,token[x].value)):scope.relations;if(!source.length||source.some(r=>!r.complete)||scope.partial)unknown('Wildcard output is incomplete in this scope.',token[x].start);for(const r of source)scope.projections.push(...r.columns.map(c=>({...c,physicalColumn:c.physicalColumn||c.catalog})));if(qualifiedStar)ref(token[x],'relation',token[x].value,UNKNOWN(),source[0]?.definition,{scopeId:scope.id,relationId:source[0]?.id,physicalTable:source[0]?.kind==='catalog'&&!source[0]?.definition?source[0]?.catalog:undefined});ref(token[end-1],'wildcard','*',UNKNOWN(),undefined,{scopeId:scope.id,physicalColumns:source.flatMap(r=>r.columns.map(c=>c.physicalColumn||c.catalog).filter(Boolean))});supported.add('wildcard-expansion');continue;}
      const type=expression(x,end,scope),last=token[end-1],simple=token.slice(x,end).every((t,index)=>index%2===0?id(t):t.value==='.');const name=alias?.value||(simple?last.value:text.slice(token[x].start,last.end));let definition=alias?{start:alias.start,end:alias.end}:simple?model.references.find(r=>r.start===last.start&&r.kind==='column')?.definition:undefined;
      const sourceRef=simple?model.references.find(r=>r.start===last.start&&r.kind==='column'):undefined,physicalColumn=sourceRef?.physicalColumn,renamePhysicalColumn=!alias&&sourceRef?.renamePhysicalColumn!==false;
      if(!definition){definition={start:last.end,end:last.end};ref({start:last.end,end:last.end},'implicit-projection-definition',name,type,definition,{scopeId:scope.id,implicit:true,physicalColumn,renamePhysicalColumn});}
      scope.projections.push({name,type,definition,...span(x,y),physicalColumn,renamePhysicalColumn});if(alias)ref(alias,'projection-definition',name,type,{start:alias.start,end:alias.end},{scopeId:scope.id,physicalColumn,renamePhysicalColumn:false});
    }
    for(const [x,y]of scope.predicates)expression(x,y,scope);
    for(let n=0;n<clauses.length;n++){const c=clauses[n],end=clauses[n+1]?.start??b;if(c.kind==='FROM')continue;if(['WHERE','HAVING'].includes(c.kind))expression(c.start+1,end,scope,{projectionAlias:c.kind==='HAVING',projectionClause:c.kind});else if(['GROUP','ORDER'].includes(c.kind)){const start=token[c.start+1]?.upper==='BY'?c.start+2:c.start+1;for(const [x,y]of split(start,end))expression(x,y,scope,{projectionAlias:true,projectionClause:c.kind});}else if(c.kind!=='LIMIT')unknown('Clause '+c.kind+' is outside complete static checking.',token[c.start].start);}
    scope.complete=!scope.partial&&scope.relations.every(r=>r.complete)&&scope.projections.every(p=>p.type.family!=='unknown');supported.add('select-projection');return scope;
  }
  parseQuery=(a,b,parent,ctes,depth=0)=>{
    if(depth>LIMITS.depth||model.scopes.length>=LIMITS.scopes){unknown('SQL scope/depth limit reached.',token[a]?.start);return {projections:[],complete:false};}
    while(token[a]?.value==='('&&token[a].close===b-1){a++;b--;}
    if(token[a]?.upper==='WITH'){
      const cteGroup=token[a].start,localCtes=new Set();let i=a+1,recursive=false;if(token[i]?.upper==='RECURSIVE'){recursive=true;i++;}ctes=new Map(ctes);
      while(i<b&&id(token[i])){const name=token[i++],labels=[];if(token[i]?.value==='('){const close=token[i].close;if(close===undefined)break;for(const [x,y]of split(i+1,close))if(y===x+1&&id(token[x]))labels.push(token[x]);else unknown('CTE column list is incomplete.',token[x]?.start);i=close+1;}
        if(token[i]?.upper!=='AS'||token[i+1]?.value!=='('||token[i+1].close===undefined){unknown('Incomplete CTE declaration.',name.start);break;}const open=i+1,close=token[open].close,entry={name:name.value,definition:{start:name.start,end:name.end},columns:[],complete:false};
        if(recursive){const union=top(open+1,close,(t,n)=>t.upper==='UNION'?n:undefined);if(union!==undefined){const anchor=parseQuery(open+1,union,parent,new Map(ctes),depth+1);entry.columns=anchor.projections.map((c,index)=>({...c,...(labels[index]?{name:labels[index].value,definition:{start:labels[index].start,end:labels[index].end},renamePhysicalColumn:false}:{})}));entry.complete=anchor.complete;ctes.set(name.value.toLowerCase(),entry);}else ctes.set(name.value.toLowerCase(),entry);}
        const sub=parseQuery(open+1,close,parent,new Map(ctes),depth+1);if(!entry.columns.length)entry.columns=sub.projections;entry.columns=entry.columns.map((c,index)=>({...c,...(labels[index]?{name:labels[index].value,definition:{start:labels[index].start,end:labels[index].end},renamePhysicalColumn:false}:{})}));if(labels.length&&labels.length!==entry.columns.length)issue('sql.shape.cte','CTE declared column count differs from its query output.',name);entry.complete=recursive?entry.complete:sub.complete;
        if(localCtes.has(name.value.toLowerCase()))issue('sql.name.cte.duplicate','CTE '+name.value+' is duplicated in this WITH clause.',name);localCtes.add(name.value.toLowerCase());
        ctes.set(name.value.toLowerCase(),entry);ref(name,'cte-definition',name.value,UNKNOWN(),entry.definition,{cteGroup});
        for(let index=0;index<labels.length;index++)ref(labels[index],'cte-column-definition',labels[index].value,entry.columns[index]?.type||UNKNOWN(),{start:labels[index].start,end:labels[index].end},{ownerDefinition:entry.definition,cteGroup});
        if(recursive)unknown('Recursive CTE anchor columns are bound; growth, truncation and recursive restrictions require server validation.',name.start);supported.add(recursive?'recursive-cte-anchor':'cte');i=close+1;if(token[i]?.value!==',')break;i++;
      }a=i;
    }
    const arms=[];let start=a;top(a,b,(t,i)=>{if(['UNION','INTERSECT','EXCEPT'].includes(t.upper)){arms.push([start,i]);start=i+1;if(['ALL','DISTINCT'].includes(token[start]?.upper))start++;if(t.upper!=='UNION')unknown(t.upper+' dialect/version semantics are not verified.',t.start);}});arms.push([start,b]);
    let globalClauses=[];if(arms.length>1){const last=arms.at(-1);top(last[0],last[1],(t,i)=>{if(['ORDER','LIMIT'].includes(t.upper))globalClauses.push({kind:t.upper,start:i});});if(globalClauses.length)last[1]=globalClauses[0].start;}
    const scopes=arms.map(([x,y])=>select(x,y,parent,ctes,depth));const main=scopes[0]||{projections:[],complete:false};if(scopes.length>1){for(const s of scopes.slice(1)){if(main.projections.length!==s.projections.length&&main.complete&&s.complete)issue('sql.shape.union','Set-operation branches return different column counts.',token[arms[scopes.indexOf(s)][0]]);}main.projections=main.projections.map((p,index)=>({...p,type:mergeTypes(scopes.map(s=>s.projections[index]?.type||UNKNOWN()))}));main.complete=scopes.every(s=>s.complete)&&main.projections.every(p=>p.type.family!=='unknown');supported.add('union-output');for(let n=0;n<globalClauses.length;n++){const c=globalClauses[n];if(c.kind==='ORDER')for(const [x,y]of split(c.start+(token[c.start+1]?.upper==='BY'?2:1),globalClauses[n+1]?.start??b))expression(x,y,main,{projectionAlias:true,projectionClause:'ORDER'});}}return main;
  };
  let end=token.length;const semicolons=token.flatMap((t,i)=>t.kind==='symbol'&&t.value===';'?[i]:[]);if(semicolons.length){end=semicolons[0];if(semicolons.length>1||end!==token.length-1)unknown('Analyze one statement at a time; batch SQL is not bound.');}
  if(!['SELECT','WITH'].includes(token[0]?.upper)){unknown('Only SELECT/WITH statements have a static semantic model.');return model;}
  try{const root=parseQuery(0,end,null,new Map(),0);model.projections=root.projections;if(!root.complete)unknown('The selected query block has unresolved names, types or output structure.');}catch{unknown('The statement is outside the bounded parser or incomplete.');}
  if(lexicalUncertainty)model.diagnostics=model.diagnostics.map(issue=>({...issue,severity:'information',message:issue.message+' Tokenization is uncertain; verify the SQL mode or complete the statement.'}));
  model.coverage.supported=[...supported];model.state=lexicalUncertainty?'unknown':model.diagnostics.some(d=>d.severity==='error')?'invalid':model.coverage.unknown.length?'unknown':'known';
  // Parent pointers/maps are internal lookup state; keep snapshots serializable.
  model._scopes=model.scopes;model.scopes=model._scopes.map(({parent,ctes,projections,predicates,...scope})=>({...scope,projections}));
  Object.defineProperty(model,'_scopes',{value:model._scopes,enumerable:false});return model;
}
function scopeAt(model,offset){return (model._scopes||[]).filter(s=>offset>=s.start&&offset<=s.end).sort((a,b)=>b.depth-a.depth||(a.end-a.start)-(b.end-b.start))[0];}
function completionsAt(model,offset){if(model._nonCode?.some(span=>offset>=span.start&&offset<span.end))return[];const before=model.text.slice(0,offset),match=/(?:([\p{L}_$][\p{L}\p{N}_$]*)\.)?([\p{L}\p{N}_$]*)$/u.exec(before);if(!match)return[];const scope=scopeAt(model,offset);if(!scope)return[];const qualifier=match[1],prefix=match[2].toLowerCase(),relations=[];for(let s=scope;s;s=s.parent){for(const r of s.relations)if(!relations.some(v=>colEqLocal(v.alias,r.alias)))relations.push(r);}
  let selected=qualifier?relations.filter(r=>colEqLocal(r.alias,qualifier)):relations;const result=[];if(!qualifier){for(const [name,cte]of scope.ctes)if(name.startsWith(prefix))result.push({label:cte.name,kind:'table',detail:'CTE · local query',insertText:quote(cte.name)});}
  for(const r of selected)for(const c of r.columns)if(c.name.toLowerCase().startsWith(prefix))result.push({label:c.name,kind:'column',detail:r.alias+' · '+(c.type.dbType||c.type.family)+' · '+r.kind,insertText:quote(c.name),table:r.name,type:c.type});return result;
}
const colEqLocal=(a,b)=>String(a).toLowerCase()===String(b).toLowerCase();
function definitionsAt(model,offset){const ref=model.references.find(r=>offset>=r.start&&offset<=r.end&&r.definition);return ref?[{...ref.definition,range:sourceRange(model.text,ref.definition.start,ref.definition.end)}]:[];}
function hoverAt(model,offset){const ref=model.references.find(r=>offset>=r.start&&offset<=r.end);if(!ref)return null;return [ref.kind+': '+ref.name,ref.type?.dbType||ref.type?.family,ref.catalog?JSON.stringify(ref.catalog):null,ref.correlated?'Correlated outer-scope reference':null,'Static SELECT model; execution validity is unverified.'].filter(Boolean).join('\n');}
function statementRanges(text,options={}){
  const unknown=[],statements=[];if(typeof text!=='string'||Buffer.byteLength(text)>LIMITS.bytes||text.includes('\0'))return {statements,unknown:[{reason:'SQL document exceeds limits or contains NUL.'}]};
  const tokens=lex(text,options,(reason,start)=>unknown.push({reason,start}),[]);let start=0;
  for(const t of tokens)if(t.kind==='symbol'&&t.value===';'){if(text.slice(start,t.end).trim())statements.push({start,end:t.end});start=t.end;}
  if(text.slice(start).trim())statements.push({start,end:text.length});return {statements,unknown};
}
module.exports={analyzeSql,completionsAt,definitionsAt,hoverAt,statementRanges,dbType,sourceRange,LIMITS};
