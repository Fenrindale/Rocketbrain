'use strict';

const { editedText } = require('./refactoring');
const { positionAt } = require('../spring/java');

const ACTIONS = Object.freeze({
  lambda:{title:'Convert to anonymous class creation',result:'anonymous'},
  anonymous:{title:'Convert to lambda expression',result:'lambda'},
  indexed:{title:"Convert to enhanced 'for' loop",result:'enhanced'}
});
const SAME_FUNCTION_FIELDS = ['sam','type','parameters','body','bindings'];
const SAME_LOOP_FIELDS = ['array','arrayType','accumulator','accumulatorType'];

function conversionAt(sites,offset) {
  const candidates = sites.filter(site => Object.hasOwn(ACTIONS,site.kind) && site.cursorStart <= offset && offset < site.end);
  if (candidates.length !== 1) {
    throw Error('Select a nonescaping platform functional-interface initializer or an indexed primitive-array summation loop.');
  }
  return candidates[0];
}

function positionMatches(position,text,offset) {
  const expected = positionAt(text,offset);
  return position?.line === expected.line && position?.character === expected.character;
}

function reviewConversionEdit(action,{text,site,version,belongsToSource}) {
  const edit = action?.edit, documents = edit?.documentChanges;
  if (action?.title !== ACTIONS[site.kind].title || action.kind !== 'refactor' || action.command ||
      !edit || Object.keys(edit.changeAnnotations || {}).length ||
      (documents !== undefined && !Array.isArray(documents))) {
    throw Error('The Java engine did not return the selected source conversion.');
  }
  const changes = Object.entries(edit.changes || {});
  const operations = [...(documents || []),...changes.map(([uri,edits]) => ({textDocument:{uri},edits}))];
  const [operation] = operations;
  if (operations.length !== 1 || !belongsToSource(operation?.textDocument?.uri) || operation.kind ||
      operation.textDocument.version != null && operation.textDocument.version !== version ||
      !Array.isArray(operation.edits) || operation.edits.length !== 1) {
    throw Error('Review a conversion that changes only the selected Java expression or loop.');
  }
  const [replacement] = operation.edits;
  if (!replacement || replacement.annotationId !== undefined || !positionMatches(replacement.range?.start,text,site.start) ||
      !positionMatches(replacement.range?.end,text,site.end) || typeof replacement.newText !== 'string' ||
      !replacement.newText.length || replacement.newText.length > 64 * 1024 ||
      /\/\/|\/\*|\\u+[a-f\d]{4}/i.test(text.slice(site.start,site.end) + replacement.newText)) {
    throw Error('The Java conversion must replace the exact selected syntax and preserve its source comments.');
  }
  return {replacement, text:editedText(text,[replacement])};
}

function verifyConversion(before,sites,newLength) {
  const start = before.start, end = start + newLength;
  const next = sites.find(site => site.start === start && site.end === end && site.kind === ACTIONS[before.kind].result);
  const fields = before.kind === 'indexed' ? SAME_LOOP_FIELDS : SAME_FUNCTION_FIELDS;
  if (!next || fields.some(field => JSON.stringify(next[field]) !== JSON.stringify(before[field]))) {
    throw Error('Javac could not confirm the selected conversion preserves its checked Java behavior.');
  }
  return {from:before.kind,to:next.kind,checkedBindings:next.bindings?.length || fields.length};
}

module.exports = { ACTIONS,conversionAt,reviewConversionEdit,verifyConversion };
