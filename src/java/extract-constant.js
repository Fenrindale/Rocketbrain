'use strict';

const { validIdentifier } = require('./file-templates');
const { editedText } = require('./refactoring');
const { rangeAt } = require('../spring/java');

const KIND = 'refactor.extract.constant';
const declarationPrefix = /^([ \t]*)private[ \t]+static[ \t]+final[ \t]+(boolean|byte|short|char|int|long|float|double|(?:java\.lang\.)?String)[ \t]+$/;
const qualifiedType = type => type === 'String' ? 'java.lang.String' : type;

function constantPlacement(response, { text, selection, version, type, belongsToSource }) {
  const edit = response?.edit;
  const rename = response?.command;
  const mark = Array.isArray(rename?.arguments) ? rename.arguments[0] : undefined;
  if (!edit || Object.keys(edit.changeAnnotations || {}).length || rename?.command !== 'java.action.rename' ||
      rename.arguments.length !== 1 || !belongsToSource(mark?.uri) || !Number.isSafeInteger(mark.offset) ||
      !Number.isSafeInteger(mark.length) || mark.offset <= 0 || mark.length <= 0 || mark.length > 120) {
    throw Error('JDT did not propose a local constant declaration for this expression.');
  }
  const operations = [...(edit.documentChanges || []),...Object.entries(edit.changes || {}).map(([uri,edits]) => ({textDocument:{uri},edits}))];
  const [operation] = operations;
  if (operations.length !== 1 || operation.kind || !belongsToSource(operation.textDocument?.uri) ||
      operation.textDocument.version != null && operation.textDocument.version !== version ||
      !Array.isArray(operation.edits) || !operation.edits.length || operation.edits.length > 100 ||
      operation.edits.some(change => change.annotationId !== undefined)) {
    throw Error('Extract Constant requires one bounded Java source edit from JDT.');
  }
  const proposed = editedText(text,operation.edits);
  const name = proposed.slice(mark.offset,mark.offset + mark.length);
  const insertionOffset = proposed.lastIndexOf('\n',mark.offset - 1) + 1;
  const prefix = declarationPrefix.exec(proposed.slice(insertionOffset,mark.offset));
  if (!validIdentifier(name) || !prefix || qualifiedType(prefix[2]) !== type ||
      !/^[ \t]*=/.test(proposed.slice(mark.offset + mark.length)) || insertionOffset >= selection.start ||
      proposed.slice(0,insertionOffset) !== text.slice(0,insertionOffset)) {
    throw Error('JDT did not identify an unambiguous constant declaration before the selected use.');
  }
  return { suggestedName:name, insertionOffset, indent:prefix[1] };
}

function validateConstantName(name, occupied) {
  if (!validIdentifier(name)) return 'Choose a valid Java constant name.';
  if (occupied.includes(name)) return 'The Java constant name conflicts with an existing symbol in the source or its inherited fields.';
}

function constantChange({ text, selection, placement, proof, name }) {
  const conflict = validateConstantName(name,proof.occupiedNames);
  if (conflict) throw Error(conflict);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const expression = text.slice(selection.start,selection.end);
  const declaration = `${placement.indent}private static final ${proof.type} ${name} = ${expression};${eol}${eol}`;
  const edits = [ { range:rangeAt(text,placement.insertionOffset,placement.insertionOffset),newText:declaration },
    { range:rangeAt(text,selection.start,selection.end),newText:name } ];
  const checkedStart = selection.start + declaration.length;
  return { edits, after:editedText(text,edits), checkedStart, checkedEnd:checkedStart + name.length, declaration, expression };
}

function confirmConstant(proof, inspection, placement, change) {
  if (inspection?.error) throw Error(inspection.error);
  if (!inspection || inspection.owner !== proof.owner || inspection.type !== proof.type ||
      JSON.stringify(inspection.bindings) !== JSON.stringify(proof.bindings) ||
      inspection.declarationStart !== placement.insertionOffset + placement.indent.length ||
      change.after.slice(inspection.initializerStart,inspection.initializerEnd) !== change.expression) {
    throw Error('Javac could not confirm the exact new constant declaration and selected binding.');
  }
}

module.exports = { KIND,constantPlacement,validateConstantName,constantChange,confirmConstant };
