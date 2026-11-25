'use strict';

const { validIdentifier } = require('./file-templates');

const kinds = new Set(['PARAMETER','LOCAL_VARIABLE','EXCEPTION_PARAMETER']);

function completionHole(text,offset) {
  if (typeof text!=='string'||!Number.isSafeInteger(offset)||offset<0||offset>text.length||
      /(?:^|[^\\])(?:\\\\)*\\u+[0-9a-f]{4}/iu.test(text)) throw Error('Choose an unambiguous Java expression without raw Unicode escapes.');
  const left = /[$\p{ID_Continue}]*$/u.exec(text.slice(Math.max(0,offset-130),offset))[0];
  const right = /^[$\p{ID_Continue}]*/u.exec(text.slice(offset,offset+130))[0];
  const start = offset-left.length, end = offset+right.length;
  if (end-start>128 || end>start&&!validIdentifier(left+right) || /[.:]\s*$/u.test(text.slice(Math.max(0,start-256),start))) {
    throw Error('Place the cursor on a standalone unfinished Java value.');
  }
  return { start,end,prefix:left };
}

function substitute(text,range,name) {
  return text.slice(0,range.start)+name+text.slice(range.end);
}

function readCompletion(proof,hole) {
  if (proof?.error) throw Error(proof.error);
  if (typeof proof?.expectedType!=='string'||!['initializer','return','lambda'].includes(proof.context)||
      typeof proof.call!=='string'||!Array.isArray(proof.candidates)||proof.candidates.length>160) {
    throw Error('The Java compiler did not identify a bounded completion context.');
  }
  const seen = new Set();
  const candidates=proof.candidates.filter(item=>{
    if (!validIdentifier(item?.name)||typeof item.type!=='string'||!kinds.has(item.kind)||
        !Number.isSafeInteger(item.declarationStart)||item.declarationStart<0||item.declarationStart>=hole.start||seen.has(item.name)) {
      throw Error('The Java compiler returned an invalid type-compatible binding.');
    }
    seen.add(item.name);
    return item.name.startsWith(hole.prefix);
  });
  candidates.sort((left,right)=>Number(right.type===proof.expectedType)-Number(left.type===proof.expectedType)||left.name.localeCompare(right.name));
  return {expectedType:proof.expectedType,context:proof.context,call:proof.call,candidates};
}

function verifyCompletion(before,candidate,after) {
  if (after?.error) throw Error(after.error);
  if (!after||!['expectedType','context','call'].every(key=>after[key]===before[key])||
      !['name','type','kind','declarationStart'].every(key=>after.selected?.[key]===candidate[key])) {
    throw Error('The selected Java value changed its declaration, target type or enclosing overload.');
  }
}

module.exports = { completionHole,substitute,readCompletion,verifyCompletion };
