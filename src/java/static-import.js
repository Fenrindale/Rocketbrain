'use strict';

const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { lexJava } = require('../spring/java');
const { editedText } = require('./refactoring');
const { qualified, typeImportSelection } = require('./type-import');

// The pinned JDT reports an undefined method or unresolved unqualified name.
const problems = new Set(['67108964', '33554515', '570425394', '33554502']);
const unresolved = new Set(['compiler.err.cant.resolve', 'compiler.err.cant.resolve.location',
  'compiler.err.cant.resolve.args', 'compiler.err.cant.resolve.location.args']);

function staticImportSelection(text, start, end) {
  const selection = typeImportSelection(text, start, end);
  const { tokens } = lexJava(text);
  const index = tokens.findIndex(token => token.start === selection.start);
  if (tokens[index - 1]?.text === '.') throw Error('Select an unqualified unresolved Java static member.');
  return selection;
}

function staticImports(text) {
  const { tokens, issues } = lexJava(text);
  if (issues.length) return [];
  const found = [];
  let index = 0;
  while (['package', 'import'].includes(tokens[index]?.text)) {
    const start = index++;
    while (index < tokens.length && tokens[index].text !== ';') index++;
    if (tokens[start].text === 'import' && tokens[start + 1]?.text === 'static' && tokens[index]?.text === ';') {
      found.push(tokens.slice(start + 2, index).map(token => token.text).join(''));
    }
    index++;
  }
  return found;
}

function isSameFile(target, uri) {
  try {
    const value = new URL(target);
    return value.protocol === 'file:' && !value.host && !value.search && !value.hash &&
      path.relative(fileURLToPath(value), fileURLToPath(uri)) === '';
  } catch { return false; }
}

function actionEdits(edit, uri) {
  if (!edit || typeof edit !== 'object' || Object.keys(edit.changeAnnotations || {}).length ||
      (edit.changes !== undefined && (!edit.changes || typeof edit.changes !== 'object' || Array.isArray(edit.changes))) ||
      (edit.documentChanges !== undefined && !Array.isArray(edit.documentChanges))) return null;
  const files = Object.entries(edit.changes || {}).map(([target, edits]) => ({ target, edits }));
  for (const change of edit.documentChanges || []) {
    if (!change?.textDocument?.uri || change.kind) return null;
    files.push({ target: change.textDocument.uri, edits: change.edits });
  }
  if (!files.length || files.some(file => !isSameFile(file.target, uri) || !Array.isArray(file.edits) ||
      file.edits.some(edit => !edit || typeof edit.newText !== 'string' || edit.annotationId))) return null;
  const edits = files.flatMap(file => file.edits);
  return edits.length <= 200 ? edits : null;
}

function staticImportCandidates(actions, text, uri, name) {
  const previous = new Set(staticImports(text)), candidates = new Set();
  for (const action of (Array.isArray(actions) ? actions : []).slice(0, 100)) {
    if (action?.disabled || action?.kind !== 'quickfix' || action.command || typeof action.title !== 'string') continue;
    const label = /^Add static import for ['‘]([^'’]+)['’]$/.exec(action.title)?.[1];
    if (!qualified(label) || label.split('.').at(-1) !== name) continue;
    const edits = actionEdits(action.edit, uri);
    if (!edits) continue;
    let next;
    try { next = editedText(text, edits); } catch { continue; }
    if (Buffer.byteLength(next) > 2 * 1024 * 1024) continue;
    const added = staticImports(next).filter(value => !previous.has(value));
    if (added.length === 1 && qualified(added[0]) && (added[0] === label || added[0].endsWith('.' + label))) candidates.add(added[0]);
  }
  return [...candidates].sort();
}

function confirmUnresolvedStaticMember(text, selection, uri, errors) {
  const { tokens, issues } = lexJava(text);
  const occurrences = tokens.filter(token => token.kind === 'id' && token.text === selection.name);
  const key = ({ start, end }) => start + ':' + end;
  const observed = new Set(errors.filter(error => error.uri === uri && unresolved.has(error.code)).map(key));
  if (issues.length || !errors.length || observed.size !== errors.length || occurrences.length !== observed.size ||
      !observed.has(key(selection)) || !occurrences.every(token => observed.has(key(token)))) {
    throw Error('Javac could not confirm that only the reviewed unresolved static member uses will change.');
  }
  return occurrences;
}

function verifyStaticImport(proof, fqn, draft) {
  const key = ({ start, end }) => start + ':' + end;
  const expected = new Set(draft.occurrences.map(key));
  if (proof?.target !== fqn || !Array.isArray(proof.bindings) || proof.bindings.length !== expected.size ||
      proof.bindings.some(binding => binding.member !== fqn || !['method', 'field'].includes(binding.kind) ||
        typeof binding.signature !== 'string' || !expected.delete(key(binding))) || expected.size ||
      new Set(proof.bindings.map(binding => binding.kind)).size !== 1) {
    throw Error('Javac could not prove the declaring type and static member at every reviewed occurrence.');
  }
  return { kind: proof.bindings[0].kind, signatures: [...new Set(proof.bindings.map(binding => binding.signature))] };
}

module.exports = { problems, staticImportSelection, staticImportCandidates, confirmUnresolvedStaticMember, verifyStaticImport };
