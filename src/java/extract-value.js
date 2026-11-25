'use strict';

const { lexJava,rangeAt } = require('../spring/java');
const { validIdentifier } = require('./file-templates');

class NamedSelectionError extends Error {}
const compoundSymbol = /^(?:>>>=|>>>|>>=|<<=|>>|<<|\+\+|--|&&|\|\||->|::|\.\.\.|[<>=!+*/%&|^\-]=)/;

function sourceForm(text) {
  const {tokens,issues} = lexJava(text);
  if (issues.length) throw Error('The extraction contains Java tokens outside the reviewed source scope.');
  const result = [];
  let end = 0;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    const before = text.slice(end,token.start).trim();
    if (before) result.push(before);
    const operator = token.kind === 'symbol' && compoundSymbol.exec(text.slice(token.start,token.start+4))?.[0];
    result.push(operator || token.text);
    end = operator ? token.start+operator.length : token.end;
    if (operator) index += operator.length-1;
  }
  const tail = text.slice(end).trim();
  if (tail) result.push(tail);
  return JSON.stringify(result);
}

function replaceSpans(source,changes) {
  const ordered = [...changes].sort((a,b) => a.start-b.start);
  let end = 0;
  const chunks = [];
  for (const change of ordered) {
    if (!Number.isSafeInteger(change.start) || !Number.isSafeInteger(change.end) ||
        change.start < end || change.end <= change.start || change.end > source.length) {
      throw Error('Extraction spans overlap or leave the current Java source.');
    }
    chunks.push(source.slice(end,change.start),change.text);
    end = change.end;
  }
  return chunks.join('') + source.slice(end);
}

function reviewDraft({before,selection,linked,proof,kind}) {
  if (proof?.unsupportedSelection) throw new NamedSelectionError(proof.error);
  if (proof?.error) throw Error(proof.error);
  if (!proof || proof.kind !== kind || proof.name !== linked.name || !Array.isArray(proof.names) ||
      !proof.names.some(span => span.start === linked.offset) || !Array.isArray(proof.occupiedNames)) {
    throw Error('Javac did not resolve the introduced Java declaration and usages.');
  }
  const {proposed} = linked, expression = before.slice(selection.start,selection.end);
  const value = proposed.slice(proof.initializer.start,proof.initializer.end);
  if (sourceForm(value) !== sourceForm(expression)) throw Error('JDT did not preserve the selected expression in the initializer.');
  const removed = [proof.declaration,...(proof.assignment ? [proof.assignment] : [])];
  const changes = [...removed.map(span => ({...span,text:''})),{...proof.read,text:expression}];
  const restored = replaceSpans(proposed,changes);
  const originalStart = proof.read.start - removed.filter(span => span.start < proof.read.start)
    .reduce((length,span) => length+span.end-span.start,0);
  if (sourceForm(restored) !== sourceForm(before) || sourceForm(restored.slice(0,originalStart)) !== sourceForm(before.slice(0,selection.start))) {
    throw Error('JDT proposed an edit outside the selected occurrence or changed unrelated source.');
  }
}

function alignDraftLineEndings(draft,before) {
  const eol = before.includes('\r\n') ? '\r\n' : '\n';
  const normalize = text => text.replace(/\r?\n/g,eol);
  return {...draft,proposed:normalize(draft.proposed),offset:normalize(draft.proposed.slice(0,draft.offset)).length};
}

function validateName(name,proof) {
  if (!validIdentifier(name)) return 'Choose a valid Java name.';
  if (name !== proof.name && proof.occupiedNames.includes(name)) return 'The Java name conflicts with an existing source or inherited symbol.';
}

function namedDraft(linked,proof,name) {
  const conflict = validateName(name,proof);
  if (conflict) throw Error(conflict);
  if (name === linked.name) return {text:linked.proposed,offset:linked.offset,names:proof.names};
  let shift = 0, offset;
  const names = proof.names.map(span => {
    if (linked.proposed.slice(span.start,span.end) !== linked.name) throw Error('The reviewed Java name span changed.');
    const start = span.start+shift;
    if (span.start === linked.offset) offset = start;
    shift += name.length-(span.end-span.start);
    return {start,end:start+name.length,role:span.role};
  });
  return {text:replaceSpans(linked.proposed,proof.names.map(span => ({...span,text:name}))),offset,names};
}

function verifyNamedDraft(proof,checked,named,name) {
  if (checked?.error) throw Error(checked.error);
  if (!checked || checked.name !== name || ['kind','type','owner','method','staticField'].some(key => checked[key] !== proof[key]) ||
      JSON.stringify(checked.names) !== JSON.stringify(named.names)) {
    throw Error('The renamed declaration and its uses did not retain their reviewed Java binding.');
  }
}

function singleEdit(before,after) {
  let start = 0, end = before.length, next = after.length;
  while (start < end && start < next && before[start] === after[start]) start++;
  while (end > start && next > start && before[end-1] === after[next-1]) { end--; next--; }
  return {range:rangeAt(before,start,end),newText:after.slice(start,next)};
}

module.exports = { NamedSelectionError,alignDraftLineEndings,reviewDraft,validateName,namedDraft,verifyNamedDraft,singleEdit };
