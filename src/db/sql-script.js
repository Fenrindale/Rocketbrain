'use strict';

const crypto=require('node:crypto');
const {validateQuery,tokenize}=require('./sql-policy');
const {delimiterDirective,compoundCreation}=require('./sql-format-script');
const {transactionControl,reviewTransactionBlock}=require('./sql-script-transaction');
const LIMITS={sqlBytes:128*1024,statements:100,parameters:2000,parameterNames:1000,parameterBytes:1024*1024,parameterValueBytes:128*1024,reviewLifetimeMs:120000,reviews:16,resultBytes:4*1024*1024,totalTimeoutMs:120000};
const fail=(code,message,extra={})=>Object.assign(new Error(message),{code,...extra});
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
function normalizeMode(value){
  if(!Array.isArray(value)||value.length>100||value.some(mode=>typeof mode!=='string'||!/^[A-Z0-9_]+$/.test(mode)))throw fail('ROCKETBRAIN_SCRIPT_CONTEXT','An observed server SQL mode is required.');
  const modes=[...new Set(value)].sort();
  if(modes.some(mode=>['ORACLE','MSSQL','POSTGRESQL','DB2','MAXDB','EMPTY_STRING_IS_NULL'].includes(mode)))throw fail('ROCKETBRAIN_SCRIPT_CONTEXT','This SQL mode changes lexical or parameter semantics outside the supported script subset.');
  return modes;
}

const unsupportedProgramWords = new Set([
  'CALL', 'PREPARE', 'EXECUTE', 'DEALLOCATE', 'CREATE', 'ALTER', 'DROP', 'TRUNCATE',
  'LOAD', 'LOAD_FILE', 'OUTFILE', 'DUMPFILE', 'GRANT', 'REVOKE', 'INSTALL', 'UNINSTALL',
  'GET_LOCK', 'RELEASE_LOCK', 'RELEASE_ALL_LOCKS', 'MASTER_POS_WAIT', 'SOURCE_POS_WAIT',
  'WAIT_FOR_EXECUTED_GTID_SET', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'TRANSACTION', 'AUTOCOMMIT', 'SQL_MODE', 'GLOBAL'
]);

function programPolicy(sql, sqlMode, readOnly) {
  let program;
  try { program = compoundCreation(sql, { sqlMode, dialect: 'mysql' }); }
  catch (error) { throw fail('ROCKETBRAIN_SCRIPT_UNSUPPORTED', error.message); }
  if (!program) throw fail('ROCKETBRAIN_SCRIPT_UNSUPPORTED',
    'A custom DELIMITER is supported for compound CREATE PROCEDURE, FUNCTION and TRIGGER statements.');
  if (readOnly) throw fail('ROCKETBRAIN_READ_ONLY', 'Enable read/write mode before reviewing a stored-program creation.');
  for (let index = 1; index < program.tokens.length; index++) {
    const token = program.tokens[index];
    const label = token.kind === 'symbol' && token.value === ':' &&
      ['identifier','word'].includes(program.tokens[index - 1]?.kind) &&
      ['BEGIN','LOOP','WHILE','REPEAT'].includes(program.tokens[index + 1]?.upper);
    if (token.kind === 'parameter' || token.kind === 'symbol' && token.value === ':' && !label ||
        ['word', 'identifier'].includes(token.kind) && unsupportedProgramWords.has(token.value.toUpperCase())) {
      throw fail('ROCKETBRAIN_SCRIPT_UNSUPPORTED',
        'This stored-program creation includes unsupported parameters, dynamic SQL, session controls or administrative operations.');
    }
  }
  return { sql, first: 'CREATE', mayWrite: true, ddl: true, program: program.type };
}

