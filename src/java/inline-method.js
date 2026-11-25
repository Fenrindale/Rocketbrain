'use strict';

const {singleEdit} = require('./extract-value');

const SIMPLE_TYPES = new Set(['boolean','byte','short','char','int','long','float','double','java.lang.String']);

function buildInlineDraft(before,proof) {
  if (proof?.error) throw Error(proof.error);
  const {call,statement,body,arguments:args,references,usedNames,type} = proof || {};
  const valid = range => Number.isSafeInteger(range?.start) && Number.isSafeInteger(range?.end) &&
    range.start>=0 && range.end>range.start && range.end<=before.length;
  if (![call,statement,body].every(valid) || call.start<statement.start || call.end>statement.end ||
      !SIMPLE_TYPES.has(type) || !Array.isArray(args) || !Array.isArray(references) || !Array.isArray(usedNames)) {
    throw Error('Javac did not provide an exact inline call and expression.');
  }
  if (call.end-call.start>16384 || body.end-body.start>8192) throw Error('The selected call or return expression exceeds the inline review limit.');
  const names = new Set(usedNames);
  const temporaryNames = [];
  let ordinal = 1, previous = call.start;
  for (const arg of args) {
    if (!SIMPLE_TYPES.has(arg.type) || !valid(arg.range) || arg.range.start<previous || arg.range.end>call.end) {
      throw Error('Javac did not provide ordered Java argument spans.');
    }
    previous = arg.range.end;
    while (names.has('rbInlineArgument'+ordinal)) ordinal++;
    const name = 'rbInlineArgument'+ordinal++;
    names.add(name);
    temporaryNames.push(name);
  }
  const chunks = [];
  let cursor = body.start;
  for (const ref of [...references].sort((a,b)=>a.start-b.start)) {
    if (!valid(ref) || ref.start<cursor || ref.end>body.end || !temporaryNames[ref.index]) throw Error('An inline parameter lies outside its attributed expression.');
    chunks.push(before.slice(cursor,ref.start),temporaryNames[ref.index]);
    cursor = ref.end;
  }
  const expression = chunks.join('')+before.slice(cursor,body.end);
  const replacement = '('+type+')('+expression+')';
  const eol = before.includes('\r\n')?'\r\n':'\n';
  const lineStart = before.lastIndexOf('\n',statement.start-1)+1;
  const prefix = before.slice(lineStart,statement.start), leading = /^[ \t]*/.exec(prefix)[0];
  const indentation = leading+(leading.length===prefix.length?'':'    ');
  const declaration = args.map(({type:argType,range},index)=>
    argType+' '+temporaryNames[index]+' = '+before.slice(range.start,range.end)+';'+eol+indentation).join('');
  const after = before.slice(0,statement.start)+declaration+before.slice(statement.start,call.start)+replacement+before.slice(call.end);
  const start = call.start+declaration.length;
  return {after,start,end:start+replacement.length,temporaries:temporaryNames,edit:singleEdit(before,after)};
}

function verifyInlineDraft(proof,draft,verified) {
  if (verified?.error) throw Error(verified.error);
  if (!verified || ['type','siteType','caller'].some(name=>verified[name]!==proof[name]) ||
      JSON.stringify(verified.references)!==JSON.stringify(proof.references.map(item=>item.index)) ||
      verified.arguments?.length!==proof.arguments.length || verified.arguments.some((arg,index)=>{
        const original=proof.arguments[index];
        return arg.name!==draft.temporaries[index] || arg.type!==original.type ||
          JSON.stringify(arg.expression)!==JSON.stringify(original.expression);
      })) {
    throw Error('The proposed inline edit changed a Java argument binding or return conversion.');
  }
}

module.exports={buildInlineDraft,verifyInlineDraft};
