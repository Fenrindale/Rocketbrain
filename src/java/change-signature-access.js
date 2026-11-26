'use strict';

const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { lexJava } = require('../spring/java');

function nestedAccessAnchor(text, range, offset) {
  const start = offset(text, range.start), end = offset(text, range.end);
  if (end < start) throw Error('Select the nested Java method declaration name.');
  const { tokens } = lexJava(text);
  const index = tokens.findIndex((token, index) => token.kind === 'id' && token.start <= start && token.end >= end &&
    tokens[index + 1]?.text === '(');
  const name = tokens[index];
  if (!name) throw Error('Select the nested Java method declaration name.');
  return { method: { name: name.text, start: name.start, end: name.end }, text, advanced: true, accessOnly: true };
}

function bindNestedAccess(anchor, semantic, acceptedType) {
  const member = semantic.family[0], nest = member?.hiddenAccessNest;
  if (!member || !nest || semantic.family.length !== 1 || member.constructor || member.generic || member.varargs ||
      member.modifiers.some(name => ['private', 'public', 'protected', 'abstract', 'native'].includes(name)) ||
      member.annotations.length || member.parameters.some(value => value.annotated || !acceptedType(value.type)) ||
      semantic.methodReferences.length || !semantic.calls.length) {
    throw Error('Access review requires a package-private method in an unannotated private static final nested class.');
  }
  const file = fileURLToPath(member.uri);
  if (semantic.calls.some(call => {
    const owner = call.enclosingKey.split('#')[0];
    return path.relative(file, fileURLToPath(call.uri)) || owner !== nest && !owner.startsWith(nest + '.');
  })) throw Error('Access review requires direct source-known callers inside the same Java nest.');
  return { ...anchor, owner: { fqn: member.owner }, accessMember: member,
    method: { ...anchor.method, parameters: member.parameters.map(value => ({ name: value.name, type: { raw: value.type } })) } };
}

function accessChange(record, input) {
  if (!record.target.accessMember || record.signature.modifier !== '') {
    throw Error('Access review requires a verified package-private method in a closed Java source nest.');
  }
  if (input !== 'private') throw Error('Choose the reviewed change to private access.');
  return { before: 'package', after: 'private', member: record.target.accessMember };
}

function verifyPrivateEdit(record, targets, sources, change, offset) {
  const file = fileURLToPath(record.anchor.uri), start = change.member.start;
  const edits = targets.flatMap(([value, edits]) => {
    if (edits.length && path.relative(file, fileURLToPath(value))) throw Error('The Java engine edited a caller during access review.');
    return edits;
  });
  if (edits.length !== 1 || offset(record.anchor.text, edits[0].range?.start) !== start ||
      offset(record.anchor.text, edits[0].range?.end) !== start || edits[0].newText !== 'private ') {
    throw Error('The Java engine did not produce the reviewed private modifier insertion.');
  }
  const projected = sources.find(source => !path.relative(file, fileURLToPath(source.uri)));
  const expected = record.anchor.text.slice(0, start) + 'private ' + record.anchor.text.slice(start);
  if (projected?.text !== expected) throw Error('The Java engine changed more than the private modifier.');
}

module.exports = { nestedAccessAnchor, bindNestedAccess, accessChange, verifyPrivateEdit };