function scriptCall(sql, sqlMode) {
  const tokens=tokenize(sql,false,{sqlMode});
  if(tokens[0]?.kind!=='word'||tokens[0].upper!=='CALL')return null;
  const invalid=()=>fail('ROCKETBRAIN_SCRIPT_CALL','Use CALL procedure(?, ...) with typed input bindings in the current schema.');
  const name=token=>['word','identifier'].includes(token?.kind)&&/^[A-Za-z_][A-Za-z0-9_$]{0,63}$/.test(token.value);
  const symbol=(token,value)=>token?.kind==='symbol'&&token.value===value;
  let index=1,schema;
  if(!name(tokens[index]))throw invalid();
  let procedure=tokens[index++].value;
  if(symbol(tokens[index],'.')){
    schema=procedure;
    index++;
    if(!name(tokens[index]))throw invalid();
    procedure=tokens[index++].value;
  }
  if(!symbol(tokens[index++],'('))throw invalid();
  let inputs=0;
  if(!symbol(tokens[index],')')){
    while(true){
      if(!symbol(tokens[index++],'?')||++inputs>32)throw invalid();
      if(!symbol(tokens[index],','))break;
      index++;
    }
  }
  if(!symbol(tokens[index++],')')||index!==tokens.length)throw invalid();
  return {first:'CALL',mayWrite:false,ddl:false,call:{...(schema&&{schema}),procedure,inputs}};
}

