'use strict';

const { rangeAt } = require('../spring/java');
const { editedText } = require('./refactoring');

const kinds=Object.freeze({
  'unused-type-import':'unused type import',
  'empty-block-statement':'empty block statement',
  'redundant-parentheses':'redundant parenthesis pair'
});

function part(source,edit) {
  if(!Number.isSafeInteger(edit?.start)||!Number.isSafeInteger(edit.end)||edit.start<0||edit.start>=edit.end||edit.end>source.length){
    throw Error('The compiler returned a cleanup edit outside the reviewed Java source.');
  }
  return source.slice(edit.start,edit.end);
}

function cleanupDraft(source,proof) {
  if(proof?.lexical===false)throw Error('Java cleanup requires source without raw Unicode escapes.');
  if(!proof?.lexical||!/^[a-f0-9]{64}$/.test(proof.fingerprint)||!Array.isArray(proof.findings)||proof.findings.length>2000){
    throw Error('The Java compiler did not return a bounded cleanup report.');
  }
  const counts={}, drafts=[];
  for(const finding of proof.findings) {
    const {kind,edits}=finding;
    if(!Object.hasOwn(kinds,kind)||!Array.isArray(edits))throw Error('The Java compiler returned an unknown cleanup recipe.');
    const originals=edits.map(edit=>part(source,edit));
    const valid=kind==='redundant-parentheses' ? edits.length===2&&originals[0]==='('&&originals[1]===')'&&edits[0].end<edits[1].start&&
      ['',' '].includes(edits[0].newText)&&edits[1].newText==='' : edits.length===1&&edits[0].newText===''&&
      (kind==='empty-block-statement'?originals[0]===';':/^\s*import\s+[^;\r\n]+;\s*$/u.test(originals[0])&&!/\/\*|\/\//u.test(originals[0]));
    if(!valid)throw Error('The Java compiler returned an invalid cleanup recipe.');
    counts[kind]=(counts[kind]||0)+1;
    drafts.push(...edits);
  }
  drafts.sort((a,b)=>a.start-b.start);
  const edits=drafts.map((edit,index)=>{
    if(index&&edit.start<drafts[index-1].end)throw Error('The Java compiler returned overlapping cleanup edits.');
    return {range:rangeAt(source,edit.start,edit.end),newText:edit.newText};
  });
  return {edits,text:editedText(source,edits),counts,
    summary:Object.entries(counts).map(([kind,count])=>count+' '+kinds[kind]+(count===1?'':'s')).join(' · ')};
}

function verifyCleanup(before,after) {
  if(!after?.lexical||before.fingerprint!==after.fingerprint) {
    throw Error('The Java cleanup would change attributed syntax or bindings. The source was left unchanged.');
  }
}

module.exports={cleanupDraft,verifyCleanup};
