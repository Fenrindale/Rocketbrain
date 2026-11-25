'use strict';

const { observeProcedure }=require('./routine-call');
const { shownBody }=require('./schema-programs');
const { parseProgram,walk }=require('./schema-trigger-ast');
const { sourceTokens }=require('./sql-analysis');
const { fail }=require('./sql-script');

const invalid=message=>fail('ROCKETBRAIN_SCRIPT_CALL',message);

function withoutProjectionAliases(body,sqlMode) {
  const tokens=sourceTokens(body,{sqlMode:sqlMode.split(',').filter(Boolean)});
  const boundaries=new Set([',',';','FROM','INTO','WHERE']);
  const aliases=[];
  let projection=false;
  for(let index=0;index<tokens.length;index++) {
    const token=tokens[index];
    if(token.close!==undefined){index=token.close;continue;}
    const word=token.kind==='word'?token.upper:token.kind==='symbol'?token.value:'';
    if(word==='SELECT')projection=true;
    if(word!==','&&boundaries.has(word))projection=false;
    if(!projection||word!=='AS')continue;
    const next=tokens[index+1],tail=tokens[index+2];
    if(['word','identifier'].includes(next?.kind)&&(!tail||boundaries.has(tail.upper||tail.value))) {
      aliases.push({start:token.start,end:next.end});
      index++;
    }
  }
  let masked=body;
  for(const {start,end} of aliases.reverse())masked=masked.slice(0,start)+body.slice(start,end).replace(/[^\r\n]/g,' ')+masked.slice(end);
  return masked;
}

async function reviewScriptCall(statement,context,query) {
  const {schema,procedure,inputs,slots=Array(inputs).fill(null)}=statement.call;
  if(schema!==undefined && schema!==context.database)throw invalid('Use a reviewed procedure from the active schema.');
  const observed=await observeProcedure(query,context,{schema:context.database,name:procedure,kind:'procedure'});
  if(observed.parameters.length!==slots.length||observed.parameters.some((parameter,index)=>
    (parameter.mode==='OUT')!==(slots[index]!==null))) {
    throw invalid('Match the complete procedure signature with typed IN or INOUT bindings and explicit @names for OUT.');
  }
  const declaredInputs=observed.parameters.filter(parameter=>parameter.mode!=='OUT');
  if(statement.valueKinds && declaredInputs.some((parameter,index)=>
    statement.valueKinds[index]!=='null' && statement.valueKinds[index]!==parameter.kind)) {
    throw invalid('Script CALL input types must match the procedure signature or use SQL NULL.');
  }
  const sqlMode=observed.settings.sql_mode || '';
  let program;
  try{
    const body=shownBody(observed.source,context.database,procedure,sqlMode);
    program=parseProgram(withoutProjectionAliases(body,sqlMode),context.database,undefined,{kind:'procedure',sqlMode,
      parameters:observed.parameters,allowRows:true,allowDynamic:false});
  }catch{
    throw invalid('Script CALL requires a visible body with supported read-only SELECT or output assignments.');
  }
  const outputs=new Set(observed.parameters.filter(parameter=>parameter.mode!=='IN').map(parameter=>parameter.name.toLowerCase()));
  let selects=0;
  walk(program.statements,node=>{
    if(node.kind==='block')return;
    if(node.kind==='set'&&node.variable&&outputs.has(node.variable.toLowerCase()))return;
    if(node.kind==='select'&&node.into.every(name=>outputs.has(name.toLowerCase()))){
      if(!node.into.length)selects++;
      return;
    }
    throw invalid('Script CALL requires a body made of read-only SELECT or explicit output assignments.');
  });
  if(!(selects||outputs.size)||selects+(outputs.size?1:0)>8||program.writeTargets.length||
      program.calls.length||program.readTargets.length>8) {
    throw invalid('Use at most eight captured result sets including the output parameters, with no nested calls.');
  }
  for(const target of program.readTargets){
    if(target.schema!==context.database)throw invalid('Script CALL cannot read a table from another schema.');
    const {rows}=await query('SELECT TABLE_TYPE FROM information_schema.TABLES WHERE BINARY TABLE_SCHEMA=BINARY ? AND BINARY TABLE_NAME=BINARY ?',
      [target.schema,target.table]);
    if(rows.length!==1||rows[0][0]!=='BASE TABLE')throw invalid('Script CALL requires readable base tables.');
  }
  return {
    sql:observed.sql,callee:observed.callee,fingerprint:observed.fingerprint,
    parameters:observed.parameters.map(({ordinal,name,mode,kind,type},index)=>({
      ordinal,name,mode,kind,type,...(slots[index]&&{label:slots[index]})
    })),
    resultSets:selects
  };
}

module.exports={reviewScriptCall};