/** A client script splitter, not a complete SQL parser. Every part is also policy checked. */
function analyzeScript(sql,{sqlMode,readOnly=true,allowCalls=false,allowTransactions=false}={}){
  const modes=normalizeMode(sqlMode),backslash=!modes.includes('NO_BACKSLASH_ESCAPES'),ansi=modes.includes('ANSI_QUOTES');
  if(typeof sql!=='string'||!sql.trim()||sql.includes('\0')||Buffer.byteLength(sql)>LIMITS.sqlBytes)throw fail('ROCKETBRAIN_SCRIPT_INPUT','Enter a script of at most128KiB without NUL.');
  const statements=[],parameters=[];let start=0,hasCode=false,quote='',quoteStart=0,lineComment=false,blockComment=false,blockStart=0;
  let delimiter = ';', delimiterCount = 0;
  const finish=(end,nextStart=end)=>{
    if(hasCode){
      if(statements.length>=LIMITS.statements)throw fail('ROCKETBRAIN_SCRIPT_LIMIT','Scripts are limited to100 statements.');
      const source=sql.slice(start,end);let policySql=source;
      for(const parameter of parameters.filter(p=>p.start>=start&&p.end<=end).reverse())policySql=policySql.slice(0,parameter.start-start)+'?'+policySql.slice(parameter.end-start);
      const policy=delimiter === ';'
        ? (allowTransactions && transactionControl(policySql,modes)) ||
          (allowCalls && scriptCall(policySql,modes)) || validateQuery(policySql,{readOnly,sqlMode:modes})
        : programPolicy(policySql,modes,readOnly);
      statements.push({...policy,index:statements.length,start,end,sql:source});
    }
    start=nextStart;hasCode=false;
  };
  for(let i=0;i<sql.length;i++){
    const c=sql[i],next=sql[i+1];
    if(lineComment){if(c==='\n'||c==='\r')lineComment=false;continue;}
    if(blockComment){if(c==='*'&&next==='/'){blockComment=false;i++;}continue;}
    if(quote){
      const isString=quote==="'"||quote==='"'&&!ansi;
      if(c==='\\'){if(!isString)throw fail('ROCKETBRAIN_SCRIPT_QUOTE','Backslashes in quoted identifiers are not supported; use doubled identifier quotes.');if(backslash){i++;continue;}}
      if(c===quote){if(next===quote){i++;continue;}quote='';}
      continue;
    }
    if (i === 0 || sql[i - 1] === '\n') {
      const newline = sql.indexOf('\n', i);
      const end = newline < 0 ? sql.length : newline;
      let nextDelimiter;
      try { nextDelimiter = delimiterDirective(sql.slice(i, end)); }
      catch (error) { throw fail('ROCKETBRAIN_SCRIPT_UNSUPPORTED', error.message, { offset: i }); }
      if (nextDelimiter) {
        if (hasCode) throw fail('ROCKETBRAIN_SCRIPT_UNSUPPORTED',
          'Finish the current SQL statement before changing its DELIMITER.', { offset: i });
        if (++delimiterCount > LIMITS.statements) throw fail('ROCKETBRAIN_SCRIPT_LIMIT', 'Use at most 100 DELIMITER directives.');
        delimiter = nextDelimiter;
        start = Math.min(end + 1, sql.length);
        i = start - 1;
        continue;
      }
    }
    if(c==='#'||c==='-'&&next==='-'&&/\s/.test(sql[i+2]||' ')){lineComment=true;if(c==='-')i++;continue;}
    if(c==='/'&&next==='*'){if(/^\/\*(?:!|[mM]!)/.test(sql.slice(i)))throw fail('ROCKETBRAIN_SCRIPT_UNSUPPORTED','Executable SQL comments are not supported.');blockComment=true;blockStart=i;i++;continue;}
    if(c==="'"||c==='"'||c==='`'){quote=c;quoteStart=i;hasCode=true;continue;}
    if (sql.startsWith(delimiter, i)) {
      const after = i + delimiter.length;
      finish(delimiter === ';' ? after : i, after);
      i = after - 1;
      continue;
    }
    if(!/\s|\uFEFF/.test(c))hasCode=true;
    if (delimiter !== ';') continue;
    if(c==='?'){
      if(next==='?')throw fail('ROCKETBRAIN_SCRIPT_PARAMETER','Identifier placeholders (??) are not supported. Bind values only.');
      parameters.push({style:'positional',start:i,end:i+1});
    }else if(c===':'&&next===':')throw fail('ROCKETBRAIN_SCRIPT_PARAMETER','Double-colon syntax is not supported by this MySQL/MariaDB script subset.');
    else if(c===':'&&/[A-Za-z_]/.test(next||'')){
      let end=i+2;while(end<sql.length&&/[A-Za-z0-9_]/.test(sql[end]))end++;
      parameters.push({style:'named',name:sql.slice(i+1,end),start:i,end});i=end-1;
    }
    if(parameters.length>LIMITS.parameters)throw fail('ROCKETBRAIN_SCRIPT_LIMIT','Scripts are limited to2000 bound parameter occurrences.');
  }
  if(quote)throw fail('ROCKETBRAIN_SCRIPT_QUOTE','A SQL quote is not closed.',{offset:quoteStart});
  if(blockComment)throw fail('ROCKETBRAIN_SCRIPT_QUOTE','A SQL block comment is not closed.',{offset:blockStart});
  if (hasCode && delimiter !== ';') throw fail('ROCKETBRAIN_SCRIPT_UNSUPPORTED', 'Terminate the stored-program statement with the current DELIMITER.');
  finish(sql.length);if(!statements.length)throw fail('ROCKETBRAIN_SCRIPT_INPUT','The script contains no statements.');
  const styles=new Set(parameters.map(parameter=>parameter.style));if(styles.size>1)throw fail('ROCKETBRAIN_SCRIPT_PARAMETER','Use either named or positional parameters in one script, not both.');
  const parameterStyle=styles.values().next().value||'none',definitions=new Map();let index=0;
  for(const parameter of parameters){parameter.key=parameterStyle==='named'?parameter.name:String(++index);if(!definitions.has(parameter.key))definitions.set(parameter.key,parameterStyle==='named'?{key:parameter.key,kind:'named',name:parameter.name,occurrences:0}:{key:parameter.key,kind:'positional',index:index-1,occurrences:0});definitions.get(parameter.key).occurrences++;}
  if(definitions.size>LIMITS.parameterNames)throw fail('ROCKETBRAIN_SCRIPT_LIMIT','Scripts are limited to1000 distinct parameters.');
  const transactionBlock=reviewTransactionBlock(statements,readOnly);
  return {sql,sqlMode:modes,statements,parameters,parameterDefinitions:[...definitions.values()],parameterStyle,
    hasWrites:statements.some(s=>s.mayWrite),requiresImplicitCommitApproval:statements.some(s=>s.ddl),transactionBlock,atomic:false};
}
function plainData(value,label){
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw fail('ROCKETBRAIN_SCRIPT_PARAMETER',label+' must be a plain object.');
  const descriptors=Object.getOwnPropertyDescriptors(value);if(Object.values(descriptors).some(d=>d.get||d.set)||Object.getOwnPropertySymbols(value).length)throw fail('ROCKETBRAIN_SCRIPT_PARAMETER',label+' cannot contain getters, setters or symbol keys.');return descriptors;
}
function typedParameter(input){
  const descriptor=plainData(input,'Each parameter'),keys=Object.keys(descriptor);if(keys.some(key=>!['kind','value'].includes(key))||typeof descriptor.kind?.value!=='string')throw fail('ROCKETBRAIN_SCRIPT_PARAMETER','Each parameter requires only kind and value.');
  const kind=descriptor.kind.value,value=descriptor.value?.value;let bound;
  if(typeof value==='string'&&Buffer.byteLength(value)>(kind==='binary'?LIMITS.parameterValueBytes*2+2:LIMITS.parameterValueBytes))throw fail('ROCKETBRAIN_SCRIPT_LIMIT','A parameter exceeds128KiB.');
  if(kind==='null'){if(value!==undefined&&value!==null)throw fail('ROCKETBRAIN_SCRIPT_PARAMETER','A null parameter cannot also contain a value.');bound=null;}
  else if(kind==='text'){if(typeof value!=='string')throw fail('ROCKETBRAIN_SCRIPT_PARAMETER','Text parameters require a string value.');bound=value;}
  else if(kind==='integer'){if(typeof value!=='string'||! /^-?(?:0|[1-9]\d*)$/.test(value)||value.replace('-','').length>65)throw fail('ROCKETBRAIN_SCRIPT_PARAMETER','Integer parameters require exact base10 text of at most65 digits.');bound=value;}
  else if(kind==='decimal'){if(typeof value!=='string'||! /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)||value.replace(/[-.]/g,'').length>65||(value.split('.')[1]?.length||0)>30)throw fail('ROCKETBRAIN_SCRIPT_PARAMETER','Decimal parameters require exact numeric text (65 digits/30 fractional digits maximum).');bound=value;}
  else if(kind==='number'){if(typeof value!=='number'||!Number.isFinite(value)||Number.isInteger(value)&&!Number.isSafeInteger(value))throw fail('ROCKETBRAIN_SCRIPT_PARAMETER','Number parameters require finite numbers; use integer text for large integers.');bound=value;}
  else if(kind==='boolean'){if(typeof value!=='boolean')throw fail('ROCKETBRAIN_SCRIPT_PARAMETER','Boolean parameters require true or false.');bound=value;}
  else if(kind==='json'){if(typeof value!=='string')throw fail('ROCKETBRAIN_SCRIPT_PARAMETER','JSON parameters require JSON text.');try{JSON.parse(value);}catch{throw fail('ROCKETBRAIN_SCRIPT_PARAMETER','The JSON parameter is invalid.');}bound=value;}
  else if(kind==='binary'){if(typeof value!=='string'||!/^0x(?:[0-9a-fA-F]{2})*$/.test(value))throw fail('ROCKETBRAIN_SCRIPT_PARAMETER','Binary parameters require an even-length 0x hexadecimal string.');bound=Buffer.from(value.slice(2),'hex');}
  else if(kind==='date'){
    if(typeof value!=='string')throw fail('ROCKETBRAIN_SCRIPT_PARAMETER','Date parameters require SQL calendar date/time text.');
    const match=/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?)?$/.exec(value);
    if(!match)throw fail('ROCKETBRAIN_SCRIPT_PARAMETER','Use YYYY-MM-DD or YYYY-MM-DD HH:mm:ss[.fraction] without a time zone.');
    const [year,month,day,hour=0,minute=0,second=0]=match.slice(1,7).map(v=>v===undefined?0:Number(v));const leap=year%4===0&&(year%100!==0||year%400===0),days=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31];
    if(year<1000||month<1||month>12||day<1||day>days[month-1]||hour>23||minute>59||second>59)throw fail('ROCKETBRAIN_SCRIPT_PARAMETER','The SQL calendar date/time is invalid.');bound=value;
  }else throw fail('ROCKETBRAIN_SCRIPT_PARAMETER','Unsupported parameter kind.');
  const bytes=bound===null?0:Buffer.isBuffer(bound)?bound.length:Buffer.byteLength(String(bound));if(bytes>LIMITS.parameterValueBytes)throw fail('ROCKETBRAIN_SCRIPT_LIMIT','A parameter exceeds128KiB.');return {kind,bound,bytes};
}
function bindScript(script,input){
  const bound=new Map();let total=0;
  if(Array.isArray(input)){
    const descriptors=Object.getOwnPropertyDescriptors(input);
    if(Object.getPrototypeOf(input)!==Array.prototype||Object.getOwnPropertySymbols(input).length||Object.entries(descriptors).some(([key,d])=>d.get||d.set||key!=='length'&&(!/^(?:0|[1-9]\d*)$/.test(key)||Number(key)>=input.length)))throw fail('ROCKETBRAIN_SCRIPT_PARAMETER','Parameter arrays must contain only ordinary indexed values.');
  }
  if(script.parameterStyle==='none'){
    if(input!==undefined&&!(Array.isArray(input)&&input.length===0)&&!(input&&typeof input==='object'&&!Array.isArray(input)&&Object.keys(plainData(input,'Parameters')).length===0))throw fail('ROCKETBRAIN_SCRIPT_PARAMETER','This script has no parameters; remove extra parameter values.');
  }else if(script.parameterStyle==='named'){
    const entries=plainData(input,'Named parameters'),names=new Set(script.parameterDefinitions.map(d=>d.key));if(Object.keys(entries).some(name=>!names.has(name))||Object.keys(entries).length!==names.size)throw fail('ROCKETBRAIN_SCRIPT_PARAMETER','Named parameter values must exactly match the script names.');
    for(const definition of script.parameterDefinitions){if(!Object.hasOwn(entries,definition.key))throw fail('ROCKETBRAIN_SCRIPT_PARAMETER','A named parameter is missing.');const typed=typedParameter(entries[definition.key].value);bound.set(definition.key,typed);total+=typed.bytes;}
  }else{
    if(!Array.isArray(input)||input.length!==script.parameterDefinitions.length)throw fail('ROCKETBRAIN_SCRIPT_PARAMETER','Positional parameter values must exactly match the script placeholders.');
    for(const definition of script.parameterDefinitions){const typed=typedParameter(input[definition.index]);bound.set(definition.key,typed);total+=typed.bytes;}
  }
  const occurrenceBytes=script.parameters.reduce((sum,p)=>sum+bound.get(p.key).bytes,0);
  if(total>LIMITS.parameterBytes||occurrenceBytes>LIMITS.parameterBytes)throw fail('ROCKETBRAIN_SCRIPT_LIMIT','Combined bound parameter occurrences exceed1MiB.');
  const statements=script.statements.map(statement=>{
    const placeholders=script.parameters.filter(p=>p.start>=statement.start&&p.end<=statement.end);let sql=statement.sql;
    for(const parameter of [...placeholders].reverse())sql=sql.slice(0,parameter.start-statement.start)+'?'+sql.slice(parameter.end-statement.start);
    return {...statement,preparedSql:sql,values:placeholders.map(parameter=>{const value=bound.get(parameter.key).bound;return Buffer.isBuffer(value)?Buffer.from(value):value;}),
      ...(statement.call && {valueKinds:placeholders.map(parameter=>bound.get(parameter.key).kind)})};
  });
  return {...script,statements,parameterDefinitions:script.parameterDefinitions.map(definition=>({...definition,valueKind:bound.get(definition.key)?.kind}))};
}

function publicScript(script){
  const unboundedDml = script.statements.flatMap(statement => statement.unboundedDml
    ? [{ index:statement.index, command:statement.unboundedDml.command, hasLimit:statement.unboundedDml.hasLimit }] : []);
  return {parameterStyle:script.parameterStyle,parameterDefinitions:structuredClone(script.parameterDefinitions),
    statements:script.statements.map(({index,start,end,sql,first,mayWrite,ddl,program,call,transaction})=>({index,start,end,sql,first,mayWrite,ddl,
      ...(program && {program}),...(call && {call}),...(transaction && {transaction})})),
    statementCount:script.statements.length,hasWrites:script.hasWrites,requiresImplicitCommitApproval:script.requiresImplicitCommitApproval,
    ...(script.transactionBlock && {transactionBlock:script.transactionBlock}),
    unboundedDml,sqlMode:[...script.sqlMode],atomic:false,executedSql:false};
}
module.exports={analyzeScript,bindScript,typedParameter,publicScript,normalizeMode,digest,LIMITS,fail};
